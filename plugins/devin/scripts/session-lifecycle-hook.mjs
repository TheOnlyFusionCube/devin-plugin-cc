#!/usr/bin/env node
// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import fs from "node:fs";
import process from "node:process";

import { appendLogLine, isJobActive, nowIso } from "./lib/jobs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import {
  loadState,
  readJobFile,
  resolveJobFile,
  resolveStateFile,
  updateState,
  writeJobFile
} from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "DEVIN_COMPANION_SESSION_ID";
export const TRANSCRIPT_PATH_ENV = "DEVIN_COMPANION_TRANSCRIPT_PATH";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

// A `handoff --wait/--background` job keeps a pid (the local poller) and a cloudSessionId.
// Killing the poller does not stop the remote session, so such a job is never "cancelled".
function isPolledCloudHandoff(job) {
  return job.kind === "handoff" && Boolean(job.cloudSessionId);
}

// Block (briefly) until the process is gone so a poller mid-write cannot land a
// stale state.json rename after the hook's update. Bounded: SessionEnd is time-limited.
function waitForExit(pid, timeoutMs = 1000) {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      return error?.code === "ESRCH";
    }
    Atomics.wait(sleeper, 0, 0, 20);
  }
  return false;
}

function detachHandoffJobFile(workspaceRoot, job, patch) {
  const jobFile = resolveJobFile(workspaceRoot, job.id);
  if (!fs.existsSync(jobFile)) {
    return;
  }
  const stored = readJobFile(jobFile);
  if (stored.status === "running") {
    writeJobFile(workspaceRoot, job.id, { ...stored, ...patch });
  }
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  // Only jobs with a local process to kill: a pid-bearing active job. Handoffs
  // started with neither --wait nor --background have no pid and deliberately
  // outlive the session, so they are never touched here.
  const killable = state.jobs.filter(
    (job) => job.sessionId === sessionId && isJobActive(job) && Number.isFinite(job.pid)
  );
  if (killable.length === 0) {
    return;
  }

  for (const job of killable) {
    try {
      terminateProcessTree(job.pid);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
    if (isPolledCloudHandoff(job)) {
      waitForExit(job.pid);
    }
  }

  const killedIds = new Set(killable.map((job) => job.id));
  const detachedIds = new Set();
  // updateState re-reads state.json after the kills, so nothing a poller wrote in the
  // meantime is lost. No network here: the remote session is neither stopped nor probed.
  updateState(workspaceRoot, (fresh) => {
    const completedAt = nowIso();
    fresh.jobs = fresh.jobs.map((job) => {
      if (!killedIds.has(job.id)) {
        return job;
      }
      if (!isPolledCloudHandoff(job)) {
        return { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt };
      }
      // Skip a poller that finished (or a cancel that landed) before the kill took effect.
      if (job.status !== "running") {
        return job;
      }
      detachedIds.add(job.id);
      return { ...job, status: "detached", phase: "poller stopped at session end", pid: null, updatedAt: completedAt };
    });
  });

  for (const job of killable) {
    if (!detachedIds.has(job.id)) {
      continue;
    }
    try {
      detachHandoffJobFile(workspaceRoot, job, { status: "detached", phase: "poller stopped at session end", pid: null });
      appendLogLine(job.logFile, "Local poller stopped at session end; the cloud session keeps running. Run /devin:status to refresh it or /devin:cancel to stop it.");
    } catch {
      // The state.json entry is authoritative; a missing job file or log is not fatal.
    }
  }
}

function handleSessionStart(input) {
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

function main() {
  const input = readHookInput();
  const eventName = process.argv[2] ?? input.hook_event_name ?? "";

  if (eventName === "SessionStart") {
    handleSessionStart(input);
    return;
  }

  if (eventName === "SessionEnd") {
    handleSessionEnd(input);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
