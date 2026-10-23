import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTempRepo } from "./fake-devin-fixture.mjs";
import {
  createCloudSession,
  getCloudConfig,
  getCloudSession,
  resolveApiOrigin,
  sendCloudMessage
} from "../plugins/devin/scripts/lib/cloud.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/devin/scripts/devin-companion.mjs", import.meta.url));
const PRODUCTION = "https://api.devin.ai";
const OPT_IN = "DEVIN_COMPANION_ALLOW_LOOPBACK_API";
const API_KEY = "apk_test_secret_key";

const MALICIOUS_URLS = [
  "http://api.devin.ai",
  "https://api.devin.ai:8443",
  "https://api.devin.ai:443",
  "https://api.devin.ai:80",
  "https://api.devin.ai/v1",
  "https://api.devin.ai//",
  "https://api.devin.ai/.",
  "https://api.devin.ai/?",
  "https://api.devin.ai/?x=1",
  "https://api.devin.ai?x=1",
  "https://api.devin.ai/#frag",
  "https://api.devin.ai#",
  "https://user@api.devin.ai",
  "https://user:pass@api.devin.ai",
  "https://:pass@api.devin.ai",
  "https://api.devin.ai@evil.com",
  "https://api.devin.ai:443@evil.com",
  "https://evil.com@api.devin.ai",
  "https://api.devin.ai.evil.com",
  "https://evil.com/api.devin.ai",
  "https://evil.com#api.devin.ai",
  "https://evil.com?https://api.devin.ai",
  "https://api.devin.ai\\@evil.com",
  "https://evilapi.devin.ai",
  "https://app.devin.ai",
  "https://devin.ai",
  "https://api.devin.ai.",
  "https://api.devin。ai",
  "https://api.devin.ai。",
  "https://ａｐｉ.devin.ai",
  "https://api.dеvin.ai",
  "https://xn--pi-6fa.devin.ai",
  " https://api.devin.ai",
  "https://api.devin.ai ",
  "https://api.devin.ai\n",
  "https://api.dev\tin.ai",
  "https://api.devin.ai\u0000",
  "ftp://api.devin.ai",
  "file:///etc/passwd",
  "javascript:alert(1)",
  "//api.devin.ai",
  "api.devin.ai",
  "not a url",
  "https://",
  "https://evil.com",
  "http://169.254.169.254",
  "http://10.0.0.1",
  "https://127.0.0.1.evil.com",
  "http://localhost.evil.com:8080",
  "http://localhost@evil.com",
  "http://127.0.0.1@evil.com",
  "http://0.0.0.0:8080",
  "http://[::]:8080",
  "http://127.1:8080",
  "http://2130706433:8080",
  "http://[::ffff:127.0.0.1]:8080",
  "http://localhost:8080/v1",
  "http://localhost:8080/?x=1",
  "http://localhost:8080/#x",
  "http://user:pass@localhost:8080"
];

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

function envFor(url, extra = {}) {
  return { DEVIN_API_KEY: API_KEY, DEVIN_API_URL: url, ...extra };
}

test("unset or empty DEVIN_API_URL resolves to the production origin", () => {
  assert.equal(resolveApiOrigin({}), PRODUCTION);
  assert.equal(resolveApiOrigin({ DEVIN_API_URL: "" }), PRODUCTION);
  assert.equal(getCloudConfig({ DEVIN_API_KEY: API_KEY }).apiUrl, PRODUCTION);
  assert.equal(getCloudConfig({ DEVIN_API_KEY: API_KEY }).apiUrlError, null);
});

test("exact production origin is accepted and normalized", () => {
  for (const value of [PRODUCTION, `${PRODUCTION}/`, "https://API.DEVIN.AI", "HTTPS://Api.Devin.Ai/"]) {
    assert.equal(resolveApiOrigin({ DEVIN_API_URL: value }), PRODUCTION, value);
  }
});

