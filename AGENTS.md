# devin-plugin-cc — agent instructions

This repository is a coding-agent integration for [Devin](https://devin.ai). It
ships a Claude Code plugin under `plugins/devin/`, but the entire runtime is a
plain Node CLI — any coding agent (Codex CLI, OpenCode, Cursor, Gemini CLI,
Amp, Jules, Aider) can drive it directly. There is no daemon and no
Claude-specific machinery in the execution path.

## Universal entry point

```bash
node plugins/devin/scripts/devin-companion.mjs <command> [flags] [free text]
```

Run it with `cwd` set to the repository you want Devin to work on. State is
scoped per workspace and stored under `<tmp>/devin-companion/<slug>/` (override
with `CLAUDE_PLUGIN_DATA`). Node >= 18.18 is required.

Flags must come before free text; everything after the first positional is
passed through verbatim as prompt text.

## Commands

| Command | Purpose | Key flags |
| --- | --- | --- |
| `setup` | Check devin binary, auth, `DEVIN_API_KEY`; toggle review gate | `--enable-review-gate`, `--disable-review-gate`, `--json` |
| `review` | Read-only review of working tree or `--base <ref>` diff | `--wait`, `--background`, `--base`, `--scope`, `--model` |
| `adversarial-review` | Read-only review of design choices, tradeoffs, failure modes | same as `review` |
| `task` | Delegate work to local Devin (`devin -p`); write-capable by default | `--read-only`, `--write`, `--sandbox`, `--resume`, `--resume-id`, `--model`, `--permission-mode` |
| `task-resume-candidate` | Find the session a task could resume (`--json`) | — |
| `handoff` | Create a cloud session at app.devin.ai with repo+branch+diff context | `--wait`, `--background`, `--context`, `--tag`, `--poll-interval-ms` |
| `status` | List jobs; `status <id>` for one; `--wait` polls to terminal | `--json`, `--timeout-ms` |
| `result` | Print a finished job's stored output verbatim | `--json` |
| `cancel` | Kill a running job's process tree (or stop a cloud session) | — |

Every command accepts `--json` for machine-readable output.

## Defaults and safety

- **Model**: pinned to `swe-2-max` (SWE-2 Max). Override per call with
  `--model <id>`; see `devin models list`.
- **Reviews are read-only**: `review` and `adversarial-review` never modify
  files. They run `devin -p` in `autonomous` mode with `--sandbox`, falling
  back to `normal` mode where sandboxing is unavailable.
- **`task` is write-capable** (`accept-edits`) unless `--read-only` is passed.
  `--permission-mode dangerous`/`yolo`/`bypass` exist but should only be used
  when the caller explicitly asks for full auto-approval.
- **Handoffs require `DEVIN_API_KEY`** in the environment; nothing writes
  secrets to disk.

## Per-tool wiring

- **Claude Code**: install as a plugin (see README). Slash commands,
  hooks, and the `devin-rescue` subagent are wired automatically.
- **Codex CLI / Codex IDE**: copy `skills/devin/` from this repo into
  `~/.codex/skills/devin/` (or `.agents/skills/devin/` in the target project).
  Codex loads skills at session start; the skill body teaches it the commands.
  (Codex `~/.codex/prompts/` custom prompts are deprecated — use the skill.)
- **OpenCode / Cursor / Gemini CLI / Amp / Jules**: these agents read
  `AGENTS.md` natively — point them at this file, or drop the skill dir into
  the project's `.agents/skills/` (or the tool's equivalent) so it's loaded
  as context.
- **Any other agent**: the companion CLI above is the whole interface.

## Testing

```bash
npm test
```

Uses a fake `devin` binary fixture (`DEVIN_COMPANION_DEVIN_BINARY` env var
points the companion at any devin-compatible binary).
