# Design: approval and budget cap for cloud handoff

Status: proposal for maintainer review, no code in this change.
Tracks: issue #4, "Proposal 6, cloud handoff: ACCEPT explicit approval + configurable ACU cap".
Base: `origin/main` at a9c4837.

This is the written confirmation contract promised in #4. Section 9 lists the
only decisions that need the maintainer.

## 1. Scope and current behavior

Only `cmdHandoff` (`plugins/devin/scripts/devin-companion.mjs`) reaches
`createCloudSession` (`plugins/devin/scripts/lib/cloud.mjs`). `/devin:fusion`
and `devin-rescue` go through local `task`, and `devin-rescue` is already told
never to call `handoff`. Handoff is the single place a billable session is made.

Today one invocation does everything with no confirmation: validates
`DEVIN_API_URL` (`resolveApiOrigin`), runs `getGitHandoffContext` (origin slug,
branch, `git diff HEAD`, tracked files only), builds the prompt
(`buildHandoffPrompt`, diff cut at `MAX_DIFF_BYTES = 100 * 1024` by string
length), and POSTs `{ prompt, title, tags, create_as_user_id? }` to
`/v1/sessions` (personal key) or `/v3/organizations/{org}/sessions` (`cog_`
key). No `max_acu_limit` is sent.

Facts that shape the design:

- `commands/handoff.md` has `allowed-tools: Bash(node:*)`, so inside that
  command any `node` call, including a future approve step, runs without a
  permission prompt. Command metadata cannot be the control.
- The command only tells the model to "warn" about secrets. A warning the model
  may or may not relay is not consent.
- Without `CLAUDE_PLUGIN_DATA` (Codex, every non-Claude agent) state falls back
  to `os.tmpdir()`, a shared `/tmp` on Linux. Plan files need ownership and mode checks.
- If `git diff HEAD` fails or exceeds the 2 MiB `maxBuffer`, `diff` silently
  becomes `null`. The plan must report that instead.

## 2. Requirement map

| Req from #4 | Section |
| --- | --- |
| Approval before a billable session; informed; safe when noninteractive; shows task, destination, cap | 3 |
| `disable-model-invocation: true`, not relied on alone | 4.3 |
| Flag alone is weak proof; threat model; no overclaiming | 4, 5 |
| Separate diff consent; launch without it; scope, size, secrets note; keep size limit | 3.3, 3.4 |
| Configurable cap, no default, positive integer, per API version; stop if missing; fresh approval on change | 6 |
| Tests: missing/invalid cap, denial, omitted diff, approved diff, v1 and v3 | 7 |

## 3. Two-phase protocol

### 3.1 Commands

```text
handoff --plan    [--include-diff] [--max-acu <n>] [--context <t>] [--tag <t>] [--json] <task>
handoff --approve <plan-id> [--confirm <h>] [--confirm-diff <h>] [--wait|--background] [--json]
handoff [plan flags] <task>        # no mode flag: see 3.4
```

- `--plan` never touches the network or creates a job. It resolves the payload,
  writes a plan file, prints a summary, exits 0.
- `--approve` rejects anything that changes the payload (`--context`, `--tag`,
  `--include-diff`, `--max-acu`). `--wait`, `--background`,
  `--poll-interval-ms`, `--json` are execution-only and stay.
- The job record is created only after approval succeeds, so a denied or
  expired plan leaves no job.

### 3.2 Canonical payload and plan file

The canonical payload is the exact request that would be sent:

```json
{ "apiVersion": "v1", "method": "POST", "url": "https://api.devin.ai/v1/sessions",
  "body": { "prompt": "<buildHandoffPrompt output>", "title": "<task, 100 chars>",
            "tags": ["handoff"], "max_acu_limit": 10 } }
```

(`10` is a placeholder, not a default.) For a `cog_` key the url is
`https://api.devin.ai/v3/organizations/<org>/sessions` and the body also carries
`create_as_user_id` when `DEVIN_USER_ID` is set. `payloadSha256` is SHA-256 of
this object serialized with sorted keys and no whitespace. The API key is never
part of it and never written to the plan. `diffSha256` hashes the diff text that
will be sent.

