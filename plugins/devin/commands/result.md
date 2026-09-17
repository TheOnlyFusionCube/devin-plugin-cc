---
description: Show the stored final output for a finished Devin job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" result "$ARGUMENTS"`

Present the full command output to the user. Do not summarize or condense it. Preserve all details including:
- Job ID and status
- The complete result payload, including verdict, summary, findings, details, artifacts, and next steps
- File paths and line numbers exactly as reported
- Any error messages or parse errors
- The Devin session ID and the `devin -r <session-id>` reopen command when available
- For cloud handoffs: the session URL, live status, and PR URL when Devin opened one
- Follow-up commands such as `/devin:status <id>` and `/devin:review`
