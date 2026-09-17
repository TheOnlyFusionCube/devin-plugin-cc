#!/usr/bin/env node
// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import {
  createCloudSession,
  getCloudConfig,
  getCloudSession,
  isTerminalCloudStatus,
  pollCloudSession,
  sendCloudMessage
} from "./lib/cloud.mjs";
import {
  buildDevinPrintArgs,
  DEFAULT_MODEL,
  devinFailureMessage,
  findLatestDevinSession,
  findTaskResumeCandidate,
  getDevinAuthStatus,
  getDevinAvailability,
  normalizePermissionMode,
  runDevinPrint
} from "./lib/devin.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import {
  collectReviewContext,
  ensureGitRepository,
  getCurrentBranch,
  resolveReviewTarget
} from "./lib/git.mjs";
import {
  appendLogLine,
  buildJobSnapshot,
  createJobLogFile,
  createJobRecord,
  createProgressReporter,
  elapsedMs,
  isJobActive,
  nowIso,
  resolveJob,
  runTrackedJob,
  sortJobsNewestFirst
} from "./lib/jobs.mjs";
import { binaryAvailable, runCommand, terminateProcessTree } from "./lib/process.mjs";
import { interpolateTemplate, loadPromptTemplate } from "./lib/prompts.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  readJobFile,
  resolveJobFile,
  resolveJobsDir,
  setConfig,
  upsertJob,
  writeJobFile
} from "./lib/state.mjs";
import {
  renderCancelReport,
  renderHandoffCreated,
  renderJobDetail,
  renderSetupReport,
  renderStatusReport,
  renderStoredJobResult
} from "./lib/render.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const STATUS_POLL_INTERVAL_MS = 2000;
const HANDOFF_POLL_INTERVAL_MS = 30000;
const MAX_INLINE_REVIEW_FILES = 20;
const MAX_INLINE_REVIEW_DIFF_BYTES = 512 * 1024;
const SANDBOX_FAILURE_PATTERN = /sandbox|seatbelt|bubblewrap|bwrap|seccomp/i;

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/devin-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/devin-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>]",
      "  node scripts/devin-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [--model <model>] [focus text]",
      "  node scripts/devin-companion.mjs task [--wait|--background] [--write|--read-only] [--resume|--resume-last|--resume-id <id>|--fresh] [--model <model>] [--permission-mode <mode>] [--sandbox] [prompt]",
      "  node scripts/devin-companion.mjs task-resume-candidate [--json]",
      "  node scripts/devin-companion.mjs handoff [--task <text>] [--context <text>] [--tag <tag>] [--wait|--background] [--json]",
      "  node scripts/devin-companion.mjs status [job-id] [--wait] [--timeout-ms <ms>] [--json]",
      "  node scripts/devin-companion.mjs result [job-id] [--json]",
      "  node scripts/devin-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

function outputResult(payload, rendered, asJson) {
  if (asJson) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    process.stdout.write(rendered);
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), config);
}

function requireDevinReady(cwd) {
  const availability = getDevinAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Devin CLI is not available. ${availability.detail}. Run /devin:setup for install guidance.`);
  }
  if (!availability.authenticated) {
    throw new Error(`Devin is installed but not authenticated. Run \`!devin auth login\` then /devin:setup.`);
  }
  return availability;
}

async function cmdSetup(cwd, argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: [],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Pass only one of --enable-review-gate or --disable-review-gate.");
  }
  if (options["enable-review-gate"]) {
    setConfig(cwd, "stopReviewGate", true);
  }
  if (options["disable-review-gate"]) {
    setConfig(cwd, "stopReviewGate", false);
  }

  const binaryProbe = binaryAvailable("devin", ["version"], { cwd });
  const auth = binaryProbe.available ? getDevinAuthStatus(cwd) : { authenticated: false, detail: "devin not installed" };
  const cloud = getCloudConfig();
  const gitProbe = binaryAvailable("git", ["--version"], { cwd });
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  const config = getConfig(cwd);

  const report = {
    ready: binaryProbe.available && auth.authenticated,
    devin: {
      installed: binaryProbe.available,
      version: binaryProbe.available ? binaryProbe.detail : null,
      authenticated: auth.authenticated,
      authDetail: auth.detail ?? null
    },
    cloud: { available: cloud.available, keyKind: cloud.keyKind },
    git: { available: gitProbe.available, detail: gitProbe.detail ?? null },
    node: { version: process.versions.node, ok: nodeMajor >= 18 },
    config
  };

  outputResult(report, renderSetupReport(report), options.json);
}