Plan file: `<state dir>/handoff-plans/<plan-id>.json` under `resolveStateDir(cwd)`.
Directory 0700, file 0600, created with `O_EXCL`. On read the CLI refuses a
symlink, a non-owner, or group/world access (skipped on Windows). `plan-id` is
`plan-` plus 8 base32 characters from `crypto.randomBytes`; it is an identifier,
not a secret.

```json
{ "version": 1, "planId": "plan-k3m9x2qa", "createdAt": "...", "expiresAt": "...",
  "workspaceRoot": "/abs/path",
  "inputs": { "task": "...", "context": null, "tag": null, "includeDiff": false,
              "maxAcu": { "value": 10, "source": "flag" } },
  "destination": { "origin": "https://api.devin.ai", "apiVersion": "v1",
                   "endpoint": "POST /v1/sessions", "keyKind": "personal", "orgId": null },
  "repo": "owner/name", "branch": "feature/x",
  "diff": { "included": false, "trackedFilesChanged": 3 },
  "payloadSha256": "<64 hex>", "diffSha256": null }
```

The plan stores inputs and hashes, never the diff text, so it is not a second
copy of secrets on disk. Task and `--context` are stored (0600) and removed when
the plan is consumed, denied, or expired. The plan is a cache of inputs, not a
trust anchor: approval binds to the hash the human saw, and the summary is
re-rendered from a recomputed payload at approve time (3.5).

### 3.3 Plan summary

Numbers are illustrative.

```text
Devin cloud handoff plan plan-k3m9x2qa (expires 18:15, single use)

Task:         fix the flaky CI test
Destination:  https://api.devin.ai   POST /v1/sessions   (personal key)
              The session is created in the Devin account that owns this key.
Repo/branch:  owner/name @ feature/x
Context:      <full --context text, or "none">
Cost cap:     max_acu_limit = 10 (from --max-acu). Billable once created.
              Sent to Devin as a limit; this tool cannot verify enforcement.
Local diff:   NOT included. 3 tracked files have uncommitted changes
              (re-plan with --include-diff to review and send them).

Payload SHA-256: 9f2c1a6e0b44...
Create: handoff --approve plan-k3m9x2qa --confirm 9f2c1a6e0b44
```

With `--include-diff` the diff block becomes:

```text
Local diff:   INCLUDED (tracked files only, `git diff HEAD`; untracked files are not sent)
              3 files, 41.2 KB total, 41.2 KB sent (limit 100 KB, not truncated)
                M src/ci/retry.ts      +12 -3   sent in full
                M .env.local           +1  -1   sent in full
              WARNING: local changes can contain secrets (keys, tokens, customer
              data). Everything listed here leaves this machine. .env.local looks
              like a secrets file.
Diff SHA-256: 71be08d3a9c2...
Create with diff: handoff --approve plan-k3m9x2qa --confirm 9f2c1a6e0b44 --confirm-diff 71be08d3a9c2
```

Rules:

- Sizes are bytes (`Buffer.byteLength`). The 100 KB limit is preserved as the
  cap on bytes sent. Each file is marked `sent in full`, `partially sent`, or
  `not sent`, derived from the truncated text that actually goes out.
- If `git diff HEAD` fails or is oversized, the plan says `Local diff:
  UNAVAILABLE (<reason>)` and refuses `--include-diff`.
- Path hints (`.env*`, `*.pem`, `*.key`, `id_rsa*`, `*credentials*`) are a
  best-effort warning, not a scanner. The summary never claims the diff is safe.
- `--json` carries the same fields: `status: "plan"`, `planId`, `expiresAt`,
  `destination`, `task`, `context`, `repo`, `branch`, `maxAcu {value, source}`,
  `diff {included, files[], totalBytes, sentBytes, truncated, limitBytes,
  sha256}`, `payloadSha256`, `confirm {handoff, diff}`.

### 3.4 Approval paths

**Path A, interactive TTY** (`stdin.isTTY` and `stdout.isTTY`). The CLI prints
the recomputed summary, then asks:

```text
Create a billable Devin session capped at 10 ACU on https://api.devin.ai? [y/N]
Send the diff above (3 files, 41.2 KB, may contain secrets)? [y/N]    # only if the plan has a diff
```

Default is No. Anything other than `y`/`yes`, EOF, or Ctrl-C denies. Declining
the diff prompt aborts the whole handoff; it does not continue without the diff,
because that is a different payload. The user re-plans without `--include-diff`.
In a TTY, bare `handoff <task>` runs plan then these prompts in one step.