test("malicious DEVIN_API_URL variants are rejected, with or without the loopback opt-in", () => {
  for (const value of MALICIOUS_URLS) {
    assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: value }), Error, JSON.stringify(value));
    assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: value, [OPT_IN]: "1" }), Error, `opt-in: ${JSON.stringify(value)}`);
  }
});

test("rejection messages never echo the raw URL (it may carry credentials)", () => {
  for (const value of ["https://user:hunter2@api.devin.ai", "https://api.devin.ai/?token=hunter2", "https://hunter2.example"]) {
    assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: value }), (error) => !error.message.includes("hunter2"));
  }
});

test("loopback URLs need the explicit test opt-in", () => {
  const loopbacks = ["http://127.0.0.1:8080", "http://localhost:3000/", "http://[::1]:9999", "https://localhost:8443", "HTTP://LOCALHOST:8080", "http://127.0.0.1"];
  for (const value of loopbacks) {
    assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: value }), new RegExp(OPT_IN), value);
    assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: value, [OPT_IN]: "true" }), new RegExp(OPT_IN), `non-1 opt-in: ${value}`);
    assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: value, [OPT_IN]: "" }), new RegExp(OPT_IN), `empty opt-in: ${value}`);
  }
  assert.equal(resolveApiOrigin({ DEVIN_API_URL: "http://127.0.0.1:8080", [OPT_IN]: "1" }), "http://127.0.0.1:8080");
  assert.equal(resolveApiOrigin({ DEVIN_API_URL: "http://localhost:3000/", [OPT_IN]: "1" }), "http://localhost:3000");
  assert.equal(resolveApiOrigin({ DEVIN_API_URL: "http://[::1]:9999", [OPT_IN]: "1" }), "http://[::1]:9999");
  assert.equal(resolveApiOrigin({ DEVIN_API_URL: "https://localhost:8443", [OPT_IN]: "1" }), "https://localhost:8443");
});

test("the opt-in does not unlock non-loopback hosts", () => {
  assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: "http://evil.com:8080", [OPT_IN]: "1" }));
  assert.throws(() => resolveApiOrigin({ DEVIN_API_URL: "http://api.devin.ai", [OPT_IN]: "1" }));
});

test("getCloudConfig reports an invalid URL instead of throwing", () => {
  const config = getCloudConfig(envFor("https://evil.com"));
  assert.equal(config.apiUrl, null);
  assert.match(config.apiUrlError, /DEVIN_API_URL/);
  assert.equal(config.available, true);
});

test("no credential-bearing request is made for any malicious URL (create, get, message)", async () => {
  await withMockedFetch(() => jsonResponse({ session_id: "devin-x", url: "https://app.devin.ai/sessions/x" }), async (calls) => {
    for (const value of MALICIOUS_URLS) {
      const config = getCloudConfig(envFor(value));
      await assert.rejects(createCloudSession({ task: "t", config }), Error, JSON.stringify(value));
      await assert.rejects(getCloudSession("devin-x", config), Error, JSON.stringify(value));
      await assert.rejects(sendCloudMessage("devin-x", "hi", config), Error, JSON.stringify(value));
      const serviceConfig = getCloudConfig({ ...envFor(value), DEVIN_API_KEY: "cog_service_key", DEVIN_ORG_ID: "org-1" });
      await assert.rejects(createCloudSession({ task: "t", config: serviceConfig }), Error, JSON.stringify(value));
    }
    assert.equal(calls.length, 0, "fetch must never be invoked");
  });
});

test("apiRequest refuses a config that carries a validation error even if apiUrl is forged", async () => {
  await withMockedFetch(() => jsonResponse({}), async (calls) => {
    const config = { ...getCloudConfig(envFor("https://evil.com")), apiUrl: "https://evil.com" };
    await assert.rejects(getCloudSession("devin-x", config), /DEVIN_API_URL/);
    assert.equal(calls.length, 0);
  });
});

