import assert from "node:assert/strict";
import test from "node:test";

import { getCloudConfig, getCloudSession, stopCloudSession } from "../plugins/devin/scripts/lib/cloud.mjs";
import { renderCancelReport } from "../plugins/devin/scripts/lib/render.mjs";

const PERSONAL = getCloudConfig({ DEVIN_API_KEY: "apk_test_key" });
const SERVICE = getCloudConfig({ DEVIN_API_KEY: "cog_test_key", DEVIN_ORG_ID: "org-123" });

function withMockedFetch(handler, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(url, init);
  };
  return Promise.resolve(fn(calls)).finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("stopCloudSession DELETEs /v1/sessions/{id} for a personal key", async () => {
  await withMockedFetch(() => jsonResponse({ detail: "terminated" }), async (calls) => {
    await stopCloudSession("devin-abc", PERSONAL);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].url, "https://api.devin.ai/v1/sessions/devin-abc");
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.headers.Authorization, "Bearer apk_test_key");
  });
});

test("stopCloudSession DELETEs /v3/organizations/{org}/sessions/{id} for a service key", async () => {
  await withMockedFetch(() => jsonResponse({ session_id: "devin-abc", status: "exit" }), async (calls) => {
    await stopCloudSession("devin-abc", SERVICE);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, "DELETE");
    assert.equal(calls[0].url, "https://api.devin.ai/v3/organizations/org-123/sessions/devin-abc");
  });
});

test("stopCloudSession rejects without a key and never calls fetch", async () => {
  await withMockedFetch(() => jsonResponse({}), async (calls) => {
    await assert.rejects(stopCloudSession("devin-abc", getCloudConfig({})), /DEVIN_API_KEY/);
    assert.equal(calls.length, 0);
  });
});

test("stopCloudSession goes through DEVIN_API_URL validation: no request is made", async () => {
  await withMockedFetch(() => jsonResponse({}), async (calls) => {
    const config = getCloudConfig({ DEVIN_API_KEY: "apk_test_key", DEVIN_API_URL: "https://evil.example" });
    await assert.rejects(stopCloudSession("devin-abc", config), /DEVIN_API_URL/);
    assert.equal(calls.length, 0);
  });
});

test("stopCloudSession surfaces API errors and refuses redirects", async () => {
  await withMockedFetch(() => jsonResponse({ detail: "Session already exited" }, 400), async () => {
    await assert.rejects(stopCloudSession("devin-abc", PERSONAL), /HTTP 400.*already exited/);
  });
  await withMockedFetch(() => new Response(null, { status: 302 }), async () => {
    await assert.rejects(stopCloudSession("devin-abc", PERSONAL), /redirect/i);
  });
});

test("getCloudSession reads the PR url from v1 pull_request.url", async () => {
  const body = { status: "exit", pull_request: { url: "https://github.com/acme/repo/pull/1" } };
  await withMockedFetch(() => jsonResponse(body), async () => {
    const snapshot = await getCloudSession("devin-abc", PERSONAL);
    assert.equal(snapshot.pullRequestUrl, "https://github.com/acme/repo/pull/1");
  });
});

test("getCloudSession reads the PR url from v3 pull_requests[0].pr_url", async () => {
  const body = { status: "exit", pull_requests: [{ pr_url: "https://github.com/acme/repo/pull/2", pr_state: "open" }] };
  await withMockedFetch(() => jsonResponse(body), async () => {
    const snapshot = await getCloudSession("devin-abc", SERVICE);
    assert.equal(snapshot.pullRequestUrl, "https://github.com/acme/repo/pull/2");
  });
});

test("getCloudSession returns a null PR url when none is present", async () => {
  await withMockedFetch(() => jsonResponse({ status: "running", pull_requests: [] }), async () => {
    const snapshot = await getCloudSession("devin-abc", SERVICE);
    assert.equal(snapshot.pullRequestUrl, null);
  });
});

test("renderCancelReport states whether the remote stop was confirmed", () => {
  const job = { id: "job-1", kind: "handoff", sessionUrl: "https://app.devin.ai/sessions/abc" };
  assert.match(renderCancelReport({ job, delivered: false, remoteStopped: true }), /stopped remotely/);
  assert.match(renderCancelReport({ job, delivered: false, remoteStopped: false }), /could not confirm the remote stop/);
  assert.match(renderCancelReport({ job, delivered: false }), /could not confirm the remote stop/);
  assert.ok(!renderCancelReport({ job: { id: "job-2", kind: "task" }, delivered: true }).includes("Cloud session"));
});