**Path B, non-TTY attestation.** `--approve <id>` requires `--confirm <first 12
hex of payloadSha256>` and, for a diff plan, also `--confirm-diff <first 12 hex
of diffSha256>`. A missing or wrong token exits non-zero with no request. Two
distinct tokens keep diff consent from being implied by handoff consent.

**Bare `handoff <task>` without a TTY** behaves as `--plan` and exits 3
(`approval_required`), printing the `--approve` command. It never creates a
session. This is the one intentional behavior change for existing callers.

There is no `--yes`, no environment variable, and no config key that skips approval.

### 3.5 Approve algorithm

1. Load the plan. Reject if missing, expired, consumed, or failing the
   ownership and mode checks.
2. Re-resolve everything: key, `resolveApiOrigin`, key kind and org, git slug,
   branch, current `git diff HEAD`, and the cap (6.4).
3. Build the body once in memory. Compute `payloadSha256` and `diffSha256`.
4. If either differs from the stored value, refuse with `plan is stale:
   <what changed>` (task, branch, diff, cap, destination). The human runs
   `--plan` again.
5. Confirm per Path A or B. Path A's summary comes from step 3, not the file.
6. Atomically rename the plan to `<id>.consumed` before the network call.
7. Create the job record, send exactly the step 3 body. Git is not re-read
   between hashing and sending.
8. Store `approval: { mode: "tty" | "attested", planId, payloadSha256,
   diffSha256, maxAcuLimit, at }` in the job file. `status` and `result` show
   `maxAcuLimit` and the mode.

If the network call fails or times out, the plan stays consumed. The error says
the session may or may not exist and to check app.devin.ai/sessions before
planning again, so a lost response is not retried into a duplicate.

## 4. What this proves and what it does not

### 4.1 Guaranteed by the CLI

- G1. No session without an unexpired, unused plan whose payload hash matches
  the payload being sent.
- G2. The cap is present, a positive integer, shown to the approver, and part of
  the hash, so any change forces a new plan.
- G3. The diff is sent only if planned with `--include-diff` and separately
  confirmed (second prompt, or `--confirm-diff`).
- G4. Without a TTY nothing is auto-approved; bare `handoff` plans and stops.
- G5. Single use, time limited, with an audit record on the job.

### 4.2 Not guaranteed

- The CLI cannot tell a human from an agent. An agent with shell access can run
  `--plan`, read the tokens, and run `--approve`. Path B is an attestation that
  the caller showed the summary to a person, enforced only by the host.
- `isTTY` is not proof of a human. An agent that allocates a pty (`script`,
  `expect`, a harness pty) can answer the prompt.
- If the host auto-approves shell commands (a broad `Bash(node:*)` rule, Codex
  full-auto, skip-permissions modes), an agent can finish both phases with no
  human. The design blocks accidental one-shot invocation and makes every
  handoff reviewable and non-silent. It does not stop a fully autonomous agent
  with approval-free shell access.
- The CLI cannot verify what Devin does with the payload or what a session costs.

A stronger boundary has to come from the host: the permission prompt on the
`--approve` command and a structured question to the user. Because the approve
command line carries the hash tokens, a host dialog that shows the command
shows the decision. That is the host's guarantee, not this CLI's.

### 4.3 Surface changes

**Claude Code, `plugins/devin/commands/handoff.md`:**

- Add `disable-model-invocation: true`.
- Replace `Bash(node:*)` in `allowed-tools` with a plan-only pattern plus
  `AskUserQuestion`, so `--approve` is not pre-approved. Whether the allow-rule
  syntax can express this with `${CLAUDE_PLUGIN_ROOT}` must be verified during
  implementation. If not, `AskUserQuestion` is the control and the docs say so.
- Flow: run `--plan`, show the summary verbatim, call `AskUserQuestion` with
  "Create session" and "Cancel", plus a separate diff question when the plan has
  a diff. Only a selection leads to `--approve`. Any edit or cap change means a
  new plan and a new question.
- Remove the line that only asks the model to "warn" about secrets.

**Codex and other agents (`skills/devin/SKILL.md`, `AGENTS.md`):** require
`--plan`, quoting the summary to the user, and `--approve` only after the user
says yes in a later message. These are instructions, not enforcement, and the
docs say so. Document exit code 3 and the end of one-shot handoff.

