#!/usr/bin/env node
// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import fs from "node:fs";
import process from "node:process";

import { isJobActive } from "./lib/jobs.mjs";
import { terminateProcessTree } from "./lib/process.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
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
  // Only local, killable jobs: a pid-bearing active job. Detached cloud handoffs
  // deliberately outlive the session and must not be marked cancelled.
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
  }

  const killedIds = new Set(killable.map((job) => job.id));
  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.map((job) =>
      killedIds.has(job.id) ? { ...job, status: "cancelled", phase: "cancelled", pid: null, completedAt: new Date().toISOString() } : job
    )
  });
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
