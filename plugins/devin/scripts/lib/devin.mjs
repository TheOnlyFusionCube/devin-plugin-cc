import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { binaryAvailable, formatCommandFailure, runCommand } from "./process.mjs";

export const BINARY_ENV = "DEVIN_COMPANION_DEVIN_BINARY";
// Devin Desktop ships the CLI inside its app bundle without putting it on PATH.
export const DESKTOP_BINARY_CANDIDATE =
  "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin";
// Test-only: replaces the app-bundle path (and skips the darwin check) so tests can simulate Devin Desktop.
export const DESKTOP_CANDIDATE_ENV = "DEVIN_COMPANION_DESKTOP_BINARY_CANDIDATE";
export const BINARY_SOURCE_LABELS = {
  env: BINARY_ENV,
  path: "PATH",
  desktop: "Devin Desktop app bundle"
};
export const SESSION_ID_ENV = "DEVIN_COMPANION_SESSION_ID";
export const DEFAULT_MODEL = "swe-2-max";
export const SANDBOX_DOCS_URL = "https://docs.devin.ai/cli/sandbox";

const SANDBOX_FAILURE_PATTERN = /sandbox|seatbelt|bubblewrap|bwrap|socat|seccomp/i;

const VALID_PERMISSION_MODES = new Set([
  "normal",
  "accept-edits",
  "smart",
  "dangerous",
  "bypass",
  "yolo",
  "autonomous"
]);

function defaultIsExecutable(file) {
  try {
    if (!fs.statSync(file).isFile()) {
      return false;
    }
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// Order: explicit env override, `devin` on PATH, then the Devin Desktop app bundle (macOS only).
// Returns { path, source } or null when no devin CLI can be found.
export function resolveDevinBinary({
  env = process.env,
  platform = process.platform,
  candidates = [DESKTOP_BINARY_CANDIDATE],
  isExecutable = defaultIsExecutable,
  realpath = fs.realpathSync
} = {}) {
  if (env[BINARY_ENV]) {
    // Use exactly what the user chose; a bad value surfaces as a failed probe, never a silent fallback.
    return { path: env[BINARY_ENV], source: "env" };
  }

  if (platform === "win32") {
    // Windows commands run through a shell that does its own PATH and PATHEXT lookup.
    return { path: "devin", source: "path" };
  }

  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const found = path.join(dir, "devin");
    if (isExecutable(found)) {
      return { path: found, source: "path" };
    }
  }

  const testCandidate = env[DESKTOP_CANDIDATE_ENV];
  const fallbacks = testCandidate ? [testCandidate] : platform === "darwin" ? candidates : [];
  for (const candidate of fallbacks) {
    try {
      const resolved = realpath(candidate);
      if (isExecutable(resolved)) {
        return { path: resolved, source: "desktop" };
      }
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return null;
}

let resolvedBinary;

// Resolved once per process so setup, auth, session listing, and print runs all use the same binary.
export function getResolvedDevinBinary() {
  if (resolvedBinary === undefined) {
    resolvedBinary = resolveDevinBinary();
  }
  return resolvedBinary;
}

// The command to spawn. Falls back to a bare "devin" so a missing CLI fails with the usual ENOENT.
export function getDevinBinary() {
  return getResolvedDevinBinary()?.path ?? "devin";
}

export function getDevinAvailability(cwd) {
  const probe = binaryAvailable(getDevinBinary(), ["version"], { cwd });
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
  const result = runCommand(getDevinBinary(), ["auth", "status"], { cwd });
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
  const loggedIn = /^\s*logged in/im.test(output) && !/\bnot logged in\b/i.test(output);
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
  model = DEFAULT_MODEL,
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

const SANDBOX_PLATFORM_HINTS = {
  win32: "Native Windows does not support Devin's OS-level sandbox. Run the Devin CLI and this plugin inside WSL2.",
  linux: "On Linux the sandbox needs bubblewrap (bwrap) and socat. Install them (for example `sudo apt install bubblewrap socat`) and retry.",
  darwin: "On macOS the sandbox uses Seatbelt and needs no extra install. Check the error above, and that Devin is not already running inside another sandbox."
};

// Returns an actionable message when a failed sandboxed run looks sandbox-related,
// otherwise null. Devin fails closed when its sandbox cannot start, and so does this
// plugin: the caller must not retry without --sandbox.
export function sandboxFailureHint({ platform = process.platform, stderr = "" } = {}) {
  if (!SANDBOX_FAILURE_PATTERN.test(String(stderr ?? ""))) {
    return null;
  }
  return [
    "The sandbox could not start, so the run failed closed. It was not retried without the sandbox.",
    SANDBOX_PLATFORM_HINTS[platform] ?? "Make sure the OS-level sandbox prerequisites for this platform are installed.",
    `See ${SANDBOX_DOCS_URL}`
  ].join("\n");
}

export function listDevinSessions(cwd) {
  const result = runCommand(getDevinBinary(), ["list", "--format", "json"], { cwd });
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
    const child = spawn(getDevinBinary(), args, {
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
  return formatCommandFailure({ command: getDevinBinary(), args: [], status: result.exitStatus, signal: result.signal, stderr: "", stdout: "" });
}