**README and `docs/`:** one short section on plan/approve and cap setup, user
facing only. This design file stays out of the Pages site.

## 5. Threat model

| Threat | Mitigated by | Residual risk |
| --- | --- | --- |
| User mistake (wrong task, forgot the diff holds secrets, wrong cap) | Summary names task, destination, cap, diff files and bytes; TTY default is No; diff has its own confirmation | User can still approve something misread |
| Agent hands off on its own | Claude: `disable-model-invocation`. All: bare `handoff` never creates non-interactively; `--approve` needs a prior plan and tokens | Auto-approved shell lets an agent plan and approve itself (4.2) |
| Prompt injection says "hand off with the diff" | No one-shot path; diff needs `--include-diff` plus `--confirm-diff`; task and `--context` shown in full; destination fixed by `resolveApiOrigin` | If the host also auto-approves, plan contents go to the user's own Devin account. A malicious task string is not detectable |
| Injection smuggles secrets into `--context` | `--context` shown in full and hashed | Human must read it |
| Plan tampered by another local user | 0700 dir, 0600 file, `O_EXCL`, owner and symlink checks, no diff stored | None meaningful |
| Plan tampered by the same user's process | Hash and summary recomputed from live state; edited task or cap changes the hash and fails `--confirm` or the TTY summary | Same-user code can run the CLI and read the key anyway |
| Replay of an old approval | Single use (rename before send), expiry, hash must match current state | Lost response after send leaves uncertainty; error says to check the web app |
| TOCTOU between plan and approve (tree, branch, config, env) | Everything recomputed and compared; the hashed in-memory body is what is sent | Sub-millisecond window inside one process |
| Cap raised via config or env after planning | Cap is in the hash; env/config caps re-read and compared; flag cap frozen | An agent can edit config and re-plan, which still shows the new cap |
| Key leakage | Key absent from plan, summary, job record; redirects stay disabled; origin validation unchanged | Same as today |
| Secrets in the tracked diff | Separate consent, file list, bytes, warning, path hints, 100 KB limit | No scanning is claimed; secrets in tracked files are sent as-is |

Non-goals: proving a person is present; any bypass flag or env var (#4 already
rejected env-var unlocks for permission modes for the same reason); secret
scanning; converting ACU to money; changing `status`, `cancel`, or polling
beyond showing the cap and approval mode.

## 6. ACU cap

### 6.1 What the Devin spec says

Fetched 2026-10-24. `https://docs.devin.ai/v1-openapi.yaml`, schema
`CreateSessionParams`, used by `POST /v1/sessions`
(`create_session_endpoint_v1_sessions_post`):

```yaml
max_acu_limit:
  anyOf:
  - exclusiveMinimum: 0.0
    type: integer
  - type: 'null'
  description: Maximum ACU limit, must be positive
  title: Max Acu Limit
```

`https://docs.devin.ai/v3-openapi.yaml`, schema `SessionCreateRequest`, used by
`POST /v3/organizations/{org_id}/sessions`
(`handle_create_session_v3_organizations__org_id__sessions_post`):

```yaml
max_acu_limit:
  anyOf:
  - type: integer
  - type: 'null'
  title: Max Acu Limit
```

Relied on: the field is named `max_acu_limit`, is a nullable integer in both
create bodies, and v1 requires it to be greater than 0. `SessionCreateRequest`
also lists `prompt`, `title`, `tags`, `create_as_user_id`.

Not stated by the spec, so not assumed: what Devin does at the limit (stop,
pause, error); whether it is a hard billing ceiling; any upper bound for session
create (v3 declares none; a different schema, `AutomationLimits.max_acu_limit`
"Per spawned session (same name as the sessions API)", declares `minimum: 1.0`,
`maximum: 1000.0`, which hints a server bound may exist but is not the
session-create schema); ACU to money conversion; whether follow-up messages
count against it. The plugin sends and displays the field. It does not promise
a spending limit.

### 6.2 Configuration and precedence

Highest wins, resolved at plan time and re-checked at approve time:

1. `--max-acu <n>` on `handoff --plan`.
2. Environment `DEVIN_COMPANION_MAX_ACU`.
3. User-level config file, key `handoff.maxAcuLimit`.

No fourth layer. No default exists in code, docs, or examples (placeholders are
labeled as such).

