import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { generateJobId, upsertJob } from "../plugins/devin/scripts/lib/state.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/devin/scripts/devin-companion.mjs", import.meta.url));
const SESSION_ID = "devin-example1";
const PERSONAL_KEY = "apk_example";
const SERVICE_KEY = "cog_service_example";
const ORG_ID = "org-example";

// Local stand-in for the Devin API. The companion runs as a child process, so the
// server lives in this process and the child is spawned asynchronously (spawnSync
// would block this event loop and the server could never answer).
async function startFakeApi() {
  const api = {
    requests: [],
    deleteStatus: 200,
    deleteBody: { detail: "Session terminated" },
    deleteStopsSession: true,
    session: { status: "running", status_detail: "working" },
    url: ""
  };
  const server = http.createServer((req, res) => {
    api.requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const resource = req.url.replace(/^\/v1|^\/v3\/organizations\/[^/]+/, "");
    if (req.method === "POST" && resource === "/sessions") {
      send(200, { session_id: SESSION_ID, url: "https://app.devin.ai/sessions/example1" });
    } else if (req.method === "DELETE" && resource === `/sessions/${SESSION_ID}`) {
      if (api.deleteStatus < 300 && api.deleteStopsSession) {
        api.session = { status: "exit", status_detail: null };
      }
      send(api.deleteStatus, api.deleteStatus < 300 ? api.deleteBody : { detail: "internal fault" });
    } else if (req.method === "GET" && resource === `/sessions/${SESSION_ID}`) {
      send(200, { session_id: SESSION_ID, url: "https://app.devin.ai/sessions/example1", ...api.session });
    } else {
      send(404, { detail: "not found" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api.url = `http://127.0.0.1:${server.address().port}`;
  api.close = () => new Promise((resolve) => server.close(resolve));
  api.count = (method) => api.requests.filter((request) => request.method === method).length;
  return api;
}

function runCompanion(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [COMPANION, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function createHarness({ serviceKey = false } = {}) {
  const api = await startFakeApi();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-cancel-test-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-cancel-data-"));
  const env = {
    CLAUDE_PLUGIN_DATA: dataDir,
    DEVIN_API_KEY: serviceKey ? SERVICE_KEY : PERSONAL_KEY,
    DEVIN_ORG_ID: serviceKey ? ORG_ID : "",
    DEVIN_USER_ID: "",
    DEVIN_API_URL: api.url,
    DEVIN_COMPANION_ALLOW_LOOPBACK_API: "1"
  };
  const run = (args, overrides = {}) => runCompanion(args, { cwd: dir, env: { ...env, ...overrides } });
  const json = async (args, overrides) => {
    const result = await run([...args, "--json"], overrides);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const handoff = async () => (await json(["handoff", "--task", "fix the flaky test"])).jobId;
  const job = async (jobId, overrides) => (await json(["status", jobId], overrides));
  // Every byte the plugin persisted or printed must be free of the key and the API URL.
  const assertNoSecrets = (...outputs) => {
    const persisted = [];
    const walk = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        entry.isDirectory() ? walk(full) : persisted.push(fs.readFileSync(full, "utf8"));
      }
    };
    walk(dataDir);
    for (const text of [...persisted, ...outputs]) {
      assert.ok(!text.includes(PERSONAL_KEY) && !text.includes(SERVICE_KEY), "API key leaked");
      assert.ok(!text.includes(api.url), "DEVIN_API_URL value leaked");
    }
  };
  return {
    api,
    dir,
    dataDir,
    run,
    json,
    handoff,
    job,
    assertNoSecrets,
    async cleanup() {
      await api.close();
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  };
}

test("cancel stops the cloud session, confirms it with a GET, and only then marks the job cancelled", async () => {
  const h = await createHarness();
  try {
    const jobId = await h.handoff();
    const cancel = await h.json(["cancel", jobId]);
    assert.equal(cancel.status, "cancelled");
    assert.equal(cancel.remoteStopped, true);
    assert.equal(cancel.remoteStatus, "exit");
    assert.equal(cancel.errorMessage, null);
    assert.deepEqual(
      h.api.requests.map((request) => `${request.method} ${request.path}`),
      ["POST /v1/sessions", `DELETE /v1/sessions/${SESSION_ID}`, `GET /v1/sessions/${SESSION_ID}`]
    );
    assert.equal(h.api.requests[1].authorization, `Bearer ${PERSONAL_KEY}`);

    const stored = await h.job(jobId);
    assert.equal(stored.status, "cancelled");
    assert.ok(stored.completedAt);
    assert.equal(stored.errorMessage, null);

    const again = await h.json(["cancel", jobId]);
    assert.equal(again.cancelled, false);
    assert.equal(h.api.count("DELETE"), 1);
  } finally {
    await h.cleanup();
  }
});

test("cancel reports a failed DELETE, keeps the job cancel_pending and refreshable, and a retry succeeds", async () => {
  const h = await createHarness();
  try {
    const jobId = await h.handoff();
    h.api.deleteStatus = 500;

    const text = await h.run(["cancel", jobId]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /NOT cancelled/);
    assert.match(text.stdout, /HTTP 500/);
    assert.match(text.stdout, new RegExp(`/devin:cancel ${jobId}`));
    assert.match(text.stdout, /Devin web app/);

    // The first run already left the job pending; query the structured form of a second attempt.
    const failed = await h.json(["cancel", jobId]);
    assert.equal(failed.status, "cancel_pending");
    assert.equal(failed.remoteStopped, false);
    assert.match(failed.errorMessage, /Stop request failed: Devin API returned HTTP 500/);
    assert.equal(h.api.count("DELETE"), 2);

    // status still treats it as active and keeps refreshing it from the API.
    const getsBefore = h.api.count("GET");
    const pending = await h.job(jobId);
    assert.equal(pending.status, "cancel_pending");
    assert.match(pending.errorMessage, /HTTP 500/);
    assert.equal(pending.completedAt, null);
    assert.ok(h.api.count("GET") > getsBefore, "status must refresh a cancel_pending job");
    const listed = await h.json(["status"]);
    assert.equal(listed.jobs.find((entry) => entry.id === jobId).status, "cancel_pending");

    // Retry once the API recovers.
    h.api.deleteStatus = 200;
    const retried = await h.json(["cancel", jobId]);
    assert.equal(retried.status, "cancelled");
    assert.equal(retried.remoteStopped, true);
    const stored = await h.job(jobId);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.errorMessage, null);
    assert.ok(stored.completedAt);

    h.assertNoSecrets(text.stdout, text.stderr);
  } finally {
    await h.cleanup();
  }
});

test("cancel without DEVIN_API_KEY keeps the job cancel_pending and makes no request", async () => {
  const h = await createHarness();
  try {
    const jobId = await h.handoff();
    const requestsBefore = h.api.requests.length;

    const cancel = await h.json(["cancel", jobId], { DEVIN_API_KEY: "" });
    assert.equal(cancel.status, "cancel_pending");
    assert.equal(cancel.remoteStopped, false);
    assert.match(cancel.errorMessage, /DEVIN_API_KEY is not set; it is needed to stop the remote session/);
    assert.equal(h.api.requests.length, requestsBefore);

    // Still active and listed without the key; nothing can be refreshed, nothing is requested.
    const pending = await h.job(jobId, { DEVIN_API_KEY: "" });
    assert.equal(pending.status, "cancel_pending");
    assert.equal(h.api.requests.length, requestsBefore);

    // With the key back, retry stops the session.
    const retried = await h.json(["cancel", jobId]);
    assert.equal(retried.status, "cancelled");
    assert.equal(retried.remoteStopped, true);
  } finally {
    await h.cleanup();
  }
});

test("status settles a cancel_pending job once the remote session is observed stopped", async () => {
  const h = await createHarness();
  try {
    const jobId = await h.handoff();
    h.api.deleteStatus = 500;
    const failed = await h.json(["cancel", jobId]);
    assert.equal(failed.status, "cancel_pending");
    assert.equal(h.api.count("DELETE"), 1);

    // A session that is merely waiting for the user is still alive: stay pending.
    h.api.session = { status: "running", status_detail: "waiting_for_user" };
    const waiting = await h.job(jobId);
    assert.equal(waiting.status, "cancel_pending");

    // The session ends on its own (or the stop lands late): status marks it cancelled.
    h.api.session = { status: "exit", status_detail: null };
    const settled = await h.job(jobId);
    assert.equal(settled.status, "cancelled");
    assert.ok(settled.completedAt);
    assert.equal(settled.errorMessage, null);
    assert.equal(h.api.count("DELETE"), 1, "status must not issue DELETE");

    // Terminal now: later status calls no longer hit the API.
    const requestsBefore = h.api.requests.length;
    await h.job(jobId);
    assert.equal(h.api.requests.length, requestsBefore);
  } finally {
    await h.cleanup();
  }
});

test("a service key goes through /v3 and a DELETE body claiming exit is not trusted", async () => {
  const h = await createHarness({ serviceKey: true });
  try {
    const jobId = await h.handoff();
    h.api.deleteBody = { session_id: SESSION_ID, status: "exit" };
    h.api.deleteStopsSession = false;

    const cancel = await h.json(["cancel", jobId]);
    assert.equal(cancel.status, "cancel_pending");
    assert.equal(cancel.remoteStopped, false);
    assert.equal(cancel.remoteStatus, "running");
    assert.match(cancel.errorMessage, /still reported as "running"/);
    const prefix = `/v3/organizations/${ORG_ID}/sessions/${SESSION_ID}`;
    assert.deepEqual(
      h.api.requests.slice(1).map((request) => `${request.method} ${request.path}`),
      [`DELETE ${prefix}`, `GET ${prefix}`]
    );

    h.api.deleteStopsSession = true;
    const retried = await h.json(["cancel", jobId]);
    assert.equal(retried.status, "cancelled");
    assert.equal(retried.remoteStopped, true);
  } finally {
    await h.cleanup();
  }
});

test("cancel of a local job without a cloud session is unchanged and never touches the API", async () => {
  const h = await createHarness();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = h.dataDir;
  try {
    const id = generateJobId("devin");
    upsertJob(h.dir, { id, kind: "task", workspaceRoot: h.dir, status: "running", title: "local task", pid: null });
    const cancel = await h.json(["cancel", id]);
    assert.equal(cancel.status, "cancelled");
    assert.equal(cancel.remoteStopped, null);
    assert.equal((await h.job(id)).status, "cancelled");
    assert.equal(h.api.requests.length, 0);
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
    await h.cleanup();
  }
});
