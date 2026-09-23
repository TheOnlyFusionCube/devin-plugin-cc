# Devin Plugin for Claude Code and Codex

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-blueviolet)](https://docs.anthropic.com/en/docs/claude-code)
[![Devin CLI](https://img.shields.io/badge/Devin-CLI%20%2B%20API-00c7b7)](https://docs.devin.ai/cli)

**Devin Plugin for Claude Code and Codex** brings [Devin](https://devin.ai) into a terminal coding workflow for AI code review, delegated coding tasks, cloud handoffs, and Fusion sidekick sessions. Claude Code uses slash commands such as `/devin:review` and `/devin:fusion`; Codex and other agents use the portable skills and the shared Devin CLI runtime.

The project is an open-source Claude Code plugin and cross-agent integration for Devin AI. It uses the local [Devin CLI](https://docs.devin.ai/cli) for one-shot work and the Devin API for cloud handoffs.

## What it does

| Capability | Description |
| --- | --- |
| AI code review | Review a working tree or branch diff with read-only Devin analysis. |
| Adversarial review | Examine implementation choices, assumptions, tradeoffs, and failure modes. |
| Task delegation | Send a bounded coding task to Devin with workspace-aware state and resumable sessions. |
| Fusion workflow | Keep Claude Opus 5.5 or GPT 6 Astra as the lead while Devin handles bounded mechanical or test-heavy work. |
| Cloud handoff | Open a Devin session with repository, branch, context, and uncommitted diff. |
| Agent skills | Use the same runtime from Codex, OpenCode, Cursor, Gemini CLI, Amp, Jules, Aider, and other agents. |
| Review gate | Optionally review the previous Claude turn before the session ends. |

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

Clone and validate the repository first:

```bash
git clone https://github.com/TheOnlyFusionCube/devin-plugin-cc
cd devin-plugin-cc
npm install
npm run doctor
```

Inside Claude Code, add the local marketplace and install the plugin:

```text
/plugin marketplace add .
/plugin install devin@devin-plugin-cc
```

The equivalent shell commands use the GitHub marketplace directly:

```bash
claude plugin marketplace add TheOnlyFusionCube/devin-plugin-cc
claude plugin install devin@devin-plugin-cc
```

Or point Claude Code at this repo with `--plugin-dir`.

Then run:

```text
/devin:setup
```

to verify the Devin binary, auth, and cloud credentials.

### Codex, OpenCode, Cursor, Gemini CLI, and other agents

The runtime is a plain Node CLI — every agent can drive it; only the command wrappers are Claude-specific. Two standard entry points ship in this repo:

- **[AGENTS.md](AGENTS.md)** — read natively by Codex CLI, OpenCode, Cursor, Gemini CLI, Amp, Jules, and Aider. It documents the full `devin-companion.mjs` command surface.
- **[skills/devin/](skills/devin/SKILL.md)** and **[skills/fusion/](skills/fusion/SKILL.md)** — portable [agent skills](https://agentskills.io). Copy both to `~/.codex/skills/`, `.agents/skills/` in your project, or your tool's skills dir.

Codex has a native plugin install that uses the same marketplace manifest:

```bash
codex plugin marketplace add TheOnlyFusionCube/devin-plugin-cc
codex plugin add devin@devin-plugin-cc
```

To install only the two portable skills instead of the whole plugin:

```bash
npx skills add TheOnlyFusionCube/devin-plugin-cc -a codex -g -s devin -s fusion -y
```

Omit `-g` for project scope. Then invoke Fusion with `$fusion <task>` (or pick it in `/skills`) and use the Devin skill commands.

## Commands

| Command | What it does |
| --- | --- |
| `/devin:setup` | Check `devin` binary, auth status, and `DEVIN_API_KEY`. Enable/disable the stop review gate (`--enable-review-gate` / `--disable-review-gate`). |
| `/devin:review [focus]` | Read-only review of the working tree, or `--base <ref>` for a branch diff. `--background` runs async, `--wait` polls to completion. |
| `/devin:adversarial-review [focus]` | Read-only review focused on implementation choices, tradeoffs, assumptions, and failure modes. Same flags as `review`. |
| `/devin:rescue <task>` | Delegate diagnosis/implementation to Devin via the `devin-rescue` subagent. Write-capable by default; `--read-only`/`--background`/`--resume` supported. |
| `/devin:fusion <task>` | Run a frontier-lead workflow with Claude Opus 5.5 as lead and Devin as the sidekick for bounded mechanical work. |
| `/devin:handoff <task>` | Create a cloud Devin session carrying repo, branch, context, and a bounded uncommitted diff. `--wait` polls until terminal. |
| `/devin:status [job-id]` | List local jobs and cloud handoffs, with live phase/elapsed info. |
| `/devin:result [job-id]` | Show the complete stored output of a finished job. |
| `/devin:cancel <job-id>` | Kill a running local job's process tree; for cloud handoffs also asks the session to stop. |

Review commands are strictly read-only: they never apply fixes. Arguments are parsed POSIX-style — flags first, then free text passed through verbatim.

The default model is pinned to **`swe-2-max`** (SWE-2 Max); pass `--model <id>` to any review/task command to override — `devin models list` shows what your account can use.

### Fusion

Fusion keeps the frontier model responsible for intent, planning, ambiguity, and final review while Devin handles bounded mechanical or test-heavy work in its own context. Cognition describes this sidekick pattern as two parallel agents with dynamic handoffs as the task evolves. See [Devin Fusion](https://cognition.com/blog/devin-fusion). This repo reimplements that pattern as prompts — the lead is your Claude or Codex session, not a separate Devin Fusion harness.

In Claude Code, run `/devin:fusion <task>`. The installed plugin command is namespace-scoped, so Claude exposes it as `/devin:fusion`; Claude Opus 5.5 is the lead model named by the command. Devin remains the sidekick and uses the existing `swe-2-max` default unless you override it.

In Codex, install the `skills/fusion/` skill (via `codex plugin add` or the `npx skills` command above) and invoke `$fusion <task>` — Codex skills use `$`, not `/`. GPT 6 Astra is the lead model named by that skill, with Devin as the sidekick.

## Hooks

- **SessionStart** — exports session metadata for job attribution.
- **SessionEnd** — kills local jobs still running from this session. Detached cloud handoffs are left alone and reconciled on the next `status`/`result` call.
- **Stop (opt-in)** — when enabled via `/devin:setup --enable-review-gate`, reviews the previous turn's diff and blocks session stop only on a `BLOCK:` verdict. Infrastructure failures fail open with a warning.

## State

Per-workspace state lives outside the repo under the OS temp dir (`<tmp>/devin-companion/<slug>/`): `state.json` plus per-job `.json`/`.log`/`.prompt.md` files. Redirect with `CLAUDE_PLUGIN_DATA`. State writes are atomic; job files are garbage-collected when the 50-job history cap prunes them.

## Layout

```text
AGENTS.md                         # cross-agent instructions (Codex, OpenCode, Cursor, …)
llms.txt                          # agent-readable summary + doc map
skills/devin/SKILL.md             # portable Devin runtime skill
skills/fusion/SKILL.md            # portable Fusion lead/sidekick skill
.claude-plugin/marketplace.json   # marketplace manifest (Claude Code and Codex)
.github/workflows/ci.yml          # CI: install check, tests, doctor
scripts/install.mjs               # npm prepare hook — required-file sanity check
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

## Frequently asked questions

### What is devin-plugin-cc?

`devin-plugin-cc` is a Claude Code plugin and portable agent integration that adds Devin AI code review, task delegation, cloud handoffs, and Fusion workflows to a repository-based coding workflow.

### Does it work with Claude Code and Codex?

Yes. Claude Code installs the `devin` marketplace plugin and exposes commands such as `/devin:review`, `/devin:rescue`, and `/devin:fusion`. Codex loads `skills/devin/` and `skills/fusion/`, then calls the same `devin-companion.mjs` runtime.

### What is Fusion mode?

Fusion keeps a frontier model as the lead for intent, planning, ambiguity, architecture, and final review. Devin acts as a sidekick for bounded mechanical, repetitive, or test-heavy work with its own task context.

### Does local use require a Devin API key?

No. Local review and task commands use an installed and authenticated Devin CLI. Only cloud handoffs require `DEVIN_API_KEY`.

## Development

```bash
npm test          # node --test — incl. a fake devin binary fixture
node --check <file>   # syntax-check any module
```

`DEVIN_COMPANION_DEVIN_BINARY` overrides the devin binary path (used by tests; handy for smoke tests against a stub).

## Credits

Derived from [`openai/codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) by OpenAI — original concept, architecture, and much of the companion runtime are theirs, adapted for the Devin CLI and Devin API. See [NOTICE](NOTICE).

## Disclaimer

`devin-plugin-cc` is an independent community project. It is **not affiliated with, endorsed by, or sponsored by Cognition AI** (the company behind Devin and Devin Desktop), Anthropic, or OpenAI. "Devin", "Devin Desktop", "Claude", "Claude Code", and "Codex" are trademarks of their respective owners; references here are descriptive only.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
