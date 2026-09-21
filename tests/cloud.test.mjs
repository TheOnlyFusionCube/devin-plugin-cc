import assert from "node:assert/strict";
import test from "node:test";

import { getCloudSession, stopCloudSession } from "../plugins/devin/scripts/lib/cloud.mjs";

const PERSONAL_CONFIG = {
  apiKey: "personal-test-key",
  apiUrl: "https://api.devin.ai",
  orgId: null,
  userId: null,
  available: true,
  keyKind: "personal"
};

const SERVICE_CONFIG = {
  apiKey: "cog_test_key",
  apiUrl: "https://api.devin.ai",
  orgId: "org-123",
  userId: null,
  available: true,
  keyKind: "service"
};

function fakeResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function withMockedFetch(handler, fn) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler;
  return fn().finally(() => {
    globalThis.fetch = originalFetch;
  });
}

test("stopCloudSession DELETEs the v1 sessions path for a personal key", async () => {
  const calls = [];
  await withMockedFetch(
    async (url, options) => {
      calls.push({ url, method: options.method });
      return fakeResponse({ detail: "terminated" });
    },
    async () => {
      await stopCloudSession("devin-abc123", PERSONAL_CONFIG);
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, "https://api.devin.ai/v1/sessions/devin-abc123");
});

test("stopCloudSession DELETEs the v3 organization sessions path for a service key", async () => {
  const calls = [];
  await withMockedFetch(
    async (url, options) => {
      calls.push({ url, method: options.method });
      return fakeResponse({ session_id: "devin-abc123", status: "exit" });
    },
    async () => {
      await stopCloudSession("devin-abc123", SERVICE_CONFIG);
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, "https://api.devin.ai/v3/organizations/org-123/sessions/devin-abc123");
});

test("getCloudSession reads the PR url from v1's pull_request.url", async () => {
  await withMockedFetch(
    async () =>
      fakeResponse({
        status: "exit",
        pull_request: { url: "https://github.com/acme/repo/pull/1" }
      }),
    async () => {
      const snapshot = await getCloudSession("devin-abc123", PERSONAL_CONFIG);
      assert.equal(snapshot.pullRequestUrl, "https://github.com/acme/repo/pull/1");
    }
  );
});

test("getCloudSession reads the PR url from v3's pull_requests[0].pr_url", async () => {
  await withMockedFetch(
    async () =>
      fakeResponse({
        status: "exit",
        pull_requests: [{ pr_url: "https://github.com/acme/repo/pull/2", pr_state: "open" }]
      }),
    async () => {
      const snapshot = await getCloudSession("devin-abc123", SERVICE_CONFIG);
      assert.equal(snapshot.pullRequestUrl, "https://github.com/acme/repo/pull/2");
    }
  );
});
