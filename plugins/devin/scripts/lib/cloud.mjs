const DEFAULT_API_URL = "https://api.devin.ai";
const LOOPBACK_OPT_IN_ENV = "DEVIN_COMPANION_ALLOW_LOOPBACK_API";
const LOOPBACK_URL_PATTERN = /^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?\/?$/i;
const MAX_DIFF_BYTES = 100 * 1024;

// Resolve the origin that bearer-authenticated requests are sent to. Throws a
// descriptive Error (never echoing the raw value, which may hold credentials)
// unless DEVIN_API_URL is unset, exactly https://api.devin.ai (optional single
// trailing slash, any host casing), or, only with DEVIN_COMPANION_ALLOW_LOOPBACK_API=1,
// an http(s) loopback URL (127.0.0.1, [::1], localhost) on any port. Everything else
// is rejected: userinfo, paths, queries, fragments, other ports, other hosts.
export function resolveApiOrigin(env = process.env) {
  const raw = env.DEVIN_API_URL;
  if (raw === undefined || raw === "") {
    return DEFAULT_API_URL;
  }
  if (/[\s\u0000-\u001f\u007f\\]/.test(raw)) {
    throw new Error("DEVIN_API_URL must not contain whitespace, control characters, or backslashes.");
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`DEVIN_API_URL is not a valid URL. Leave it unset to use ${DEFAULT_API_URL}.`);
  }
  if (parsed.username || parsed.password || raw.includes("@")) {
    throw new Error("DEVIN_API_URL must not contain credentials (user:pass@).");
  }
  if (parsed.search || parsed.hash || raw.includes("?") || raw.includes("#")) {
    throw new Error("DEVIN_API_URL must not contain a query string or fragment.");
  }
  const isLoopback = LOOPBACK_URL_PATTERN.test(raw);
  if (isLoopback) {
    if (env[LOOPBACK_OPT_IN_ENV] !== "1") {
      throw new Error(`DEVIN_API_URL points at a loopback address, which is only allowed for tests when ${LOOPBACK_OPT_IN_ENV}=1 is set.`);
    }
    return parsed.origin;
  }
  const normalized = raw.toLowerCase();
  if (normalized !== DEFAULT_API_URL && normalized !== `${DEFAULT_API_URL}/`) {
    throw new Error(`DEVIN_API_URL must be exactly ${DEFAULT_API_URL} (no other host, scheme, port, or path). Leave it unset to use the default.`);
  }
  return DEFAULT_API_URL;
}

export function getCloudConfig(env = process.env) {
  const apiKey = env.DEVIN_API_KEY ?? null;
  let apiUrl = null;
  let apiUrlError = null;
  try {
    apiUrl = resolveApiOrigin(env);
  } catch (error) {
    apiUrlError = error instanceof Error ? error.message : String(error);
  }
  return {
    apiKey,
    apiUrl,
    apiUrlError,
    orgId: env.DEVIN_ORG_ID ?? null,
    userId: env.DEVIN_USER_ID ?? null,
    available: Boolean(apiKey),
    keyKind: apiKey ? (apiKey.startsWith("cog_") ? "service" : "personal") : null
  };
}

function assertApiUrlValid(config) {
  if (config.apiUrlError || !config.apiUrl) {
    throw new Error(config.apiUrlError ?? "DEVIN_API_URL failed validation.");
  }
}

function resolveApiBase(config) {
  assertApiUrlValid(config);
  if (config.keyKind === "service") {
    if (!config.orgId) {
      throw new Error("DEVIN_ORG_ID (or --org-id) is required for service keys (cog_*).");
    }
    return `${config.apiUrl}/v3/organizations/${config.orgId}`;
  }
  return `${config.apiUrl}/v1`;
}

