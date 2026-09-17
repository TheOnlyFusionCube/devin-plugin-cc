---
description: Cancel an active background Devin job in this repository
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" cancel "$ARGUMENTS"`

Present the command output to the user exactly as returned. For cloud handoff jobs, preserve the session URL and note that the session can also be stopped from the Devin web app.