Config file: `$DEVIN_COMPANION_CONFIG_DIR/config.json`, else
`$XDG_CONFIG_HOME/devin-companion/config.json`, else
`~/.config/devin-companion/config.json`; Windows `%APPDATA%\devin-companion\config.json`.
File 0600, directory 0700, written atomically (temp plus rename, like
`saveState`). Not the plugin state dir: that is per workspace, falls back to
`os.tmpdir()`, and `CLAUDE_PLUGIN_DATA` exists only under Claude Code, so
agents would see different caps (open question 3). Written by
`setup --set-max-acu <n>`, cleared by `setup --clear-max-acu`; `setup` already
owns persistent toggles (`--enable-review-gate`) and `setup --json` reports
`handoff.maxAcu {value, source}` or `null`.

```json
{ "version": 1, "handoff": { "maxAcuLimit": 10 } }
```

An agent can edit this file or set the env var. That does not weaken the
contract, because the cap is not the consent control; approval of the displayed
number is (G2).

### 6.3 Validation and the missing-cap stop

Flag and env values must match `^[1-9][0-9]*$` and pass `Number.isSafeInteger`.
Config values must be a JSON number that is a safe integer greater than 0.
Rejected: empty, `0`, negatives, `1.5`, `1e3`, `0x10`, `+5`, spaces, leading
zeros, `NaN`, strings in the config file, and anything above
`Number.MAX_SAFE_INTEGER`. No upper bound is invented (open question 5). An
invalid value in any layer is an error, never a fallthrough to a lower layer, so
a typo never silently uses another cap. The cap is sent as a JSON number.

Missing cap: exit non-zero, no request, no plan file.

```text
No ACU cap is configured, so no cloud session was started.
Cloud handoffs are billable and this plugin does not start uncapped sessions.
Choose a value that fits your budget, then either:
  - for this run:    handoff --plan --max-acu <positive integer> <task>
  - as your default: node scripts/devin-companion.mjs setup --set-max-acu <positive integer>
  - or set DEVIN_COMPANION_MAX_ACU=<positive integer>
The cap is sent to Devin as max_acu_limit and shown for your approval before any session is created.
```

Invalid value: `Invalid ACU cap from --max-acu: expected a positive integer
(1, 2, 3, ...), got "1.5". No cloud session was started.` The rejected value is
echoed truncated to 40 characters and never includes the API key.

### 6.4 When the cap changes

- The cap is in `payloadSha256`, so a changed cap makes old `--confirm` tokens
  invalid and TTY prompts are not reused.
- If the plan's cap source was `env` or `config`, approve re-reads that source;
  a different value gives `plan is stale: ACU cap changed from 10 to 25`.
- If the source was `flag`, the cap is frozen in the plan, and `--approve`
  does not accept `--max-acu`.

### 6.5 Payloads per API version

| Key | Request | Body keys |
| --- | --- | --- |
| Personal (any non-`cog_` key) | `POST https://api.devin.ai/v1/sessions` | `prompt`, `title`, `tags`, `max_acu_limit` |
| Service (`cog_`, needs `DEVIN_ORG_ID`) | `POST https://api.devin.ai/v3/organizations/{org}/sessions` | `prompt`, `title`, `tags`, `max_acu_limit`, `create_as_user_id` when `DEVIN_USER_ID` is set |

`createCloudSession` gains a required `maxAcuLimit` and throws if it is not a
positive safe integer, so no caller can skip the cap.

## 7. Test plan

New `tests/handoff-approval.test.mjs`, plus edits to `tests/surface-wiring.test.mjs`.
Reuse the fake `devin` fixture, `createTempRepo`, `initGitRepo`, `withMockedFetch`,
and a local HTTP server with `DEVIN_COMPANION_ALLOW_LOOPBACK_API=1` for
end-to-end runs. Every test asserts the request count.

Cap:

- Missing cap: non-zero exit, setup guidance, no plan file, 0 requests.
- Invalid cap, per layer: `0`, `-3`, `1.5`, `1e3`, `0x10`, `+5`, `007`, ` 5`,
  empty, `abc`, `9007199254740993`; config with a string, `0`, a float,
  malformed JSON. Invalid higher layer does not fall through.
- Precedence flag over env over config; plan records `source`.
- `setup --set-max-acu` / `--clear-max-acu` round trip; file mode 0600.
- Cap change between plan and approve (env, config) is stale, 0 requests.