async function apiRequest(config, method, url, body) {
  assertApiUrlValid(config);
  const response = await fetch(url, {
    method,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

  if (response.status >= 300 && response.status < 400) {
    throw new Error(`Devin API returned HTTP ${response.status}; redirects are not followed on authenticated requests.`);
  }

  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail = parsed?.detail ?? parsed?.message ?? parsed?.error ?? text;
    throw new Error(`Devin API returned HTTP ${response.status}: ${detail}`);
  }
  return parsed;
}

export function buildHandoffPrompt({ task, context, repo, branch, diff }) {
  let prompt = task;
  let details = "";
  if (repo) {
    details += `Repo: ${repo}\n`;
  }
  if (branch) {
    details += `Branch: ${branch}\n`;
  }
  if (context) {
    details += `\n${context}\n`;
  }
  if (details) {
    prompt += `\n\n<details>\n<summary>Context from local environment</summary>\n\n${details}\n</details>`;
  }
  if (diff) {
    const trimmed = diff.length > MAX_DIFF_BYTES ? `${diff.slice(0, MAX_DIFF_BYTES)}\n... (diff truncated)` : diff;
    prompt += `\n\n<details>\n<summary>Uncommitted local changes (diff)</summary>\n\n\`\`\`diff\n${trimmed}\n\`\`\`\n\n</details>`;
  }
  return prompt;
}

export async function createCloudSession({
  task,
  context = null,
  tag = null,
  repo = null,
  branch = null,
  diff = null,
  config = getCloudConfig()
}) {
  if (!config.available) {
    throw new Error("DEVIN_API_KEY is not set. Get a key at https://app.devin.ai/settings/api-keys");
  }

  const prompt = buildHandoffPrompt({ task, context, repo, branch, diff });
  const tags = tag && tag !== "handoff" ? ["handoff", tag] : ["handoff"];
  const payload = { prompt, title: task.slice(0, 100), tags };
  if (config.keyKind === "service" && config.userId) {
    payload.create_as_user_id = config.userId;
  }

  const base = resolveApiBase(config);
  const body = await apiRequest(config, "POST", `${base}/sessions`, payload);
  const sessionId = body?.session_id ?? null;
  const url = body?.url ?? (sessionId ? `https://app.devin.ai/sessions/${sessionId.replace(/^devin-/, "")}` : null);
  if (!url) {
    throw new Error(`No session URL or ID in response: ${JSON.stringify(body)}`);
  }
  return { sessionId, url };
}

export async function getCloudSession(sessionId, config = getCloudConfig()) {
  if (!config.available) {
    throw new Error("DEVIN_API_KEY is not set. Get a key at https://app.devin.ai/settings/api-keys");
  }
  const base = resolveApiBase(config);
  const body = await apiRequest(config, "GET", `${base}/sessions/${sessionId}`);
  return {
    sessionId,
    status: body?.status ?? "unknown",
    statusDetail: body?.status_detail ?? null,
    title: body?.title ?? null,
    url: body?.url ?? null,
    // v1 returns pull_request: {url}; v3 returns pull_requests: [{pr_url, pr_state}].
    pullRequestUrl: body?.pull_request?.url ?? body?.pull_requests?.[0]?.pr_url ?? body?.pull_requests?.[0]?.url ?? null,
    structuredOutput: body?.structured_output ?? null,
    raw: body
  };
}

export async function sendCloudMessage(sessionId, message, config = getCloudConfig()) {
  if (!config.available) {
    throw new Error("DEVIN_API_KEY is not set.");
  }
  const base = resolveApiBase(config);
  return apiRequest(config, "POST", `${base}/sessions/${sessionId}/messages`, { message });
}

// Terminates the remote session instead of only asking it to stop. Both API
// versions use the same relative path: DELETE /v1/sessions/{session_id} for
// personal keys, DELETE /v3/organizations/{org_id}/sessions/{devin_id} for
// service keys, so resolveApiBase picks the right base for either.
export async function stopCloudSession(sessionId, config = getCloudConfig()) {
  if (!config.available) {
    throw new Error("DEVIN_API_KEY is not set.");
  }
  const base = resolveApiBase(config);
  return apiRequest(config, "DELETE", `${base}/sessions/${sessionId}`);
}

// The session itself no longer runs. Stricter than isTerminalCloudStatus, which
// also counts waiting_for_user and finished: those sessions are still alive.
export function isCloudSessionStopped({ status }) {
  return status === "exit" || status === "error" || status === "suspended";
}

function sanitizeDiagnostic(error, config) {
  let text = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim();
  if (config.apiKey) {
    text = text.split(config.apiKey).join("[redacted]");
  }
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

// Stops the remote session and reports whether the stop is CONFIRMED. The DELETE
// response is never trusted on its own: v1 returns only {detail}, and v3 returns a
// SessionResponse whose status is not documented as the post-termination state
// (status_detail is only populated on GET). So after the DELETE, even a failed one
// (v1 rejects DELETE on an already-exited session), we GET the session and confirm
// only when its status is exit, error, or suspended. Never throws; the diagnostic
// never contains the API key or the DEVIN_API_URL value.
export async function terminateCloudSession(sessionId, config = getCloudConfig()) {
  if (!config.available) {
    return { confirmed: false, status: null, diagnostic: "DEVIN_API_KEY is not set; it is needed to stop the remote session." };
  }
  let deleteError = null;
  try {
    await stopCloudSession(sessionId, config);
  } catch (error) {
    deleteError = sanitizeDiagnostic(error, config);
  }
  let status = null;
  let readError = null;
  try {
    const snapshot = await getCloudSession(sessionId, config);
    status = snapshot.status;
    if (isCloudSessionStopped(snapshot)) {
      return { confirmed: true, status, diagnostic: null };
    }
  } catch (error) {
    readError = sanitizeDiagnostic(error, config);
  }
  const parts = [deleteError ? `Stop request failed: ${deleteError}` : "Stop request was accepted."];
  if (readError) {
    if (readError !== deleteError) {
      parts.push(`Could not read the session to confirm: ${readError}`);
    }
  } else {
    parts.push(`The session is still reported as "${status}".`);
  }
  return { confirmed: false, status, diagnostic: parts.join(" ") };
}

export function isTerminalCloudStatus({ status, statusDetail }) {
  if (status === "error" || status === "suspended") {
    return { terminal: true, ok: false };
  }
  if (status === "exit" || statusDetail === "waiting_for_user" || statusDetail === "finished") {
    return { terminal: true, ok: true };
  }
  return { terminal: false, ok: false };
}

export async function pollCloudSession(sessionId, { intervalMs = 30000, onUpdate = null, config = getCloudConfig() } = {}) {
  for (;;) {
    const snapshot = await getCloudSession(sessionId, config);
    onUpdate?.(snapshot);
    const verdict = isTerminalCloudStatus(snapshot);
    if (verdict.terminal) {
      return { ...snapshot, ok: verdict.ok };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
