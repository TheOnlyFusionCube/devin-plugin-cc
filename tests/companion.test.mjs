import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeDevin, createTempRepo } from "./fake-devin-fixture.mjs";

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
}

test("task runs devin -p and records a completed job", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin({ responseText: "ALL_DONE" });
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    const result = runCompanion(["task", "do", "the", "thing"], { cwd: repo.dir, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ALL_DONE/);

    const status = runCompanion(["status", "--json"], { cwd: repo.dir, env });
    const payload = JSON.parse(status.stdout);
    assert.equal(payload.jobs.length, 1);
    assert.equal(payload.jobs[0].kind, "task");
    assert.equal(payload.jobs[0].status, "completed");

    const rendered = runCompanion(["result", payload.jobs[0].id], { cwd: repo.dir, env });
    assert.match(rendered.stdout, /ALL_DONE/);
    // -p used a prompt file, not inline args
    assert.ok(fake.invocations().length >= 1);
    assert.equal(fake.lastPrompt(), "do the thing");
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("task --resume passes -c to devin", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin();
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    const result = runCompanion(["task", "--resume", "keep going"], { cwd: repo.dir, env });
    assert.equal(result.status, 0, result.stderr);
    const argsLine = fs.readFileSync(`${fake.marker}.args`, "utf8");
    assert.match(argsLine, /-c/);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("task --resume-id passes -r <id> to devin", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin();
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    const result = runCompanion(["task", "--resume-id", "brisk-otter", "continue"], { cwd: repo.dir, env });
    assert.equal(result.status, 0, result.stderr);
    const argsLine = fs.readFileSync(`${fake.marker}.args`, "utf8");
    assert.match(argsLine, /-r brisk-otter/);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("task text containing flag-like words passes through verbatim", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin();
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    const result = runCompanion(
      ["task", "--read-only", "explain the --permission-mode dangerous flag"],
      { cwd: repo.dir, env }
    );
    assert.equal(result.status, 0, result.stderr);
    // The flag-like text must reach the prompt untouched…
    assert.equal(fake.lastPrompt(), "explain the --permission-mode dangerous flag");
    // …and must not have been applied as a real option.
    const argsLine = fs.readFileSync(`${fake.marker}.args`, "utf8");
    assert.match(argsLine, /--permission-mode normal/);
    assert.doesNotMatch(argsLine, /dangerous/);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("setup reports ready=false when devin auth fails", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin({ failAuth: true });
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    const result = runCompanion(["setup", "--json"], { cwd: repo.dir, env });
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.devin.installed, true);
    assert.equal(payload.devin.authenticated, false);
    assert.equal(payload.ready, false);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("setup --enable-review-gate persists config", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin();
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    runCompanion(["setup", "--enable-review-gate"], { cwd: repo.dir, env });
    const result = runCompanion(["setup", "--json"], { cwd: repo.dir, env });
    assert.equal(JSON.parse(result.stdout).config.stopReviewGate, true);
    runCompanion(["setup", "--disable-review-gate"], { cwd: repo.dir, env });
    const result2 = runCompanion(["setup", "--json"], { cwd: repo.dir, env });
    assert.equal(JSON.parse(result2.stdout).config.stopReviewGate, false);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("review builds a prompt containing the diff and runs read-only", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin({ responseText: "## Verdict\nAPPROVE" });
  initGitRepo(repo.dir);
  fs.writeFileSync(path.join(repo.dir, "hello.txt"), "hello changed\n");
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    const result = runCompanion(["review", "--wait"], { cwd: repo.dir, env });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /APPROVE/);
    const prompt = fake.lastPrompt();
    assert.match(prompt, /hello\.txt/);
    assert.match(prompt, /review/i);
    const argsLine = fs.readFileSync(`${fake.marker}.args`, "utf8");
    assert.match(argsLine, /--permission-mode autonomous|--permission-mode normal/);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("handoff without DEVIN_API_KEY fails with guidance", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin();
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir, DEVIN_API_KEY: "" };
    const result = runCompanion(["handoff", "fix", "ci"], { cwd: repo.dir, env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEVIN_API_KEY/);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});

test("cancel reports finished for completed jobs", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin();
  initGitRepo(repo.dir);
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { ...fake.env, CLAUDE_PLUGIN_DATA: dataDir };
    runCompanion(["task", "x"], { cwd: repo.dir, env });
    const status = JSON.parse(runCompanion(["status", "--json"], { cwd: repo.dir, env }).stdout);
    const cancel = runCompanion(["cancel", status.jobs[0].id], { cwd: repo.dir, env });
    assert.match(cancel.stdout, /already completed/);
  } finally {
    repo.cleanup();
    fake.cleanup();
  }
});