async function runDevinJob({ cwd, kind, prompt, promptIsFile = false, model = null, permissionMode = null, sandbox = false, continueLast = false, resumeSessionId = null, title = null, meta = {} }) {
  const jobsDir = resolveJobsDir(cwd);
  fs.mkdirSync(jobsDir, { recursive: true });
  const effectiveModel = model ?? DEFAULT_MODEL;
  const job = createJobRecord({
    id: generateJobId("devin"),
    kind,
    workspaceRoot: cwd,
    status: "queued",
    title: title ?? prompt.slice(0, 120).replace(/\s+/g, " ").trim(),
    model: effectiveModel,
    permissionMode,
    summary: title ?? null,
    promptPreview: prompt.slice(0, 500),
    ...meta
  });

  let promptFile = null;
  if (promptIsFile) {
    promptFile = prompt;
  } else {
    promptFile = path.join(jobsDir, `${job.id}.prompt.md`);
    fs.writeFileSync(promptFile, prompt, "utf8");
  }
  const logFile = createJobLogFile(cwd, job.id, `${kind} job ${job.id}`);
  const progress = createProgressReporter({ logFile });

  const execution = await runTrackedJob({ ...job, logFile, promptFile }, async ({ patchJob }) => {
    const startedMs = Date.now();
    const args = buildDevinPrintArgs({
      promptFile,
      model: effectiveModel,
      permissionMode,
      sandbox,
      continueLast,
      resumeSessionId
    });

    progress?.(`Running devin (${permissionMode ?? "default"} mode${sandbox ? ", sandbox" : ""})…`);
    // job.pid is the devin child's pid (a process-group leader), so cancel can kill the tree.
    let result = await runDevinPrint({
      cwd,
      args,
      onSpawn: (pid) => patchJob?.({ pid }),
      onStderr: (text) => progress?.(text.trim().split("\n").slice(-1)[0])
    });

    // Sandbox may be unavailable on this platform; fall back to a plain read-only-ish run.
    if (sandbox && result.exitStatus !== 0 && SANDBOX_FAILURE_PATTERN.test(`${result.stderr}\n${result.stdout}`)) {
      progress?.("Sandbox unavailable — retrying without it.");
      const retryArgs = buildDevinPrintArgs({
        promptFile,
        model: effectiveModel,
        permissionMode: "normal",
        continueLast,
        resumeSessionId
      });
      result = await runDevinPrint({
        cwd,
        args: retryArgs,
        onSpawn: (pid) => patchJob?.({ pid })
      });
    }

    const rawOutput = result.stdout.trim();
    const devinSession = findLatestDevinSession(cwd, { createdAfterMs: startedMs - 60_000 });
    return {
      exitStatus: result.exitStatus,
      payload: {
        rawOutput,
        stderr: result.stderr.trim() || null,
        exitStatus: result.exitStatus
      },
      rendered: rawOutput ? `${rawOutput}\n` : `Devin produced no output (exit ${result.exitStatus}).\n${devinFailureMessage(result)}\n`,
      summary: rawOutput.split("\n").find((line) => line.trim())?.slice(0, 140) ?? null,
      devinSessionId: devinSession?.id ?? devinSession?.short_id ?? null
    };
  }, { logFile });

  return { job, execution };
}

