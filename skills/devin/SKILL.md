---
name: devin
description: Run Devin (the Cognition AI coding agent) from any coding agent or CLI. Use when the user asks for a Devin code review, an adversarial review, to delegate a task to Devin, to hand work off to a cloud Devin session at app.devin.ai, or to check/cancel Devin background jobs. Requires the devin-plugin-cc checkout and the local `devin` CLI (or DEVIN_API_KEY for cloud handoffs).
---

# Devin from any agent

Drive Devin through the companion CLI in the devin-plugin-cc repository:

```bash
node <PLUGIN_ROOT>/scripts/devin-companion.mjs <command> [flags] [free text]
```

`<PLUGIN_ROOT>` is `plugins/devin` inside a devin-plugin-cc checkout — e.g.
`$HOME/devin-plugin-cc/plugins/devin`, or wherever the plugin is installed.
Run it with `cwd` set to the repository Devin should work on; job state is
scoped per workspace. Flags go before free text; text after the first
positional is passed to Devin verbatim.

## Commands

- `setup` — check the `devin` binary, auth status, and `DEVIN_API_KEY`. Run this first.
- `review [--base <ref>] [--scope auto|working-tree|branch] [--wait|--background] [focus]` — read-only code review. Never modifies files.
- `adversarial-review [same flags] [focus]` — read-only review of design choices, assumptions, and failure modes.
- `task [--read-only|--write] [--sandbox] [--resume|--resume-id <id>] [--model <id>] [text]` — delegate work. Write-capable by default.
- `handoff [--wait|--background] [--context <text>] [--tag <tag>] <task>` — open a cloud session at app.devin.ai carrying repo, branch, and uncommitted diff. Needs `DEVIN_API_KEY`.
- `status [job-id] [--wait] [--json]` — list/inspect jobs.
- `result [job-id] [--json]` — print a finished job's full output.
- `cancel <job-id>` — stop a running job or cloud session.
- `/fusion <task>` — use GPT 6 Astra as the lead and Devin as the sidekick for bounded mechanical or test-heavy work. The portable Fusion skill lives in `skills/fusion/`.

All commands accept `--json` for machine-readable output.

## Rules

1. Run `setup` once first; surface its output if Devin isn't ready.
2. Reviews are strictly read-only — relay Devin's findings verbatim, never apply the fixes yourself unless the user asks.
3. The default model is `swe-2-max`; only pass `--model` when the user names one.
4. For `--background` jobs, tell the user the job id and how to check it (`status`/`result`); don't poll in the same turn.
5. Never print or persist `DEVIN_API_KEY` or other credentials.
