import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeDevin, createTempRepo } from "./fake-devin-fixture.mjs";
import { SANDBOX_DOCS_URL, sandboxFailureHint } from "../plugins/devin/scripts/lib/devin.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/devin/scripts/devin-companion.mjs", import.meta.url));

function runCompanion(args, { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30000
  });
}

function initGitRepo(dir) {
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "hello.txt"), "hello changed\n");
}

function withFailingDevin(stderrText, fn) {
  const repo = createTempRepo();
  const fake = createFakeDevin({ responseText: "", exitCode: 1, stderrText });
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    fn({ repo, fake, env });
  } finally {
    repo.cleanup();
    fake.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function assertRanOnceSandboxed(fake) {
  const runs = fake.printRuns();
  assert.equal(runs.length, 1, `expected exactly one devin run, got: ${runs.join(" | ")}`);
  assert.match(runs[0], /--sandbox/);
}

test("sandboxFailureHint: win32 points to WSL2", () => {
  const hint = sandboxFailureHint({ platform: "win32", stderr: "error: sandbox is not supported on this platform" });
  assert.match(hint, /Windows/);
  assert.match(hint, /WSL2/);
  assert.ok(hint.includes(SANDBOX_DOCS_URL));
});

test("sandboxFailureHint: linux names bubblewrap and socat", () => {
  const hint = sandboxFailureHint({ platform: "linux", stderr: "sandbox requires bwrap and socat" });
  assert.match(hint, /bubblewrap/);
  assert.match(hint, /bwrap/);
  assert.match(hint, /socat/);
  assert.ok(hint.includes(SANDBOX_DOCS_URL));
});

test("sandboxFailureHint: darwin names Seatbelt", () => {
  const hint = sandboxFailureHint({ platform: "darwin", stderr: "sandbox-exec: sandbox_apply: Operation not permitted" });
  assert.match(hint, /Seatbelt/);
  assert.ok(hint.includes(SANDBOX_DOCS_URL));
});

test("sandboxFailureHint: other platforms get a generic hint with the docs link", () => {
  const hint = sandboxFailureHint({ platform: "freebsd", stderr: "sandbox unavailable" });
  assert.ok(hint.includes(SANDBOX_DOCS_URL));
});

test("sandboxFailureHint: non-sandbox errors get no hint", () => {
  assert.equal(sandboxFailureHint({ platform: "linux", stderr: "network timeout talking to api" }), null);
  assert.equal(sandboxFailureHint({ platform: "linux", stderr: "" }), null);
  assert.equal(sandboxFailureHint({ platform: "linux" }), null);
});

test("review with a missing bwrap fails closed: one sandboxed run, failed job, hint shown", () => {
  withFailingDevin("Error: sandbox unavailable: bwrap not found in PATH. Install bubblewrap and socat.", ({ repo, fake, env }) => {
    const result = runCompanion(["review", "--wait"], { cwd: repo.dir, env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /bwrap not found/);
    assert.match(result.stdout, /failed closed/);
    assert.match(result.stdout, /not retried without the sandbox/);
    assert.ok(result.stdout.includes(SANDBOX_DOCS_URL));
    assertRanOnceSandboxed(fake);

    const status = JSON.parse(runCompanion(["status", "--json"], { cwd: repo.dir, env }).stdout);
    assert.equal(status.jobs.length, 1);
    assert.equal(status.jobs[0].status, "failed");
  });
});

test("review with a Seatbelt error fails closed without a second run", () => {
  withFailingDevin("sandbox-exec: sandbox_apply: Operation not permitted", ({ repo, fake, env }) => {
    const result = runCompanion(["review", "--wait", "--json"], { cwd: repo.dir, env });
    assert.equal(result.status, 1);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.status, "failed");
    assert.match(payload.rendered, /Operation not permitted/);
    assert.match(payload.rendered, /failed closed/);
    // With --json the hint also reaches stderr for hooks and wrappers.
    assert.match(result.stderr, /failed closed/);
    assertRanOnceSandboxed(fake);
  });
});

test("task --read-only --sandbox fails closed and never runs without --sandbox", () => {
  withFailingDevin("fatal: seccomp setup failed", ({ repo, fake, env }) => {
    const result = runCompanion(["task", "--read-only", "--sandbox", "look", "around"], { cwd: repo.dir, env });
    assert.equal(result.status, 1);
    assert.match(result.stdout, /failed closed/);
    assertRanOnceSandboxed(fake);
    assert.doesNotMatch(fake.printRuns()[0], /--permission-mode normal/);
  });
});

test("a non-sandbox failure of a sandboxed run gets no sandbox hint and keeps old exit behavior", () => {
  withFailingDevin("error: model quota exceeded", ({ repo, fake, env }) => {
    const result = runCompanion(["review", "--wait"], { cwd: repo.dir, env });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /quota exceeded/);
    assert.doesNotMatch(result.stdout, /failed closed/);
    assert.ok(!result.stdout.includes(SANDBOX_DOCS_URL));
    assertRanOnceSandboxed(fake);
  });
});

test("a sandbox-style failure without --sandbox gets no sandbox hint", () => {
  withFailingDevin("sandbox: something unrelated mentioned", ({ repo, fake, env }) => {
    const result = runCompanion(["task", "do", "it"], { cwd: repo.dir, env });
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /failed closed/);
    assert.equal(fake.printRuns().length, 1);
  });
});

test("stop review gate fails open with a warning when the sandbox is unavailable", () => {
  withFailingDevin("Error: sandbox unavailable: bwrap not found in PATH", ({ repo, fake, env }) => {
    runCompanion(["setup", "--enable-review-gate"], { cwd: repo.dir, env });
    const hook = fileURLToPath(new URL("../plugins/devin/scripts/stop-review-gate-hook.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [hook], {
      cwd: repo.dir,
      encoding: "utf8",
      input: JSON.stringify({ cwd: repo.dir, last_assistant_message: "done" }),
      env: { ...process.env, ...env },
      timeout: 30000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "", "gate must not block");
    assert.match(result.stderr, /failing open/);
    assert.match(result.stderr, /failed closed/);
    assertRanOnceSandboxed(fake);
  });
});