async function cmdReview(cwd, argv, kind) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["base", "scope", "model"],
    booleanOptions: ["wait", "background", "json"],
    stopAtFirstPositional: true
  });
  requireDevinReady(cwd);
  ensureGitRepository(cwd);

  const focus = positionals.join(" ").trim() || null;
  const target = resolveReviewTarget(cwd, { base: options.base ?? null, scope: options.scope ?? "auto" });
  const context = collectReviewContext(cwd, target, {
    maxInlineFiles: MAX_INLINE_REVIEW_FILES,
    maxInlineDiffBytes: MAX_INLINE_REVIEW_DIFF_BYTES
  });

  const templateName = kind === "adversarial-review" ? "adversarial-review" : "review";
  const prompt = interpolateTemplate(loadPromptTemplate(ROOT_DIR, templateName), {
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focus ?? "(none provided — review the whole change)",
    REVIEW_INPUT: context.content,
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance
  });

  const { job, execution } = await runDevinJob({
    cwd,
    kind,
    prompt,
    model: options.model ?? null,
    permissionMode: "autonomous",
    sandbox: true,
    title: `${kind === "adversarial-review" ? "Adversarial review" : "Review"} of ${context.target.label}`,
    meta: { reviewTarget: context.target.label, fileCount: context.fileCount }
  });

  const payload = {
    jobId: job.id,
    status: execution.exitStatus === 0 ? "completed" : "failed",
    devinSessionId: execution.devinSessionId,
    rawOutput: execution.payload.rawOutput,
    rendered: execution.rendered
  };
  outputResult(payload, execution.rendered, options.json);
}

async function cmdTask(cwd, argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "resume-id", "permission-mode"],
    booleanOptions: ["wait", "background", "write", "read-only", "resume", "resume-last", "fresh", "sandbox", "json"],
    stopAtFirstPositional: true
  });
  requireDevinReady(cwd);

  const stdin = readStdinIfPiped();
  const taskText = [positionals.join(" ").trim(), stdin.trim()].filter(Boolean).join("\n\n");
  if (!taskText) {
    throw new Error("Nothing to delegate. Pass a task description, e.g. /devin:rescue investigate the failing tests.");
  }

  const resumeSessionId = options["resume-id"] ?? null;
  const continueLast = Boolean(options.resume || options["resume-last"]) && !options.fresh && !resumeSessionId;
  const sandbox = Boolean(options.sandbox);
  const permissionMode =
    normalizePermissionMode(options["permission-mode"]) ??
    (sandbox ? "autonomous" : options["read-only"] ? "normal" : "accept-edits");

  const { job, execution } = await runDevinJob({
    cwd,
    kind: "task",
    prompt: taskText,
    model: options.model ?? null,
    permissionMode,
    sandbox,
    continueLast,
    resumeSessionId,
    title: taskText.split("\n")[0].slice(0, 120),
    meta: { write: permissionMode !== "normal", resumed: continueLast || Boolean(resumeSessionId) }
  });

  const payload = {
    jobId: job.id,
    status: execution.exitStatus === 0 ? "completed" : "failed",
    devinSessionId: execution.devinSessionId,
    rawOutput: execution.payload.rawOutput,
    rendered: execution.rendered
  };
  outputResult(payload, execution.rendered, options.json);
}

async function cmdResumeCandidate(cwd, argv) {
  const { options } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const candidate = findTaskResumeCandidate(cwd);
  const rendered = candidate.available
    ? `Resumable Devin session: ${candidate.sessionId} — "${candidate.title ?? "untitled"}" (last activity ${candidate.lastActivityAgo ?? "recently"})\n`
    : "No resumable Devin session found for this directory.\n";
  outputResult(candidate, rendered, options.json);
}

function getGitHandoffContext(cwd) {
  const slug = (() => {
    const remote = runCommand("git", ["remote", "get-url", "origin"], { cwd });
    if (remote.status !== 0) {
      return null;
    }
    return remote.stdout.trim().replace(/^(ssh:\/\/|git@[^:/]+[:/]|https?:\/\/[^/]+\/)/, "").replace(/\.git$/, "") || null;
  })();
  const branch = (() => {
    try {
      return getCurrentBranch(cwd);
    } catch {
      return null;
    }
  })();
  const diffResult = runCommand("git", ["diff", "HEAD"], { cwd, maxBuffer: 2 * 1024 * 1024 });
  const diff = diffResult.status === 0 ? diffResult.stdout : null;
  return { repo: slug, branch, diff: diff?.trim() ? diff : null };
}

