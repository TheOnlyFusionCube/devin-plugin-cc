# devin-plugin-cc

A Claude Code plugin that brings Devin into your local workflow: read-only code reviews, delegated fix-up tasks via a rescue agent, cloud handoffs to Devin's web sessions, and an optional stop-time review gate — all driven by the local Devin CLI and the Devin API.

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

## Hooks

- **SessionStart** — exports session metadata for job attribution.
- **SessionEnd** — kills local jobs still running from this session. Detached cloud handoffs are left alone and reconciled on the next `status`/`result` call.
- **Stop (opt-in)** — when enabled via `/devin:setup --enable-review-gate`, reviews the previous turn's diff and blocks session stop only on a `BLOCK:` verdict. Infrastructure failures fail open with a warning.

## State

Per-workspace state lives outside the repo under the OS temp dir (`<tmp>/devin-companion/<slug>/`): `state.json` plus per-job `.json`/`.log`/`.prompt.md` files. Redirect with `CLAUDE_PLUGIN_DATA`. State writes are atomic; job files are garbage-collected when the 50-job history cap prunes them.

## Layout

```text
.claude-plugin/marketplace.json   # marketplace manifest
plugins/devin/
  .claude-plugin/plugin.json      # plugin manifest
  commands/*.md                   # /devin:* slash commands
  agents/devin-rescue.md          # thin forwarding subagent
  hooks/hooks.json                # lifecycle + stop-gate wiring
  prompts/*.md                    # review / adversarial / gate templates
  scripts/devin-companion.mjs     # CLI dispatcher
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

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
