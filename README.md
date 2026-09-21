# devin-plugin-cc — Devin plugin for Claude Code

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-blueviolet)](https://docs.anthropic.com/en/docs/claude-code)
[![Devin CLI](https://img.shields.io/badge/Devin-CLI%20%2B%20API-00c7b7)](https://docs.devin.ai/cli)

**A Claude Code plugin that puts [Devin](https://devin.ai) inside your terminal workflow**: AI code reviews, delegated coding tasks, and cloud handoffs to Devin's autonomous sessions — all from slash commands like `/devin:review` and `/devin:handoff`. Powered by the local [Devin CLI](https://docs.devin.ai/cli) (`devin -p` one-shot mode) and the Devin API.

What you get: read-only AI code reviews of your working tree or branch diff, adversarial review for design tradeoffs, a thin `devin-rescue` subagent that hands implementation work to Devin, cloud handoffs that carry your repo + branch + uncommitted diff into an app.devin.ai session, background job control (`status`/`result`/`cancel`), and an optional stop-time review gate that blocks session end on a `BLOCK` verdict.

Modeled after [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc), adapted to Devin's interfaces:

- Local runs use `devin -p` (one-shot, non-interactive) instead of Codex's app-server/broker — no daemon required.
- Session continuation uses `devin -c` (latest) and `devin -r <session-id>` (explicit).
- Reviews return Markdown findings rather than a JSON schema.
- Cloud handoffs create sessions at `app.devin.ai` via the Devin API.

## Requirements

- [Devin CLI](https://docs.devin.ai/cli) installed and authenticated (`devin auth status`), or `DEVIN_API_KEY` set for cloud handoffs.
- Node.js >= 18.18 (for the companion runtime).
- Git (review commands run inside a repository).

## Install

Add the marketplace and install the plugin:

```text
/plugin marketplace add <path-or-url-to-this-repo>
/plugin install devin@<marketplace-name>
```

Or point Claude Code at this repo with `--plugin-dir`.

Then run:

```text
/devin:setup
```

to verify the Devin binary, auth, and cloud credentials.

### Codex, OpenCode, Cursor, Gemini CLI, and other agents

The runtime is a plain Node CLI — every agent can drive it; only the command wrappers are Claude-specific. Two standard entry points ship in this repo:

- **[AGENTS.md](AGENTS.md)** — read natively by Codex CLI, OpenCode, Cursor, Gemini CLI, Amp, and Jules. It documents the full `devin-companion.mjs` command surface.
- **[skills/devin/](skills/devin/SKILL.md)** — a portable [agent skill](https://agentskills.io). Copy it to `~/.codex/skills/devin/`, `.agents/skills/devin/` in your project, or your tool's skills dir.

## Commands

| Command | What it does |
| --- | --- |
| `/devin:setup` | Check `devin` binary, auth status, and `DEVIN_API_KEY`. Enable/disable the stop review gate (`--enable-review-gate` / `--disable-review-gate`). |
| `/devin:review [focus]` | Read-only review of the working tree, or `--base <ref>` for a branch diff. `--background` runs async, `--wait` polls to completion. |
| `/devin:adversarial-review [focus]` | Read-only review focused on implementation choices, tradeoffs, assumptions, and failure modes. Same flags as `review`. |
| `/devin:rescue <task>` | Delegate diagnosis/implementation to Devin via the `devin-rescue` subagent. Write-capable by default; `--read-only`/`--background`/`--resume` supported. |
| `/devin:handoff <task>` | Create a cloud Devin session carrying repo, branch, context, and a bounded uncommitted diff. `--wait` polls until terminal. |
| `/devin:status [job-id]` | List local jobs and cloud handoffs, with live phase/elapsed info. |
| `/devin:result [job-id]` | Show the complete stored output of a finished job. |
| `/devin:cancel <job-id>` | Kill a running local job's process tree; for cloud handoffs also asks the session to stop. |

Review commands are strictly read-only: they never apply fixes. Arguments are parsed POSIX-style — flags first, then free text passed through verbatim.

The default model is pinned to **`swe-2-max`** (SWE-2 Max); pass `--model <id>` to any review/task command to override — `devin models list` shows what your account can use.

To change the default for every run, set `DEVIN_COMPANION_DEFAULT_MODEL` (useful on Devin Free, where `swe-2-max` is not available).

## Hooks

- **SessionStart** — exports session metadata for job attribution.
- **SessionEnd** — kills local jobs still running from this session. Detached cloud handoffs are left alone and reconciled on the next `status`/`result` call.
- **Stop (opt-in)** — when enabled via `/devin:setup --enable-review-gate`, reviews the previous turn's diff and blocks session stop only on a `BLOCK:` verdict. Infrastructure failures fail open with a warning.

## State

Per-workspace state lives outside the repo under the OS temp dir (`<tmp>/devin-companion/<slug>/`): `state.json` plus per-job `.json`/`.log`/`.prompt.md` files. Redirect with `CLAUDE_PLUGIN_DATA`. State writes are atomic; job files are garbage-collected when the 50-job history cap prunes them.

## Layout

```text
AGENTS.md                         # cross-agent instructions (Codex, OpenCode, Cursor, …)
skills/devin/SKILL.md             # portable agent skill (agentskills.io format)
.claude-plugin/marketplace.json   # marketplace manifest
plugins/devin/
  .claude-plugin/plugin.json      # plugin manifest
  commands/*.md                   # /devin:* slash commands
  agents/devin-rescue.md          # thin forwarding subagent
  hooks/hooks.json                # lifecycle + stop-gate wiring
  prompts/*.md                    # review / adversarial / gate templates
  scripts/devin-companion.mjs     # CLI dispatcher — the universal entry point
  scripts/lib/*.mjs               # args, state, jobs, git, devin, cloud, render
  skills/*/SKILL.md               # runtime, result-handling, prompting docs
tests/                            # node:test suite + fake devin fixture
```

## Development

```bash
npm test          # node --test — 22 tests incl. a fake devin binary fixture
node --check <file>   # syntax-check any module
```

`DEVIN_COMPANION_DEVIN_BINARY` overrides the devin binary path (used by tests; handy for smoke tests against a stub).

## Credits

Derived from [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) by OpenAI — original concept, architecture, and much of the companion runtime are theirs, adapted for the Devin CLI and Devin API. See [NOTICE](NOTICE).

## Disclaimer

`devin-plugin-cc` is an independent community project. It is **not affiliated with, endorsed by, or sponsored by Cognition AI** (the company behind Devin and Devin Desktop), Anthropic, or OpenAI. "Devin", "Devin Desktop", "Claude", "Claude Code", and "Codex" are trademarks of their respective owners; references here are descriptive only.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