async function cmdHandoff(cwd, argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["task", "context", "tag", "poll-interval-ms"],
    booleanOptions: ["wait", "background", "json"],
    stopAtFirstPositional: true
  });

  const task = (options.task ?? positionals.join(" ")).trim();
  if (!task) {
    throw new Error("Nothing to hand off. Pass a task, e.g. /devin:handoff fix the flaky CI test.");
  }

  const config = getCloudConfig();
  if (!config.available) {
    throw new Error("DEVIN_API_KEY is not set. Get a key at https://app.devin.ai/settings/api-keys — /devin:handoff needs it.");
  }

  const gitContext = getGitHandoffContext(cwd);
  const wantsWait = Boolean(options.wait || options.background);
  const pollMs = Number(options["poll-interval-ms"]) || HANDOFF_POLL_INTERVAL_MS;

  const job = createJobRecord({
    id: generateJobId("devin"),
    kind: "handoff",
    workspaceRoot: cwd,
    status: "running",
    startedAt: nowIso(),
    title: task.slice(0, 120),
    summary: task.slice(0, 140)
  });
  const logFile = createJobLogFile(cwd, job.id, `handoff job ${job.id}`);
  writeJobFile(cwd, job.id, { ...job, logFile, phase: "creating", pid: process.pid });
  upsertJob(cwd, { ...job, logFile, phase: "creating", pid: process.pid });

  let created;
  try {
    created = await createCloudSession({
      task,
      context: options.context ?? null,
      tag: options.tag ?? null,
      ...gitContext,
      config
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeJobFile(cwd, job.id, { ...job, logFile, status: "failed", phase: "failed", errorMessage, pid: null, completedAt: nowIso() });
    upsertJob(cwd, { id: job.id, status: "failed", phase: "failed", errorMessage, pid: null, completedAt: nowIso() });
    throw error;
  }
  const { sessionId, url } = created;

  // --wait keeps a pid so cancel can kill the poller; detached has none so it
  // outlives the session without being swept by cleanup.
  const base = {
    ...job,
    cloudSessionId: sessionId,
    sessionUrl: url,
    phase: wantsWait ? "running-cloud" : "detached",
    pid: wantsWait ? process.pid : null
  };
  writeJobFile(cwd, job.id, { ...base, logFile });
  upsertJob(cwd, { ...base, logFile, status: wantsWait ? "running" : "detached" });
  appendLogLine(logFile, `Cloud session created: ${url}`);

  const runningJob = { ...base, status: wantsWait ? "running" : "detached", logFile };

  if (!wantsWait) {
    outputResult(
      { jobId: job.id, status: "detached", sessionId, url },
      renderHandoffCreated({ job: runningJob }),
      options.json
    );
    return;
  }

  appendLogLine(logFile, `Polling every ${Math.round(pollMs / 1000)}s until terminal…`);
  let final;
  try {
    final = await pollCloudSession(sessionId, {
      intervalMs: pollMs,
      config,
      onUpdate: (snapshot) => {
        appendLogLine(logFile, `status=${snapshot.status}${snapshot.statusDetail ? ` detail=${snapshot.statusDetail}` : ""}`);
        upsertJob(cwd, { id: job.id, phase: snapshot.statusDetail ?? snapshot.status, pullRequestUrl: snapshot.pullRequestUrl });
      }
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    writeJobFile(cwd, job.id, { ...runningJob, status: "failed", phase: "failed", errorMessage, pid: null, completedAt: nowIso() });
    upsertJob(cwd, { id: job.id, status: "failed", phase: "failed", errorMessage, pid: null, completedAt: nowIso() });
    throw error;
  }

  const completedAt = nowIso();
  const status = final.ok ? "completed" : "failed";
  const rendered = [
    `Cloud Devin session finished: ${final.status}${final.statusDetail ? ` (${final.statusDetail})` : ""}`,
    final.title ? `Title: ${final.title}` : null,
    final.pullRequestUrl ? `PR: ${final.pullRequestUrl}` : null,
    `URL: ${final.url ?? url}`
  ].filter(Boolean).join("\n") + "\n";

  writeJobFile(cwd, job.id, {
    ...runningJob,
    status,
    phase: final.statusDetail ?? final.status,
    pid: null,
    completedAt,
    pullRequestUrl: final.pullRequestUrl,
    result: final,
    rendered
  });
  upsertJob(cwd, { id: job.id, status, phase: final.statusDetail ?? final.status, pid: null, completedAt, pullRequestUrl: final.pullRequestUrl });

  outputResult({ jobId: job.id, status, sessionId, url, final }, rendered, options.json);
}

async function refreshCloudJob(cwd, job) {
  if (job?.kind !== "handoff" || !job.cloudSessionId) {
    return job;
  }
  const config = getCloudConfig();
  if (!config.available || !isJobActive(job)) {
    return job;
  }
  try {
    const snapshot = await getCloudSession(job.cloudSessionId, config);
    const verdict = isTerminalCloudStatus(snapshot);
    const patch = {
      id: job.id,
      phase: snapshot.statusDetail ?? snapshot.status,
      pullRequestUrl: snapshot.pullRequestUrl,
      sessionUrl: snapshot.url ?? job.sessionUrl
    };
    if (verdict.terminal) {
      patch.status = verdict.ok ? "completed" : "failed";
      patch.completedAt = nowIso();
    }
    upsertJob(cwd, patch);
    const jobFile = resolveJobFile(cwd, job.id);
    if (fs.existsSync(jobFile)) {
      writeJobFile(cwd, job.id, { ...readJobFile(jobFile), ...patch });
    }
    return { ...job, ...patch };
  } catch {
    return job;
  }
}

function detectDeadJob(cwd, job) {
  if (job?.status !== "running" || !job.pid) {
    return job;
  }
  try {
    process.kill(job.pid, 0);
    return job;
  } catch (error) {
    if (error?.code === "ESRCH") {
      const patch = { id: job.id, status: "failed", phase: "failed", pid: null, errorMessage: "Job process exited unexpectedly.", completedAt: nowIso() };
      upsertJob(cwd, patch);
      return { ...job, ...patch };
    }
    return job;
  }
}

async function cmdStatus(cwd, argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["timeout-ms"],
    booleanOptions: ["wait", "json", "all"]
  });
  const jobId = positionals[0] ?? null;

  const deadline = options.wait ? Date.now() + (Number(options["timeout-ms"]) || DEFAULT_STATUS_WAIT_TIMEOUT_MS) : null;

  for (;;) {
    let jobs = sortJobsNewestFirst(listJobs(cwd)).map((job) => detectDeadJob(cwd, job));
    for (let index = 0; index < jobs.length; index += 1) {
      jobs[index] = await refreshCloudJob(cwd, jobs[index]);
    }

    if (jobId) {
      const job = resolveJob(jobs, jobId);
      if (deadline && isJobActive(job) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
        continue;
      }
      const snapshot = buildJobSnapshot(job);
      outputResult(snapshot, renderJobDetail(job), options.json);
      return;
    }

    if (deadline) {
      const anyActive = jobs.some((job) => isJobActive(job));
      if (anyActive && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_INTERVAL_MS));
        continue;
      }
    }

    const snapshots = jobs.map((job) => buildJobSnapshot(job));
    const rendered = jobs.length === 0 ? "No Devin jobs recorded for this repository yet.\n" : renderStatusReport(jobs);
    outputResult({ jobs: snapshots }, rendered, options.json);
    return;
  }
}

