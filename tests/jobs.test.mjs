import assert from "node:assert/strict";
import test from "node:test";

import {
  buildJobSnapshot,
  elapsedMs,
  isJobActive,
  resolveJob,
  sortJobsNewestFirst
} from "../plugins/devin/scripts/lib/jobs.mjs";
import { isTerminalCloudStatus } from "../plugins/devin/scripts/lib/cloud.mjs";

test("isJobActive covers running, queued, detached", () => {
  assert.equal(isJobActive({ status: "running" }), true);
  assert.equal(isJobActive({ status: "queued" }), true);
  assert.equal(isJobActive({ status: "detached" }), true);
  assert.equal(isJobActive({ status: "completed" }), false);
  assert.equal(isJobActive({ status: "cancelled" }), false);
});

test("sortJobsNewestFirst orders by updatedAt desc", () => {
  const jobs = sortJobsNewestFirst([
    { id: "old", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "new", updatedAt: "2026-06-01T00:00:00Z" }
  ]);
  assert.equal(jobs[0].id, "new");
});

test("resolveJob picks newest active job without an id", () => {
  const jobs = [
    { id: "done", status: "completed", updatedAt: "2026-06-01T00:00:00Z" },
    { id: "live", status: "running", updatedAt: "2026-05-01T00:00:00Z" }
  ];
  assert.equal(resolveJob(jobs, null, { activeOnly: true }).id, "live");
  assert.equal(resolveJob(jobs, "done").id, "done");
  assert.throws(() => resolveJob(jobs, "nope"), /No job found/);
  assert.throws(() => resolveJob([], null), /No jobs recorded/);
});

test("elapsedMs uses completedAt or now for active jobs", () => {
  const finished = elapsedMs({ startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:00:10Z", status: "completed" });
  assert.equal(finished, 10000);
  const running = elapsedMs({ startedAt: new Date(Date.now() - 5000).toISOString(), status: "running" });
  assert.ok(running >= 4900 && running < 60000);
});

test("buildJobSnapshot keeps the fields status/result need", () => {
  const snapshot = buildJobSnapshot({
    id: "j1",
    kind: "handoff",
    status: "detached",
    sessionUrl: "https://app.devin.ai/sessions/abc",
    cloudSessionId: "devin-abc",
    startedAt: "2026-01-01T00:00:00Z"
  });
  assert.equal(snapshot.id, "j1");
  assert.equal(snapshot.sessionUrl, "https://app.devin.ai/sessions/abc");
  assert.equal(snapshot.cloudSessionId, "devin-abc");
});

test("isTerminalCloudStatus matches the handoff poll contract", () => {
  assert.deepEqual(isTerminalCloudStatus({ status: "working", statusDetail: null }), { terminal: false, ok: false });
  assert.deepEqual(isTerminalCloudStatus({ status: "exit", statusDetail: null }), { terminal: true, ok: true });
  assert.deepEqual(isTerminalCloudStatus({ status: "blocked", statusDetail: "waiting_for_user" }), { terminal: true, ok: true });
  assert.deepEqual(isTerminalCloudStatus({ status: "blocked", statusDetail: "finished" }), { terminal: true, ok: true });
  assert.deepEqual(isTerminalCloudStatus({ status: "error", statusDetail: null }), { terminal: true, ok: false });
  assert.deepEqual(isTerminalCloudStatus({ status: "suspended", statusDetail: null }), { terminal: true, ok: false });
});
