---
description: Check whether the local Devin CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), AskUserQuestion
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" setup --json $ARGUMENTS
```

If the result says Devin is unavailable:
- Do not offer to install it yourself.
- Point the user at the install instructions: `brew install cognition/tap/devin` or https://docs.devin.ai/cli
- After they install, they can re-run `/devin:setup`.

If Devin is installed but not authenticated:
- Tell the user to run `!devin auth login` (or `/login` inside an interactive `devin` session), then re-run `/devin:setup`.

If `DEVIN_API_KEY` is not set:
- Note that local commands (`review`, `adversarial-review`, `rescue`) work without it.
- Only `/devin:handoff` needs it; point to https://app.devin.ai/settings/api-keys.

Review gate flags:
- `--enable-review-gate` and `--disable-review-gate` toggle the stop-time review gate persisted in plugin state.
- When enabled, a `Stop` hook runs a targeted read-only Devin review of Claude's last turn; if it finds blocking issues, the stop is blocked so Claude can address them first.

Output rules:
- Present the final setup output to the user.
- If Devin is installed but not authenticated, preserve the guidance to run `!devin auth login`.
- Warn that the review gate can create a long-running Claude/Devin loop and drain usage; suggest enabling it only while actively monitoring the session.
