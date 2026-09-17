import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createTempRepo } from "./fake-devin-fixture.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  loadState,
  resolveStateDir,
  setConfig,
  upsertJob
} from "../plugins/devin/scripts/lib/state.mjs";

test("state round-trips config and jobs", () => {
  const repo = createTempRepo();
  try {
    process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync("/tmp/devin-plugin-data-");
    setConfig(repo.dir, "stopReviewGate", true);
    upsertJob(repo.dir, { id: "job-1", kind: "task", status: "running", summary: "test" });

    const state = loadState(repo.dir);
    assert.equal(state.config.stopReviewGate, true);
    assert.equal(state.jobs.length, 1);
    assert.equal(state.jobs[0].id, "job-1");
    assert.equal(getConfig(repo.dir).stopReviewGate, true);
  } finally {
    repo.cleanup();
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("upsertJob merges patches on existing jobs", () => {
  const repo = createTempRepo();
  try {
    process.env.CLAUDE_PLUGIN_DATA = fs.mkdtempSync("/tmp/devin-plugin-data-");
    upsertJob(repo.dir, { id: "job-1", status: "running", pid: 123 });
    upsertJob(repo.dir, { id: "job-1", status: "completed", pid: null });
    const jobs = listJobs(repo.dir);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "completed");
    assert.equal(jobs[0].pid, null);
    assert.equal(jobs[0].id, "job-1");
  } finally {
    repo.cleanup();
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("resolveStateDir is stable per workspace and slug-based", () => {
  const repo = createTempRepo();
  try {
    process.env.CLAUDE_PLUGIN_DATA = "/tmp/devin-plugin-fixed";
    const dir1 = resolveStateDir(repo.dir);
    const dir2 = resolveStateDir(repo.dir);
    assert.equal(dir1, dir2);
    assert.match(dir1, /devin-plugin-fixed/);
  } finally {
    repo.cleanup();
    delete process.env.CLAUDE_PLUGIN_DATA;
  }
});

test("generateJobId produces unique prefixed ids", () => {
  const a = generateJobId("devin");
  const b = generateJobId("devin");
  assert.match(a, /^devin-/);
  assert.notEqual(a, b);
});
