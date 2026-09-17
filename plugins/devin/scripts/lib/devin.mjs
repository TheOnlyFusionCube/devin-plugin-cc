import { spawn } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

import { binaryAvailable, formatCommandFailure, runCommand } from "./process.mjs";

export const DEVIN_BINARY = process.env.DEVIN_COMPANION_DEVIN_BINARY ?? "devin";
export const SESSION_ID_ENV = "DEVIN_COMPANION_SESSION_ID";

const VALID_PERMISSION_MODES = new Set([
  "normal",
  "accept-edits",
  "smart",
  "dangerous",
  "bypass",
  "yolo",
  "autonomous"
]);

export function getDevinAvailability(cwd) {
  const probe = binaryAvailable(DEVIN_BINARY, ["version"], { cwd });
  if (!probe.available) {
    return {
      available: false,
      authenticated: false,
      detail: `the devin CLI is not available (${probe.detail})`
    };
  }

  const auth = getDevinAuthStatus(cwd);
  return {
    available: true,
    version: probe.detail,
    authenticated: auth.authenticated,
    authDetail: auth.detail,
    detail: auth.authenticated ? probe.detail : `devin is installed but not authenticated (${auth.detail})`
  };
}

export function getDevinAuthStatus(cwd) {
  const result = runCommand(DEVIN_BINARY, ["auth", "status"], { cwd });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return { authenticated: false, detail: "devin binary not found" };
    }
    return { authenticated: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout).trim() || `exit ${result.status}`;
    return { authenticated: false, detail };
  }
  const output = result.stdout;
  const loggedIn = /logged in/i.test(output);
  const email = output.match(/Email:\s*(\S+)/)?.[1] ?? null;
  const tier = output.match(/Tier:\s*(.+)/)?.[1]?.trim() ?? null;
  return {
    authenticated: loggedIn,
    detail: loggedIn ? `logged in${email ? ` as ${email}` : ""}${tier ? ` (${tier})` : ""}` : "not logged in",
    email,
    tier,
    raw: output
  };
}

export function normalizePermissionMode(mode) {
  if (mode == null) {
    return null;
  }
  const normalized = String(mode).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_PERMISSION_MODES.has(normalized)) {
    throw new Error(
      `Unsupported permission mode "${mode}". Use one of: normal, accept-edits, smart, dangerous, autonomous.`
    );
  }
  return normalized;
}

export function buildDevinPrintArgs({
  prompt,
  model = null,
  permissionMode = null,
  resumeSessionId = null,
  continueLast = false,
  sandbox = false,
  promptFile = null
} = {}) {
  const args = ["-p"];
  if (model) {
    args.push("--model", model);
  }
  if (permissionMode) {
    args.push("--permission-mode", permissionMode);
  }
  if (sandbox) {
    args.push("--sandbox");
  }
  if (continueLast) {
    args.push("-c");
  } else if (resumeSessionId) {
    args.push("-r", resumeSessionId);
  }
  args.push("--respect-workspace-trust", "false");
  if (promptFile) {
    args.push("--prompt-file", promptFile);
  } else {
    args.push("--", prompt ?? "");
  }
  return args;
}

export function listDevinSessions(cwd) {
  const result = runCommand(DEVIN_BINARY, ["list", "--format", "json"], { cwd });
  if (result.error || result.status !== 0) {
    return [];
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function findLatestDevinSession(cwd, { createdAfterMs = null } = {}) {
  let canonicalCwd = cwd;
  try {
    canonicalCwd = fs.realpathSync.native(cwd);
  } catch {
    canonicalCwd = cwd;
  }
  const sessions = listDevinSessions(cwd);
  const candidates = sessions
    .filter((session) => {
      const sessionDir = session.working_directory;
      if (!sessionDir) {
        return true;
      }
      return sessionDir === cwd || sessionDir === canonicalCwd;
    })
    .filter((session) => {
      if (createdAfterMs == null) {
        return true;
      }
      const activityMs = Number(session.last_activity_at ?? 0) * 1000;
      return activityMs >= createdAfterMs;
    })
    .sort((left, right) => Number(right.last_activity_at ?? 0) - Number(left.last_activity_at ?? 0));
  return candidates[0] ?? null;
}

export function findTaskResumeCandidate(cwd) {
  const session = findLatestDevinSession(cwd);
  if (!session) {
    return { available: false };
  }
  return {
    available: true,
    sessionId: session.id ?? session.short_id ?? null,
    title: session.title ?? null,
    lastActivityAt: session.last_activity_at ?? null,
    lastActivityAgo: session.last_activity_ago ?? null
  };
}

export function runDevinPrint({ cwd, args, onStderr = null, onSpawn = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(DEVIN_BINARY, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group so kill(-pid) tears down devin and anything it spawns.
      detached: process.platform !== "win32",
      windowsHide: true
    });

    onSpawn?.(child.pid ?? null);

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onStderr?.(text);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
    child.on("close", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ exitStatus: status ?? (signal ? 1 : 0), signal, stdout, stderr, pid: child.pid });
    });
  });
}

export function devinFailureMessage(result) {
  const stderr = (result.stderr ?? "").trim();
  const stdout = (result.stdout ?? "").trim();
  if (stderr) {
    return stderr.split("\n").slice(-3).join("\n");
  }
  if (stdout) {
    return `devin exited ${result.exitStatus} with no error output`;
  }
  return formatCommandFailure({ command: DEVIN_BINARY, args: [], status: result.exitStatus, signal: result.signal, stderr: "", stdout: "" });
}