function loadFullJobRecord(cwd, job) {
  if (!job) {
    return job;
  }
  const jobFile = resolveJobFile(cwd, job.id);
  if (!fs.existsSync(jobFile)) {
    return job;
  }
  try {
    return { ...readJobFile(jobFile), id: job.id };
  } catch {
    return job;
  }
}

async function cmdResult(cwd, argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const jobId = positionals[0] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(cwd));

  let job = resolveJob(jobs, jobId);
  job = loadFullJobRecord(cwd, job);
  job = await refreshCloudJob(cwd, job);
  if (!jobId && job?.status !== "completed" && job?.status !== "failed") {
    const finished = jobs.find((entry) => entry.status === "completed" || entry.status === "failed");
    if (finished) {
      job = loadFullJobRecord(cwd, finished);
    }
  }

  if (job.kind === "handoff" && !job.rendered && job.cloudSessionId && getCloudConfig().available) {
    const snapshot = await getCloudSession(job.cloudSessionId).catch(() => null);
    if (snapshot) {
      const rendered = [
        `Cloud Devin session ${job.cloudSessionId}`,
        `status: ${snapshot.status}${snapshot.statusDetail ? ` (${snapshot.statusDetail})` : ""}`,
        snapshot.title ? `title: ${snapshot.title}` : null,
        snapshot.pullRequestUrl ? `PR: ${snapshot.pullRequestUrl}` : null,
        `URL: ${snapshot.url ?? job.sessionUrl}`
      ].filter(Boolean).join("\n") + "\n";
      outputResult({ jobId: job.id, kind: job.kind, cloud: snapshot, rendered }, rendered, options.json);
      return;
    }
  }

  const rendered = renderStoredJobResult(job);
  outputResult({ jobId: job.id, kind: job.kind, status: job.status, rendered, result: job.result ?? null }, rendered, options.json);
}