Approval, denial, cancellation:

- Bare `handoff <task>` without a TTY: exit 3, plan printed, 0 requests, no job.
- `--approve` with no token, wrong token, expired plan, and a second use: each
  fails with no new request.
- Prompt logic is tested in-process against a fake TTY stream pair through an
  injected prompt function: `n`, empty, EOF deny; `y` approves; `n` to the diff
  prompt aborts everything. There is no flag or env var that injects an answer,
  since that would be an approval bypass. An optional end-to-end pty test uses
  `script` and is skipped where unavailable.
- Denial and cancellation leave no job record.

Diff:

- Omitted: `diff.included: false` with a file count; sent `prompt` has no
  "Uncommitted local changes" block; the diff text is absent from plan and summary.
- Approved: `--include-diff` plan lists files and bytes; approve needs both
  `--confirm` and `--confirm-diff`; missing `--confirm-diff` fails with 0 requests;
  the sent `prompt` contains the diff.
- Limit: over 100 KB gives `truncated: true`, `sentBytes <= 102400` plus the
  existing marker, per-file `partially sent`/`not sent`; multibyte measured in
  bytes. `MAX_DIFF_BYTES` unchanged.
- Editing a file between plan and approve makes the plan stale.
- `git diff HEAD` failure or oversize reports `UNAVAILABLE`, refuses `--include-diff`.
- The secrets warning always prints with a diff; `.env` triggers the path hint.

Payloads:

- v1/personal: `POST /v1/sessions`, integer `max_acu_limit` (typeof number), no
  `create_as_user_id`, `Authorization: Bearer` set, `redirect: "error"`.
- v3/service: `POST /v3/organizations/org-123/sessions`, integer `max_acu_limit`,
  `create_as_user_id` when `DEVIN_USER_ID` is set; no `DEVIN_ORG_ID` fails at plan time.
- `createCloudSession` without a valid `maxAcuLimit` throws, 0 requests.

Integrity:

- Plan file 0600 and dir 0700; world-readable plan, symlinked dir, and foreign
  owner rejected (skipped on Windows).
- Editing `task`, `maxAcu`, or `payloadSha256` in the plan fails; a branch
  switch fails.
- Invalid `DEVIN_API_URL` fails at plan time before a plan file exists (#11).
- Plan, summary, and job record never contain the API key.

Surface:

- `handoff.md` has `disable-model-invocation: true` and no bare `Bash(node:*)`.
- `SKILL.md`, `AGENTS.md`, README mention `--plan`, `--approve`, and cap setup;
  none contains a numeric cap recommendation.

## 8. Implementation order

1. Cap resolution, validation, config file, `setup` flags, and the required
   `maxAcuLimit` in `createCloudSession`, with their tests.
2. Plan and approve, hashing, plan file, TTY and attested paths, diff
   consent, job `approval` record.
3. Surface files and docs.

Each step is a separate small PR with its own tests. None touches proposals
1, 2, 4, or 5.

## 9. Open questions for the maintainer

1. Non-TTY approval. Do you want Path B (hash-bound `--confirm` tokens so
   Codex or Claude Bash can finish a handoff after the user said yes in chat),
   or TTY-only, where a person runs `--approve` in their own terminal (in Claude
   Code with the `!` prefix) and agents can only plan? My lean is Path B plus
   the host's approval, since TTY-only removes agent use and a pty defeats it
   anyway. TTY-only is the stricter choice.
2. Plan expiry. I propose 15 minutes, single use. Acceptable, or shorter?
3. Cap config location. I propose a shared user-level file under
   `XDG_CONFIG_HOME` or `~/.config/devin-companion/`. Do you prefer the plugin
   data dir, accepting that non-Claude agents then have no persistent cap and
   must use the flag or env var?
4. Behavior change. Bare `handoff <task>` stops creating sessions and exits 3
   when noninteractive, and `--wait`/`--background` move to `--approve`. Is
   breaking that one-shot contract acceptable, given you kept exit-code
   semantics stable in #12?
5. Cap bounds and semantics. The spec gives no upper bound or at-limit behavior
   for session create, while the automation schema bounds the same field at
   1000. Do you know the real behavior, and do you want a local sanity ceiling
   or leave the bound to the server?
