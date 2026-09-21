// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import { buildJobSnapshot, elapsedMs } from "./jobs.mjs";

function formatDuration(ms) {
  if (ms == null) {
    return "-";
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ${seconds % 60}s`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function truncate(text, max = 120) {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

export function renderSetupReport(report) {
  const lines = ["Devin companion setup", ""];
  lines.push(`- devin CLI: ${report.devin.installed ? `installed (${report.devin.version ?? "unknown version"})` : "NOT FOUND"}`);
  lines.push(`- auth: ${report.devin.authenticated ? `ok — ${report.devin.authDetail}` : `not authenticated (${report.devin.authDetail ?? "unknown"})`}`);
  lines.push(`- cloud API (DEVIN_API_KEY): ${report.cloud.available ? `set (${report.cloud.keyKind} key)` : "not set — /devin:handoff unavailable"}`);
  lines.push(`- git: ${report.git.available ? "ok" : `missing (${report.git.detail})`}`);
  lines.push(`- review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`);
  lines.push("");
  if (!report.devin.installed) {
    lines.push("Devin CLI is missing. Install it: https://docs.devin.ai/cli or `npm i -g devin-cli` if applicable.");
  } else if (!report.devin.authenticated) {
    lines.push("Devin is installed but not authenticated. Run `!devin auth login` (or `/login` inside devin) then re-run /devin:setup.");
  }
  if (!report.cloud.available) {
    lines.push("Set DEVIN_API_KEY to enable cloud handoffs (https://app.devin.ai/settings/api-keys). Local review/rescue work without it.");
  }
  if (report.ready) {
    lines.push("Devin is ready.");
  }
  return `${lines.join("\n")}\n`;
}

export function renderJobRow(snapshot) {
  return [
    snapshot.id,
    snapshot.kind,
    snapshot.status,
    snapshot.phase ?? "-",
    formatDuration(snapshot.elapsedMs),
    truncate(snapshot.summary ?? snapshot.title ?? snapshot.sessionUrl ?? "-", 80)
  ].join("\t");
}

export function renderStatusReport(jobs) {
  const lines = [];
  const snapshots = jobs.map((job) => buildJobSnapshot(job));
  lines.push(["JOB", "KIND", "STATUS", "PHASE", "ELAPSED", "SUMMARY"].join("\t"));
  for (const snapshot of snapshots) {
    lines.push(renderJobRow(snapshot));
  }
  lines.push("");
  lines.push("Use /devin:status <job-id> for details, /devin:result <job-id> for final output, /devin:cancel <job-id> to stop a running job.");
  return `${lines.join("\n")}\n`;
}

export function renderJobDetail(job) {
  const snapshot = buildJobSnapshot(job);
  const lines = [`Job ${snapshot.id} (${snapshot.kind})`];
  lines.push(`- status: ${snapshot.status}${snapshot.phase ? ` (${snapshot.phase})` : ""}`);
  lines.push(`- elapsed: ${formatDuration(snapshot.elapsedMs)}`);
  if (snapshot.summary) {
    lines.push(`- summary: ${snapshot.summary}`);
  }
  if (snapshot.title) {
    lines.push(`- title: ${snapshot.title}`);
  }
  if (snapshot.model) {
    lines.push(`- model: ${snapshot.model}`);
  }
  if (snapshot.permissionMode) {
    lines.push(`- permission-mode: ${snapshot.permissionMode}`);
  }
  if (snapshot.devinSessionId) {
    lines.push(`- devin session: ${snapshot.devinSessionId}  (reopen with \`devin -r ${snapshot.devinSessionId}\`)`);
  }
  if (snapshot.sessionUrl) {
    lines.push(`- cloud session: ${snapshot.sessionUrl}`);
  }
  if (snapshot.pullRequestUrl) {
    lines.push(`- pull request: ${snapshot.pullRequestUrl}`);
  }
  if (snapshot.errorMessage) {
    lines.push(`- error: ${snapshot.errorMessage}`);
  }
  lines.push(`- created: ${snapshot.createdAt ?? "-"}`);
  if (snapshot.completedAt) {
    lines.push(`- finished: ${snapshot.completedAt}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderStoredJobResult(job) {
  const stored = job?.result ?? {};
  const rendered = job?.rendered ?? stored.rendered ?? stored.rawOutput ?? "";
  if (rendered && String(rendered).trim()) {
    return String(rendered).endsWith("\n") ? String(rendered) : `${rendered}\n`;
  }
  return `Job ${job?.id ?? "?"} has no stored output yet (status: ${job?.status ?? "unknown"}).\n`;
}

export function renderCancelReport({ job, delivered, remoteStopped = null }) {
  const lines = [];
  if (delivered) {
    lines.push(`Cancellation requested for job ${job.id} (${job.kind}).`);
  } else {
    lines.push(`Job ${job.id} (${job.kind}) was already finished or its process is gone; marked cancelled.`);
  }
  if (job.sessionUrl) {
    lines.push(
      remoteStopped
        ? `Cloud session: ${job.sessionUrl} (stopped remotely).`
        : `Cloud session: ${job.sessionUrl} (could not confirm the remote stop; check the Devin web app).`
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderHandoffCreated({ job }) {
  const lines = ["Cloud Devin session created."];
  lines.push(`- job: ${job.id}`);
  if (job.sessionUrl) {
    lines.push(`- url: ${job.sessionUrl}`);
  }
  if (job.cloudSessionId) {
    lines.push(`- session: ${job.cloudSessionId}`);
  }
  lines.push("");
  lines.push(`Track it with /devin:status ${job.id} or open the session URL in a browser.`);
  return `${lines.join("\n")}\n`;
}