async function cmdCancel(cwd, argv) {
  const { options, positionals } = parseCommandInput(argv, { booleanOptions: ["json"] });
  const jobId = positionals[0] ?? null;
  const jobs = sortJobsNewestFirst(listJobs(cwd)).map((job) => detectDeadJob(cwd, job));
  const job = resolveJob(jobs, jobId, { activeOnly: true });

  if (!isJobActive(job)) {
    const rendered = `Job ${job.id} is already ${job.status}.\n`;
    outputResult({ jobId: job.id, status: job.status, cancelled: false }, rendered, options.json);
    return;
  }

  // Mark cancelled BEFORE killing: the running companion's close handler
  // re-reads the job file after its child dies and must see "cancelled" so it
  // doesn't overwrite the outcome with "failed".
  const completedAt = nowIso();
  const patch = { id: job.id, status: "cancelled", phase: "cancelled", pid: null, completedAt };
  upsertJob(cwd, patch);
  const jobFile = resolveJobFile(cwd, job.id);
  if (fs.existsSync(jobFile)) {
    writeJobFile(cwd, job.id, { ...readJobFile(jobFile), ...patch });
  }

  let delivered = false;
  if (job.pid) {
    const outcome = terminateProcessTree(job.pid);
    delivered = outcome.delivered;
  }

  if (job.kind === "handoff" && job.cloudSessionId && getCloudConfig().available) {
    await sendCloudMessage(job.cloudSessionId, "Please stop working on this task — it was cancelled by the user.").catch(() => null);
  }

  outputResult(
    { jobId: job.id, status: "cancelled", delivered },
    renderCancelReport({ job, delivered }),
    options.json
  );
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const cwd = resolveWorkspaceRoot(process.cwd());

  switch (command) {
    case "setup":
      await cmdSetup(cwd, argv.slice(1));
      return;
    case "review":
      await cmdReview(cwd, argv.slice(1), "review");
      return;
    case "adversarial-review":
      await cmdReview(cwd, argv.slice(1), "adversarial-review");
      return;
    case "task":
      await cmdTask(cwd, argv.slice(1));
      return;
    case "task-resume-candidate":
      await cmdResumeCandidate(cwd, argv.slice(1));
      return;
    case "handoff":
      await cmdHandoff(cwd, argv.slice(1));
      return;
    case "status":
      await cmdStatus(cwd, argv.slice(1));
      return;
    case "result":
      await cmdResult(cwd, argv.slice(1));
      return;
    case "cancel":
      await cmdCancel(cwd, argv.slice(1));
      return;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n`);
      printUsage();
      process.exitCode = 2;
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
