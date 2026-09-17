// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import fs from "node:fs";
import process from "node:process";

import {
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "DEVIN_COMPANION_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const raw = typeof eventOrMessage === "string" ? eventOrMessage : eventOrMessage?.message;
    const message = String(raw ?? "").trim();
    if (!message) {
      return;
    }
    if (stderr) {
      process.stderr.write(`[devin] ${message}\n`);
    }
    appendLogLine(logFile, message);
    onEvent?.(message);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export async function runTrackedJob(job, runner, options = {}) {
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: process.pid,
    logFile
  };
  writeJobFile(job.workspaceRoot, job.id, runningRecord);
  upsertJob(job.workspaceRoot, runningRecord);

  const patchJob = (patch) => {
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    writeJobFile(job.workspaceRoot, job.id, { ...existing, ...patch });
    upsertJob(job.workspaceRoot, { id: job.id, ...patch });
  };

  try {
    const execution = await runner({ patchJob, logFile });
    // A cancel that raced the child's exit wins: keep "cancelled" over "failed".
    const latest = readStoredJobOrNull(job.workspaceRoot, job.id);
    const completionStatus =
      latest?.status === "cancelled" ? "cancelled" : execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...runningRecord,
      ...(execution.extraRecord ?? {}),
      status: completionStatus,
      devinSessionId: execution.devinSessionId ?? null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      completedAt,
      result: execution.payload,
      rendered: execution.rendered
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: completionStatus,
      devinSessionId: execution.devinSessionId ?? null,
      summary: execution.summary,
      phase: completionStatus === "completed" ? "done" : completionStatus,
      pid: null,
      completedAt
    });
    appendLogBlock(logFile, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = readStoredJobOrNull(job.workspaceRoot, job.id) ?? runningRecord;
    const finalStatus = existing.status === "cancelled" ? "cancelled" : "failed";
    const completedAt = nowIso();
    writeJobFile(job.workspaceRoot, job.id, {
      ...existing,
      status: finalStatus,
      phase: finalStatus === "cancelled" ? "cancelled" : "failed",
      errorMessage,
      pid: null,
      completedAt,
      logFile
    });
    upsertJob(job.workspaceRoot, {
      id: job.id,
      status: finalStatus,
      phase: finalStatus === "cancelled" ? "cancelled" : "failed",
      pid: null,
      errorMessage,
      completedAt
    });
    throw error;
  }
}

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => {
    const leftStamp = Date.parse(left.updatedAt ?? left.createdAt ?? "") || 0;
    const rightStamp = Date.parse(right.updatedAt ?? right.createdAt ?? "") || 0;
    return rightStamp - leftStamp;
  });
}

export function isJobActive(job) {
  return job?.status === "queued" || job?.status === "running" || job?.status === "detached";
}

export function elapsedMs(job) {
  const start = Date.parse(job.startedAt ?? job.createdAt ?? "") || null;
  if (start == null) {
    return null;
  }
  const end = Date.parse(job.completedAt ?? "") || (isJobActive(job) ? Date.now() : null);
  return end == null ? null : Math.max(0, end - start);
}

export function resolveJob(jobs, jobId, { activeOnly = false } = {}) {
  const sorted = sortJobsNewestFirst(jobs);
  if (jobId) {
    const match = sorted.find((job) => job.id === jobId);
    if (!match) {
      throw new Error(`No job found with id "${jobId}". Run /devin:status to list recent jobs.`);
    }
    return match;
  }
  if (activeOnly) {
    const active = sorted.find((job) => isJobActive(job));
    if (active) {
      return active;
    }
  }
  const job = sorted[0];
  if (!job) {
    throw new Error("No jobs recorded for this repository yet.");
  }
  return job;
}

export function buildJobSnapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    phase: job.phase ?? null,
    summary: job.summary ?? null,
    title: job.title ?? null,
    model: job.model ?? null,
    permissionMode: job.permissionMode ?? null,
    devinSessionId: job.devinSessionId ?? null,
    cloudSessionId: job.cloudSessionId ?? null,
    sessionUrl: job.sessionUrl ?? null,
    pullRequestUrl: job.pullRequestUrl ?? null,
    errorMessage: job.errorMessage ?? null,
    createdAt: job.createdAt ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    elapsedMs: elapsedMs(job)
  };
}