test("valid default config sends the key only to the production origin", async () => {
  await withMockedFetch(() => jsonResponse({ session_id: "devin-abc", url: "https://app.devin.ai/sessions/abc" }), async (calls) => {
    const config = getCloudConfig({ DEVIN_API_KEY: API_KEY });
    const created = await createCloudSession({ task: "do it", config });
    assert.equal(created.sessionId, "devin-abc");
    await getCloudSession("devin-abc", config);
    await sendCloudMessage("devin-abc", "hi", config);
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.ok(call.url.startsWith(`${PRODUCTION}/v1/`), call.url);
      assert.equal(call.init.headers.Authorization, `Bearer ${API_KEY}`);
    }
  });
});

test("opted-in loopback config reaches the loopback origin", async () => {
  await withMockedFetch(() => jsonResponse({ status: "running" }), async (calls) => {
    const config = getCloudConfig(envFor("http://127.0.0.1:4010", { [OPT_IN]: "1" }));
    await getCloudSession("devin-abc", config);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://127.0.0.1:4010/v1/sessions/devin-abc");
  });
});

test("authenticated requests never follow redirects", async () => {
  await withMockedFetch(() => jsonResponse({ status: "running" }), async (calls) => {
    await getCloudSession("devin-abc", getCloudConfig({ DEVIN_API_KEY: API_KEY }));
    assert.equal(calls[0].init.redirect, "error");
  });
});

test("a redirect response is an error and triggers no second request", async () => {
  const redirect = () => new Response(null, { status: 302, headers: { location: "https://evil.com/steal" } });
  await withMockedFetch(redirect, async (calls) => {
    const config = getCloudConfig({ DEVIN_API_KEY: API_KEY });
    await assert.rejects(getCloudSession("devin-abc", config), /redirect/i);
    await assert.rejects(sendCloudMessage("devin-abc", "hi", config), /redirect/i);
    await assert.rejects(createCloudSession({ task: "t", config }), /redirect/i);
    assert.equal(calls.length, 3, "one request per call, none to the redirect target");
    assert.ok(calls.every((call) => call.url.startsWith(PRODUCTION)));
  });
});

test("a fetch-level redirect error (redirect: error) propagates", async () => {
  const failing = () => {
    throw new TypeError("fetch failed");
  };
  await withMockedFetch(failing, async (calls) => {
    await assert.rejects(getCloudSession("devin-abc", getCloudConfig({ DEVIN_API_KEY: API_KEY })), /fetch failed/);
    assert.equal(calls.length, 1);
  });
});

function runCompanion(args, { cwd, env = {} }) {
  return spawnSync(process.execPath, [COMPANION, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30000
  });
}

test("setup reports a rejected DEVIN_API_URL without crashing", () => {
  const repo = createTempRepo();
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { CLAUDE_PLUGIN_DATA: dataDir, DEVIN_API_KEY: API_KEY, DEVIN_API_URL: "https://user:hunter2@evil.com" };
    const json = runCompanion(["setup", "--json"], { cwd: repo.dir, env });
    const report = JSON.parse(json.stdout);
    assert.match(report.cloud.apiUrlError, /DEVIN_API_URL/);
    assert.ok(!json.stdout.includes("hunter2"));
    const text = runCompanion(["setup"], { cwd: repo.dir, env });
    assert.match(text.stdout, /DEVIN_API_URL\): REJECTED/);
    assert.ok(!text.stdout.includes("hunter2"));
  } finally {
    repo.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("handoff with a rejected DEVIN_API_URL fails before creating a job or any request", () => {
  const repo = createTempRepo();
  const dataDir = fs.mkdtempSync("/tmp/devin-plugin-data-");
  try {
    const env = { CLAUDE_PLUGIN_DATA: dataDir, DEVIN_API_KEY: API_KEY, DEVIN_API_URL: "https://api.devin.ai.evil.com" };
    const result = runCompanion(["handoff", "fix", "ci"], { cwd: repo.dir, env });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DEVIN_API_URL/);
    const status = runCompanion(["status", "--json"], { cwd: repo.dir, env });
    assert.equal(JSON.parse(status.stdout).jobs.length, 0);
  } finally {
    repo.cleanup();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
