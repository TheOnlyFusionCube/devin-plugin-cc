---
description: Hand a task off to a cloud Devin session that runs on its own VM with repo, shell, and browser access
argument-hint: "[--wait|--background] [--context <text>] [--tag <tag>] <what the cloud Devin should do>"
allowed-tools: Bash(node:*), AskUserQuestion
---

Hand a task off to a cloud Devin session through the plugin runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command creates a cloud Devin session on Devin's infrastructure, not locally.
- It requires `DEVIN_API_KEY` in the environment. If unset, the companion reports that and stops — tell the user to get a key at https://app.devin.ai/settings/api-keys and re-run.
- The companion automatically attaches the repo slug, current branch, and uncommitted diff as context. Warn the user if the diff may contain secrets they do not want sent to the cloud.
- Your only job is to run the handoff and return the companion's output verbatim to the user.

Context rules:
- If the user passed `--context`, preserve it exactly.
- If the task would benefit from findings in this session (files inspected, root cause found, partial work), write a short `--context` summary yourself before invoking. Keep it factual: paths, symptoms, decisions already made.
- Do not dump the whole transcript. A few lines of high-signal context beats a wall of text.

Execution mode rules:
- Default (no flags): create the session, print the session URL, and return immediately. The cloud Devin keeps working on its own; the user tracks it at the URL or with `/devin:status <job-id>`.
- If the raw arguments include `--wait`: run the handoff in the foreground. The companion creates the session, then polls until Devin finishes and prints the final status (including a PR URL if one was opened).
- If the raw arguments include `--background`: launch the same wait/poll flow in a Claude background task so the user keeps working locally and checks in later with `/devin:status` or `/devin:result`.

Foreground flow:
- Run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" handoff "$ARGUMENTS"
```
- Return the command stdout verbatim, exactly as-is.

Background flow:
- Launch with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/devin-companion.mjs" handoff "$ARGUMENTS"`,
  description: "Devin cloud handoff",
  run_in_background: true
})
```
- Do not call `BashOutput` or wait for completion in this turn.
- After launching, tell the user: "Devin cloud handoff started. Check `/devin:status` for progress or open the session URL."

When to suggest this:
- The task needs a VM, a running server, a browser, Docker, or CI access.
- The work is long-running and the user wants it off their machine.
- The user wants to fan out several tasks in parallel cloud sessions.
