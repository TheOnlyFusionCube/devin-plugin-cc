const DEFAULT_API_URL = "https://api.devin.ai";
const MAX_DIFF_BYTES = 100 * 1024;

export function getCloudConfig(env = process.env) {
  const apiKey = env.DEVIN_API_KEY ?? null;
  return {
    apiKey,
    apiUrl: env.DEVIN_API_URL ?? DEFAULT_API_URL,
    orgId: env.DEVIN_ORG_ID ?? null,
    userId: env.DEVIN_USER_ID ?? null,
    available: Boolean(apiKey),
    keyKind: apiKey ? (apiKey.startsWith("cog_") ? "service" : "personal") : null
  };
}

function resolveApiBase(config) {
  if (config.keyKind === "service") {
    if (!config.orgId) {
      throw new Error("DEVIN_ORG_ID (or --org-id) is required for service keys (cog_*).");
    }
    return `${config.apiUrl}/v3/organizations/${config.orgId}`;
  }
  return `${config.apiUrl}/v1`;
}

async function apiRequest(config, method, url, body) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json"
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {})
  });

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
    pullRequestUrl: body?.pull_request?.url ?? body?.pull_requests?.[0]?.url ?? null,
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
