import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isJobActive } from "../plugins/devin/scripts/lib/jobs.mjs";
import { listJobs, readJobFile, resolveJobFile, upsertJob, writeJobFile } from "../plugins/devin/scripts/lib/state.mjs";

const HOOK = fileURLToPath(new URL("../plugins/devin/scripts/session-lifecycle-hook.mjs", import.meta.url));
const SESSION = "claude-session-example";
const OTHER_SESSION = "claude-session-other-example";

// Hook and fake API run in this process's event loop, so the hook is spawned
// asynchronously: that also lets Node reap the stand-in poller the hook kills.
function runSessionEnd({ cwd, env, sessionId = SESSION }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK, "SessionEnd"], { cwd, env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
    child.stdin.end(JSON.stringify({ hook_event_name: "SessionEnd", session_id: sessionId, cwd }));
  });
}

function spawnStandInProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  return { child, exited };
}

async function createHarness() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(500);
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-session-end-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-session-end-data-"));
  const env = {
    CLAUDE_PLUGIN_DATA: dataDir,
    DEVIN_API_KEY: "apk_example",
    DEVIN_API_URL: `http://127.0.0.1:${server.address().port}`,
    DEVIN_COMPANION_ALLOW_LOOPBACK_API: "1"
  };
  process.env.CLAUDE_PLUGIN_DATA = dataDir;
  const spawned = [];
  const seed = (job) => {
    const record = { workspaceRoot: dir, status: "running", sessionId: SESSION, startedAt: new Date().toISOString(), ...job };
    writeJobFile(dir, record.id, record);
    upsertJob(dir, record);
  };
  const standIn = () => {
    const entry = spawnStandInProcess();
    spawned.push(entry.child);
    return entry;
  };
  const stored = (id) => listJobs(dir).find((job) => job.id === id);
  return {
    dir,
    env,
    requests,
    seed,
    standIn,
    stored,
    storedFile: (id) => readJobFile(resolveJobFile(dir, id)),
    run: (options = {}) => runSessionEnd({ cwd: dir, env, ...options }),
    async cleanup() {
      for (const child of spawned) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("SessionEnd stops a --wait handoff poller and detaches the job instead of cancelling it", async () => {
  const h = await createHarness();
  try {
    const poller = h.standIn();
    h.seed({ id: "devin-handoff-wait", kind: "handoff", phase: "running-cloud", pid: poller.child.pid, cloudSessionId: "devin-example1" });

    const result = await h.run();
    assert.equal(result.status, 0, result.stderr);

    const exit = await poller.exited;
    assert.equal(exit.signal, "SIGTERM");

    for (const job of [h.stored("devin-handoff-wait"), h.storedFile("devin-handoff-wait")]) {
      assert.equal(job.status, "detached");
      assert.equal(job.pid, null);
      assert.equal(job.cloudSessionId, "devin-example1");
      assert.equal(job.completedAt, undefined);
      assert.match(job.phase, /poller stopped at session end/);
      assert.ok(isJobActive(job));
    }
    assert.deepEqual(h.requests, []);
  } finally {
    await h.cleanup();
  }
});

test("SessionEnd leaves other sessions and non-polled jobs alone and still cancels local jobs", async () => {
  const h = await createHarness();
  try {
    const local = h.standIn();
    const foreign = h.standIn();
    h.seed({ id: "devin-task-local", kind: "task", phase: "running", pid: local.child.pid });
    h.seed({
      id: "devin-handoff-foreign",
      kind: "handoff",
      phase: "running-cloud",
      pid: foreign.child.pid,
      cloudSessionId: "devin-example2",
      sessionId: OTHER_SESSION
    });
    h.seed({ id: "devin-handoff-detached", kind: "handoff", status: "detached", phase: "detached", pid: null, cloudSessionId: "devin-example3" });

    const result = await h.run();
    assert.equal(result.status, 0, result.stderr);

    assert.equal((await local.exited).signal, "SIGTERM");
    const task = h.stored("devin-task-local");
    assert.equal(task.status, "cancelled");
    assert.equal(task.phase, "cancelled");
    assert.equal(task.pid, null);
    assert.ok(task.completedAt);

    const other = h.stored("devin-handoff-foreign");
    assert.equal(other.status, "running");
    assert.equal(other.pid, foreign.child.pid);
    process.kill(foreign.child.pid, 0);

    const detached = h.stored("devin-handoff-detached");
    assert.equal(detached.status, "detached");
    assert.equal(detached.phase, "detached");
    assert.deepEqual(h.requests, []);
  } finally {
    await h.cleanup();
  }
});

test("SessionEnd still cancels a handoff that has no cloud session yet", async () => {
  const h = await createHarness();
  try {
    const creating = h.standIn();
    h.seed({ id: "devin-handoff-creating", kind: "handoff", phase: "creating", pid: creating.child.pid });

    const result = await h.run();
    assert.equal(result.status, 0, result.stderr);
    assert.equal((await creating.exited).signal, "SIGTERM");
    assert.equal(h.stored("devin-handoff-creating").status, "cancelled");
    assert.deepEqual(h.requests, []);
  } finally {
    await h.cleanup();
  }
});

test("SessionEnd waits for the poller to exit and keeps a terminal state it wrote while dying", async () => {
  const h = await createHarness();
  try {
    // Stand-in poller that records "completed" on SIGTERM, then exits: the hook must not
    // overwrite that with a stale snapshot taken before the kill.
    const stateModule = fileURLToPath(new URL("../plugins/devin/scripts/lib/state.mjs", import.meta.url));
    const script = `
      import(${JSON.stringify(stateModule)}).then(({ upsertJob }) => {
        process.on("SIGTERM", () => {
          upsertJob(${JSON.stringify(h.dir)}, { id: "devin-handoff-done", status: "completed", phase: "exit", pid: null, completedAt: new Date().toISOString() });
          process.exit(0);
        });
        console.log("ready");
        setInterval(() => {}, 1000);
      });`;
    const child = spawn(process.execPath, ["-e", script], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise((resolve) => child.on("exit", resolve));
    await new Promise((resolve) => child.stdout.once("data", resolve));
    h.seed({ id: "devin-handoff-done", kind: "handoff", phase: "running-cloud", pid: child.pid, cloudSessionId: "devin-example4" });

    const result = await h.run();
    assert.equal(result.status, 0, result.stderr);
    await exited;
    const job = h.stored("devin-handoff-done");
    assert.equal(job.status, "completed");
    assert.equal(job.phase, "exit");
    assert.deepEqual(h.requests, []);
  } finally {
    await h.cleanup();
  }
});
