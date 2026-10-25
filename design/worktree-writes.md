# Design: isolated worktrees for write-capable tasks (issue #4, proposal 1)

Status: proposal for maintainer review. No code changes in this PR.
Base: `main` at a9c4837. Contract: the maintainer's follow-up on #4, "Proposal 1, isolated worktrees: ACCEPT the worktree-first default, in phases".

This document decides the design questions the maintainer listed, so a foundation PR can be built against it. Where the answer depends on Devin CLI behavior that cannot be verified from this repo or the bundled CLI docs, it is marked `OPEN (Devin CLI)` and collected at the end under "Unverified Devin CLI behavior".

Contract checklist:

| Maintainer item | Section |
| --- | --- |
| Worktree by default for write tasks incl. `/devin:rescue`; caller checkout unchanged; explicit apply step | 3, 8 |
| Explicit `--in-place`, clearly marked less isolated; read-only needs no worktree | 3 |
| Dirty, staged, untracked starting trees | 4 |
| Location, safe naming, state (job -> worktree, branch, base commit) | 5, 6 |
| Resume the right session and job | 7 |
| Apply: preview, explicit action, conflicts, binary files, no overwrite, keep worktree on failure | 8 |
| Cancel, cleanup, recovery | 9 |
| Non-git directories | 10 |
| Codex and portable CLI compatibility, tests, docs | 11, 13 |
| Not a security sandbox; no weakening of sandbox or permission controls | 12 |

## 1. Goal and non-goals

Goal: a write-capable local `task` never edits the caller's checkout directly. Devin works in a plugin-managed Git worktree on a plugin-managed branch. The caller reviews a delta and applies it with an explicit step. The old behavior stays available as an explicit `--in-place` flag.

Non-goals:

- Security isolation. A worktree protects the active checkout from accidental edits. It is not a sandbox (section 12).
- Changing `--permission-mode`, `--sandbox`, or `--respect-workspace-trust` handling. Those stay governed by proposals 2, 3 (done in #12), 4, and 5.
- Changing cloud `handoff`. It never touches the local checkout and gets no worktree.
- Changing `review`, `adversarial-review`, or `task --read-only`.
- Carrying gitignored files (`node_modules`, `.env`, build output) into the worktree in Phase 1 (open question 4).
- Auto-merging, auto-committing to the caller's branch, pushing, or opening PRs.

## 2. Current behavior

All references are to `a9c4837`.

Write runs:

- `main()` in `plugins/devin/scripts/devin-companion.mjs` sets `cwd = resolveWorkspaceRoot(process.cwd())` (`lib/workspace.mjs`: the Git toplevel, or the raw cwd when not in a repo). Every command uses that one directory.
- `cmdTask` parses `--model`, `--resume-id`, `--permission-mode` and the booleans `wait background write read-only resume resume-last fresh sandbox json`, with `stopAtFirstPositional: true`, so every flag must precede the prompt text. The permission mode is `normalizePermissionMode(--permission-mode)`, else `autonomous` with `--sandbox`, else `normal` with `--read-only`, else `accept-edits`. A task is write-capable exactly when `permissionMode !== "normal"` (stored as `meta.write`). `--write` is parsed but never read; the rescue subagent adds it by convention only.
- `runDevinJob` creates the job record (`createJobRecord`), writes `<jobsDir>/<id>.prompt.md`, then `runTrackedJob` (`lib/jobs.mjs`) runs `buildDevinPrintArgs` and `runDevinPrint({ cwd, args })`. Devin is spawned with `cwd` set to the workspace root and `env: process.env`, in its own process group (`detached`), so `job.pid` (patched in by `onSpawn`) is the Devin child. There is no sandbox retry (removed by #12).
- `buildDevinPrintArgs` emits `-p`, `--model`, `--permission-mode`, `--sandbox`, `-c` or `-r <id>`, `--respect-workspace-trust false`, `--prompt-file`.
- Nothing in the plugin runs `git worktree`. `lib/git.mjs` has `ensureGitRepository`, `getRepoRoot`, `getCurrentBranch`, and `getWorkingTreeState` (staged, unstaged, and untracked via `ls-files --others --exclude-standard`, so ignored files are excluded). All git calls use `shell: false`.

Resume:

- `--resume` or `--resume-last` (without `--fresh` or `--resume-id`) sets `continueLast`, which becomes `devin -p -c`. `--resume-id <id>` becomes `devin -p -r <id>`. Devin documents `-c` as "the most recent session in the current directory" (`reference/commands.mdx` in the bundled docs).
- After a run, `findLatestDevinSession(cwd, { createdAfterMs })` calls `devin list --format json` and keeps sessions whose `working_directory` equals `cwd` or its realpath, newest `last_activity_at` first. The result is stored as `devinSessionId` by `runTrackedJob`.
- `task-resume-candidate` (`cmdResumeCandidate`, `findTaskResumeCandidate`) is directory-scoped the same way. `commands/rescue.md` uses it to ask "continue or start new" and then adds `--resume` or `--fresh`.

State and jobs:

- `lib/state.mjs`: state is keyed by `resolveStateDir(cwd)`, `<slug>-<sha256(realpath)[0:16]>` under `$CLAUDE_PLUGIN_DATA/state`, falling back to `os.tmpdir()/devin-companion`. `saveState` rewrites only `{version, config, jobs}`, so any other top-level field is dropped. `pruneJobs` keeps 50 jobs and `saveState` deletes the pruned jobs' `.json/.log/.prompt.md/.output` files.
- Statuses: `queued running completed failed cancelled detached cancel_pending`. `isJobActive` is true for `queued running detached cancel_pending`. `cancel_pending` (#15) is written only by `cancelCloudHandoff`, for cloud handoffs.
- `detectDeadJob` marks a `running` job `failed` when its pid is gone.

Cancel and hooks:

- `cmdCancel` writes `cancelled` first (so the close handler in `runTrackedJob` keeps it), then calls `terminateProcessTree(job.pid)`. Nothing Devin wrote is inspected or cleaned.
- `session-lifecycle-hook.mjs` `SessionEnd` (`cleanupSessionJobs`) kills pid-bearing active jobs of the session and marks them `cancelled` via `saveState`. It touches no job files and runs no git.
- `stop-review-gate-hook.mjs` `runStopReview` spawns `task --read-only --sandbox --json` in the caller's cwd and prints a note for running jobs.

Docs and wiring: `commands/rescue.md`, `agents/devin-rescue.md`, and `skills/devin-cli-runtime/SKILL.md` say "default to `--write`" and forward flags to one `task` call whose stdout is returned verbatim. `AGENTS.md`, `README.md`, and `skills/devin/SKILL.md` document `task` as "write-capable by default" with no isolation.

## 3. Proposed behavior

| Invocation | Isolation | Worktree |
| --- | --- | --- |
| `review`, `adversarial-review` | unchanged | no |
| `task --read-only`, or `--permission-mode normal` | unchanged | no |
| `task` (write-capable: `accept-edits`, `smart`, `dangerous`, `autonomous`) | worktree (default in Phase 2; opt-in `--worktree` in Phase 1) | yes |
| `task --in-place` | none, old behavior | no |
| `handoff` | not applicable (cloud) | no |
| stop-review-gate | unchanged (`--read-only --sandbox`) | no |

Rules:

1. Write-capable is decided by the resolved `permissionMode`, not by `--write`.
2. `--in-place` is a routing flag like `--resume`: it must precede the prompt text, the rescue command and subagent forward it untouched, and the subagent never adds it on its own.
3. `--in-place` output starts with `NOTE: --in-place: Devin is editing your checkout directly (no worktree isolation, no apply step).` The job record gets `isolation: "in-place"`, `status` shows it, and the JSON payload carries it.
4. `--in-place` together with `--worktree` is an error.
5. A worktree run ends its stdout with a fixed footer, so the rescue subagent's "return stdout verbatim" contract still reaches the user: `Changes are isolated in branch devin/<suffix> (worktree <path>). Your checkout was not modified. Review: /devin:apply <job-id>`
6. No environment variable or config key flips the default. Only the explicit flag does (consistent with the maintainer's position on env-var unlocks in #2; see open question 3).

New commands: `apply <job-id>` (section 8) and `cleanup [job-id]` (section 9), with Claude slash commands `/devin:apply` and `/devin:cleanup`, both `disable-model-invocation: true`.

## 4. Starting-tree policy

Recommended policy: snapshot-carry. The worktree starts from a snapshot commit `S` of the caller's current working tree (tracked changes, staged or not, plus untracked non-ignored files), taken without modifying the caller's checkout.

Mechanics (all `shell: false`, via `lib/git.mjs`):

1. Preconditions. Each is a refusal with a stable `code` and guidance (commit first, or use `--in-place`):
   - `not_a_git_repository` (section 10).
   - `no_commits`: `git rev-parse --verify HEAD` fails.
   - `submodules_unsupported`: `.gitmodules` exists or the tree has gitlink entries (mode 160000 in `git ls-files -s`). `git worktree add` does not populate submodules.
   - `sparse_checkout_unsupported`: `core.sparseCheckout` is true.
   - `snapshot_too_large`: carried untracked content exceeds 64 MiB in total.
2. `H = git rev-parse HEAD`. If `getWorkingTreeState(cwd).isDirty` is false, `S = H`.
3. Otherwise build `S` with a throwaway index, so the real index, working files, refs, and stash are never touched:
   ```
   GIT_INDEX_FILE=<tmp> git read-tree H
   GIT_INDEX_FILE=<tmp> git add -A          # honors .gitignore
   T = GIT_INDEX_FILE=<tmp> git write-tree
   S = git commit-tree T -p H -m "devin-companion: working-tree snapshot at task start (base <H>)"
   ```
   `commit-tree` is plumbing: no hooks run and no signing is attempted. The commit identity is fixed to `devin-companion <devin-companion@localhost>`; the user is not credited as author.
4. `git worktree add -b devin/<suffix> <path> S`.
5. Record `baseCommit = H` and `startCommit = S` (equal when the tree was clean). Pin `S` with `refs/devin-companion/<suffix>/start` so it survives branch deletion and `git gc`.

Why this policy:

- Rescue is usually invoked mid-work on a dirty tree. Failing on dirty (alternative A) blocks the main use case. Starting from `HEAD` (alternative C) means Devin works on a different tree than the caller is looking at.
- The caller's checkout is never stashed, reset, checked out, or re-indexed, so nothing is moved or discarded.
- The delta is exact: `S -> final` is only what Devin did, not the caller's own pending edits. `apply` needs that to avoid overwriting those edits (section 8).
- Staged versus unstaged is flattened inside `S`. Apply lands changes unstaged, so the caller's index is never rewritten.

Known costs: untracked non-ignored files (possibly secrets) are written as objects in the repo's object database and appear in the branch history (section 12). Ignored files are not carried (open question 4).

Alternatives, rejected:

- A. Fail with guidance when the tree is dirty. Simplest and safest, but blocks the common case. Could be added later as `--require-clean`.
- C. Start from `HEAD` and warn. The warning is easy to miss and the work is done on the wrong tree.
- D. `git stash` the caller's changes and pop them into the worktree. Mutates the caller's checkout.

## 5. Worktree location, naming and lifecycle

Location:

```
<worktree-root>/<slug>-<hash16>/<job-id>/           # the worktree
<state-dir>/worktrees/<job-id>.json                 # metadata (section 6)
<state-dir>/worktrees/<job-id>.patch                # last previewed delta
```

- `<slug>-<hash16>` reuses the `resolveStateDir` scheme (sanitized basename plus sha256 of the repo root realpath).
- `<worktree-root>` is `$CLAUDE_PLUGIN_DATA/worktrees` when set, else `$XDG_DATA_HOME/devin-companion/worktrees` (default `~/.local/share/devin-companion/worktrees`; `%LOCALAPPDATA%\devin-companion\worktrees` on Windows). It must not use the `os.tmpdir()` fallback that state uses: temp directories are reaped by the OS, which would destroy unapplied work.
- Why not under `.git/` (for example `<git-common-dir>/devin-worktrees`): Devin finds its project root by walking up for a `.git` entry (`reference/configuration/global-vs-local.mdx`), and a worktree nested under `.git/` risks resolving to the caller's repository root; many tools also refuse to work inside `.git`. Why not inside the repo: untracked noise that the next snapshot would carry. Why not a sibling of the repo: it litters the project directory and may be cloud-synced.
- Worktree parent directories are created `0700`.
- The stored `path` is the realpath, so `findLatestDevinSession` equality checks hold on macOS (`/var` versus `/private/var`).

Naming:

- `job-id` comes from `generateJobId("devin")` (`devin-<base36 time>-<base36 random>`). The id is the only input to paths and ref names. Nothing is derived from task text, branch names, or other user input.
- Every command that takes a job id validates it against `^devin-[a-z0-9]{1,13}-[a-z0-9]{1,8}$` first, then looks the job up in state. Paths are built from the stored record, never from the argument. Anything else fails with `invalid_job_id`.
- `suffix` is the id without the `devin-` prefix. Branch: `devin/<suffix>`. Pinned refs: `refs/devin-companion/<suffix>/start` and `/final`. Branch names must pass `git check-ref-format --branch`.
- Collisions: if the branch, ref, or directory already exists, regenerate the random part (at most 5 tries), then fail with `worktree_create_failed`. If a branch named exactly `devin` exists, the ref namespaces collide: fail with `branch_namespace_conflict` and guidance. Existing branches and directories are never reused or overwritten.
- After creation, assert `realpath(path)` starts with `realpath(<worktree-root>)` plus a separator.

Lifecycle:

1. Allocate id; write metadata with `state = "creating"`.
2. Run preconditions, build `S`, run `git worktree add`.
3. Metadata becomes `active`; start Devin with `cwd = worktree path`.
4. When the job ends (completed, failed, or cancelled), `finalizeWorktree`:
   - If the worktree has uncommitted changes: `git add -A`, then commit with `-c core.hooksPath=<empty dir>`, no GPG signing, fixed identity, message `devin-companion: snapshot of job <id>`. Hooks are disabled because they are repo-controlled code and this commit is automatic.
   - `F = git rev-parse HEAD` (HEAD may have moved if Devin committed, or be detached). Pin `refs/devin-companion/<suffix>/final`.
   - `state = "no-changes"` if `tree(F) == tree(S)`, else `"pending-apply"`.
   - Idempotent. Also run lazily by `status`, `apply`, and `cleanup` for jobs whose process died before finalizing (see `detectDeadJob`).
5. Apply success sets `applied`; cleanup removes the worktree (section 9).

Nothing is deleted automatically: no expiry, no auto-prune, no removal after an apply failure.

## 6. State model

A `kind: "task"` job record (`<state-dir>/jobs/<id>.json` and the `state.json` entry) gains:

```json
{
  "isolation": "worktree",
  "worktreeId": "devin-lx3k9a-4fq2zk",
  "worktreePath": "/abs/worktrees/repo-1a2b3c4d5e6f7a8b/devin-lx3k9a-4fq2zk",
  "worktreeBranch": "devin/lx3k9a-4fq2zk",
  "worktreeState": "pending-apply"
}
```

`isolation` is `"worktree"`, `"in-place"`, or absent for reviews and read-only tasks. The worktree fields on the job are display copies for `status`. The authoritative record is the per-worktree metadata file `<state-dir>/worktrees/<worktreeId>.json`:

```json
{
  "version": 1,
  "id": "devin-lx3k9a-4fq2zk",
  "repoRoot": "/abs/repo",
  "gitCommonDir": "/abs/repo/.git",
  "path": "/abs/worktrees/repo-1a2b3c4d5e6f7a8b/devin-lx3k9a-4fq2zk",
  "branch": "devin/lx3k9a-4fq2zk",
  "baseBranch": "main",
  "baseCommit": "<H>",
  "startCommit": "<S>",
  "finalCommit": "<F>",
  "carried": { "staged": 1, "unstaged": 2, "untracked": 1 },
  "jobIds": ["devin-lx3k9a-4fq2zk"],
  "devinSessionId": "brisk-otter",
  "state": "pending-apply",
  "deltaId": "3f9a1c07d2e4",
  "createdAt": "<iso>",
  "finalizedAt": "<iso>",
  "appliedAt": null,
  "lastError": null
}
```

Why a separate file: `pruneJobs` (cap 50) and the file GC in `saveState` must never destroy the only record of unapplied work, and `saveState` drops unknown top-level fields. Metadata files are written atomically (tmp plus rename, as `saveState` does) and are not subject to the job cap.

`state` values: `creating`, `active`, `pending-apply`, `no-changes`, `apply-failed`, `applied`, `discarded`, `missing` (path or git admin entry gone; the branch may remain).

Interaction with existing job `status`:

- Job `status` values and `isJobActive` are unchanged. Worktree state is a separate axis, so existing consumers of `status --json` keep working.
- A `completed`, `failed`, or `cancelled` job with a `pending-apply` worktree means "finished, delta not yet applied". Failed and cancelled jobs keep their partial work reviewable.
- `cancel_pending` (#15) is written only by `cancelCloudHandoff` for handoffs, which have no worktree. Local task cancel stays immediate (`cancelled`). Rule for the future: any job for which `isJobActive` is true, including `cancel_pending`, blocks `apply`, `cleanup`, and resume on its worktree. The checks call `isJobActive` on every job in `jobIds` rather than a hard-coded status list.
- `buildJobSnapshot` adds `isolation` and `worktree: { branch, path, state, baseCommit }`. `renderJobDetail` prints them. The `renderStatusReport` footer adds `/devin:apply <job-id>` and `/devin:cleanup`. Table columns do not change.
- `resolveWorkspaceRoot` must map a registered plugin worktree back to its owning repo (realpath under `<worktree-root>` and a metadata file naming `repoRoot`). Otherwise running the companion from inside a worktree, where `git rev-parse --show-toplevel` reports the worktree itself, would resolve a different state directory and show no jobs. Linked worktrees the user created are not remapped, so their behavior is unchanged.

## 7. Resume semantics

Devin sessions belong to a working directory (`devin -c` is "most recent session in the current directory"; `findLatestDevinSession` filters on `working_directory`). A worktree job's Devin session therefore lives under the worktree path, not the repo root. Rules:

- Run Devin with `cwd = worktree path` and call `findLatestDevinSession(worktreePath, ...)`. Because the directory is unique to the job, this attribution is more precise than the shared repo root used today. Store the result in `devinSessionId` on the job and in the metadata.
- Resume continues in the same worktree and branch. A resumed run is a new job record (as today, one `runDevinJob` per run) that reuses the existing `worktreeId` and is appended to `jobIds`. `apply` accepts any job id in the chain and resolves it to the worktree.
- New flag `--resume-job <job-id>`: resolve the job, require its worktree state to be `pending-apply`, `no-changes`, or `apply-failed`, then run with `cwd = worktree path` and `-r <devinSessionId>` (or `-c` if the id was not captured; `-c` is safe there because the directory is unique to the job).
- `--resume` and `--resume-last` in worktree mode pick the newest resumable worktree job of this workspace (preferring the current Claude `sessionId` recorded by `createJobRecord`, the same filter the stop gate uses) and behave like `--resume-job`. If none exists, that is an error with guidance, never a silent fresh run and never a resume in the repo root.
- `--resume-id <session-id>`: look the Devin session id up in worktree metadata. Found: as above. Not found (session created outside the plugin, or by an `--in-place` run): refuse with `resume_target_unknown` and tell the user to pass `--in-place` to resume it where it lives. A foreign session is never resumed from a worktree cwd. `OPEN (Devin CLI)`: Devin documents that resuming from a different directory prompts interactively; the non-interactive `-p` behavior is unverified.
- `task-resume-candidate` consults job state first. It returns `{ available, sessionId, jobId, worktree: { branch, state }, title, lastActivityAgo }` for the newest resumable worktree job, then falls back to today's directory-based lookup for in-place sessions. `commands/rescue.md` keeps its single `AskUserQuestion` flow; "continue" maps to `--resume-job <jobId>`.
- Resume of `applied`, `discarded`, or `missing` worktrees is refused (`missing` points to `cleanup --recover`). After an apply, new work starts from a fresh snapshot.
- A resumed run re-finalizes on exit, so `finalCommit` and `deltaId` change and any earlier preview token becomes invalid (section 8).

## 8. `/devin:apply`

Command: `devin-companion.mjs apply <job-id> [--confirm <deltaId>] [--3way] [--keep] [--full] [--json]`. The slash command `/devin:apply` has `disable-model-invocation: true`.

Phases:

1. Resolve and validate the job id (section 5), load metadata, require that no job in `jobIds` is active, and run `finalizeWorktree` (idempotent). Refuse `applied`, `discarded`, and `missing`. For `no-changes`, print "Devin made no changes" and stop.
2. Preview (the default; no mutation). Compute the delta:
   ```
   git diff --binary --full-index -M <S> <F>   -> saved to <state-dir>/worktrees/<id>.patch
   git diff --numstat --summary -M <S> <F>     -> per-file table
   deltaId = first 12 hex of sha256(patch)
   ```
   Sample output:
   ```
   Devin job devin-lx3k9a-4fq2zk: 5 files, +57 -12   branch devin/lx3k9a-4fq2zk
   Task started from a snapshot of your working tree (base 9f2c1ab on main;
   carried 2 modified and 1 untracked file). Delta id: 3f9a1c07d2e4

     M    src/auth.ts            +30 -4
     A    src/auth.test.ts       +25
     D    src/old.ts             -8
     R    lib/a.ts -> lib/b.ts
     B    assets/logo.png        binary, 12 KB -> 14 KB
     MODE scripts/run.sh         100644 -> 100755

   Checks against your checkout:
     ok       4 paths unchanged since the task started
     blocked  src/auth.ts has uncommitted changes that differ from the task's starting snapshot

   Result: BLOCKED. Nothing has been changed.
   Full patch: <path>   (--full prints it)
   To apply when ok: /devin:apply devin-lx3k9a-4fq2zk --confirm 3f9a1c07d2e4
   ```
   `--json` returns `{ jobId, status: "preview" | "blocked" | "applied" | "conflict", deltaId, files: [{ path, oldPath, kind, binary, additions, deletions, check }], patchPath, nextCommand }`.
3. Apply happens only with `--confirm <deltaId>` matching the freshly computed delta. A stale token (the worktree changed since the preview) is refused and a new preview is printed.

Per-path safety check, computed read-only against the caller's checkout. Let `C` be a snapshot tree of the caller's current working tree, built with the throwaway-index technique from section 4. For each path `P` the patch touches (old and new names):

| Caller's `P` | Class | Action |
| --- | --- | --- |
| identical in `C` and `S` | `ok` | plain apply |
| differs from `S`, but has no uncommitted change (index and working tree equal `HEAD`), for example the caller committed more | `needs-3way` | only with explicit `--3way` |
| differs from `S` and has uncommitted changes, or is untracked | `blocked` | refuse; never overwrite |

Gitlink (submodule) changes and non-regular, non-symlink, non-deletion entries are `blocked`. Patches naming `..` paths, paths under `.git/`, or paths beyond a symlink are expected to be rejected by `git apply`; the tests assert this instead of assuming it.

Mechanics:

- All paths `ok`: `git apply --check --binary --whitespace=nowarn <patch>`, then `git apply --binary <patch>` in the repo root. This touches the working tree only (no `--index`), so the caller's index and staged state are untouched and new files appear untracked. Without `--reject`, `git apply` is all-or-nothing: if any hunk fails, nothing is written. `--reject` is never used.
- `--3way`: allowed only when no path is `blocked`. Runs `git apply --3way --binary <patch>`. This implies `--index`, which requires index and working tree to agree on the touched paths; the `needs-3way` class guarantees that. Conflicts are left as markers in files that had no uncommitted caller edits, so nothing the caller wrote and has not committed can be lost, and `git restore -- <paths>` returns them to their pre-apply state. It exits non-zero with status `conflict` and the conflicted paths.
- Binary files travel in the `--binary` patch and are listed as `B` with sizes, never printed as content. The size limit applies to the preview, not to apply.
- After a successful apply, best-effort verification: rebuild `C'` and confirm the touched paths equal `F`. On mismatch (line-ending filters, `core.autocrlf`) report "applied, but contents differ from the worktree in: ..." instead of claiming success.
- Never stage, commit, or switch branches. The user commits.

Outcomes:

- Success: metadata `applied`, `appliedAt` set, log line written. The worktree directory is removed with `git worktree remove` (no `--force`, so it refuses if anything changed) unless `--keep`. Branch `devin/<suffix>` and both pinned refs remain until `cleanup`.
- Blocked or git failure: nothing changed. Metadata `apply-failed` with `lastError`. The worktree, branch, and refs are kept untouched. Output lists the blocking paths and the ways forward: commit or stash your own edits and re-run, `--3way` where allowed, or inspect `git diff <S> <F>` and `git cherry-pick <S>..<F>` manually.
- Conflict after `--3way`: same retention, plus the conflicted paths. After resolving by hand, the worktree can be applied again only through a fresh preview.
- Applying twice is refused (`already_applied`).

## 9. Cancel, cleanup and recovery

Cancel (`cmdCancel`): behavior is unchanged up to the kill (`cancelled` is persisted first, then `terminateProcessTree`). Added: after the kill, wait up to 3 seconds for the pid to disappear, then run `finalizeWorktree`; if the process is still alive, leave finalization to the lazy path. The worktree is never removed on cancel. The cancel report adds: `Partial changes are kept on branch devin/<suffix>. Review with /devin:apply <job-id>, or discard with /devin:cleanup <job-id>.` A cancelled job with no changes ends as `no-changes`.

SessionEnd hook (`cleanupSessionJobs`): unchanged, and it must not run git (15 second hook budget). Killed jobs keep their worktrees; the next `status`, `apply`, or `cleanup` finalizes them.

Stop gate: review behavior unchanged. `runningTaskNote` also lists worktrees in `pending-apply` or `apply-failed` for the current session ("Devin has unapplied changes in N worktree(s): /devin:apply <job-id>") as a stderr note only.

`cleanup [job-id] [--discard-unapplied] [--orphans] [--recover <job-id>] [--json]`, with `/devin:cleanup` as `disable-model-invocation: true`:

- No arguments: dry run. Lists every worktree record with state, size, age, and branch, flagging `stale` (no activity for 14 days; report only), `missing`, and `orphan`. Mutates nothing.
- `cleanup <job-id>` is allowed when no job in `jobIds` is active and the state is `applied`, `no-changes`, or `discarded`. It removes the worktree (`git worktree remove`), deletes branch `devin/<suffix>` with `git branch -D` (safe here: the delta is applied or empty), deletes both pinned refs and the metadata file, and sets `worktreeState: "discarded"` on the job records.
- States `pending-apply`, `apply-failed`, and `missing` hold unapplied work. They are refused unless `--discard-unapplied` is passed, and the refusal first prints the file counts and `deltaId` that would be lost. This is the only path that discards work, and it is always explicit and per job. There is no bulk "clean everything" flag.
- Missing directory: `git worktree list --porcelain` no longer lists the path, or the path is gone. State becomes `missing`. If the branch still exists, `cleanup --recover <job-id>` runs `git worktree add <path> devin/<suffix>` to recreate it. Work committed by `finalizeWorktree` is intact; uncommitted work in a deleted directory is unrecoverable.
- `git worktree prune` is repo-wide and would also drop the user's own stale worktrees (for example on an unmounted disk). Before pruning, run `git worktree prune --dry-run -v`; prune only if every listed entry lives under `<worktree-root>`, otherwise print the command for the user to run.
- `--orphans`: worktrees under `<worktree-root>` or branches `devin/*` that have no metadata record (state lost, or a crash between lifecycle steps). They are always listed; they are removed only with the flag, and the slash command confirms each entry. A record stuck in `creating` for more than 10 minutes is reported as an orphan.

Recovery summary: the durable artifacts are the branch, the two pinned refs, and the metadata file. Losing `state.json` loses status history but not the ability to apply or clean up, because `worktrees/*.json` is read directly.

## 10. Non-git directories

`resolveWorkspaceRoot` already returns the raw cwd outside a repo, and `ensureGitRepository` throws `This command must run inside a Git repository.`

- Read-only tasks, `setup`, `status`, `result`, `cancel`, and `handoff` behave as today. (`review` already requires a repo.)
- A write-capable `task` outside a Git repository, once worktree is the default, fails with `code: "not_a_git_repository"` and the message: `Worktree isolation needs a Git repository. Run git init and commit, or re-run with --in-place to let Devin edit this directory directly.` There is no silent fallback to in-place: that would defeat the default and hide the lower isolation from agents that cannot see a warning.
- `task --in-place` in a non-git directory works exactly as today and records `isolation: "in-place"`, `isolationReason: "not_a_git_repository"`.
- Missing `git`: `ensureGitRepository` already reports "git is not installed"; same refusal and same `--in-place` guidance.
- `setup` reports worktree readiness: git present, git new enough for `git worktree list --porcelain`, worktree root writable, and the resolved `<worktree-root>`.

## 11. Codex and portable CLI compatibility

The companion CLI is the whole interface (`AGENTS.md`), so the contract lives in flags and JSON, not in slash commands.

- Flags: `task --worktree` (Phase 1 opt-in; no-op alias after Phase 2), `task --in-place`, `task --resume-job <id>`, `apply <id> [--confirm <deltaId>] [--3way] [--keep] [--full]`, `cleanup ...`. All precede free text (`stopAtFirstPositional`).
- `--json`: `task` adds `isolation`, `worktree: { id, path, branch, baseCommit, startCommit, state }`, and `applyCommand`. `apply` and `cleanup` return the shapes in sections 8 and 9. Refusals exit 1 and, with `--json`, also print `{ ok: false, code, message, hint }` on stdout. Stable `code` values: `not_a_git_repository`, `no_commits`, `submodules_unsupported`, `sparse_checkout_unsupported`, `snapshot_too_large`, `branch_namespace_conflict`, `worktree_create_failed`, `invalid_job_id`, `resume_target_unknown`, `apply_blocked`, `apply_conflict`, `already_applied`, `job_active`. Existing exit semantics are unchanged (ordinary failed Devin runs still exit 0, per the decision on #12).
- Non-interactive safety: `apply` without `--confirm` only previews and exits 0. It never prompts, so it cannot hang a Codex or CI run, and it never mutates by default.
- Honest threat model: `--confirm <deltaId>` binds an apply to the exact delta that was previewed and protects against stale or accidental applies. It is not proof of a human decision, because an agent can run the preview and pass the token itself. The human gate is the host. In Claude Code, `/devin:apply` is `disable-model-invocation: true` and asks via `AskUserQuestion` between preview and confirm. In Codex and other agents, `skills/devin/SKILL.md` and `AGENTS.md` instruct: show the preview to the user and get an explicit yes before passing `--confirm`. The docs will not claim more than this. The portable confirmation contract for proposal 6 (cloud handoff) should be reused here once decided (open question 5).
- Docs to update:
  - `AGENTS.md`: `task` row, new `apply` and `cleanup` rows, the "Defaults and safety" bullet, worktree location note, the `--in-place` warning.
  - `skills/devin/SKILL.md`: commands and rules (relay the footer verbatim; never run `apply --confirm` without the user's yes; never pass `--in-place` unprompted).
  - `README.md` and `plugins/devin/README.md`: command table, State section, an FAQ entry "Does Devin edit my files directly?".
  - `llms.txt`. `docs/index.md` is the Pages site and is left to a follow-up.
  - Claude surfaces: `commands/rescue.md` (argument-hint, forwarding rules, resume flow); `agents/devin-rescue.md` and `skills/devin-cli-runtime/SKILL.md` (`--in-place` and `--resume-job` are routing controls, the footer is returned verbatim, the subagent never calls `apply` or `cleanup`); new `commands/apply.md` and `commands/cleanup.md`.
- Windows: worktree root under `%LOCALAPPDATA%`; keep ids short for path length. Devin's sandbox is unsupported on native Windows (#12), so worktree plus `--sandbox` is a WSL2 case.

## 12. Security notes

- A worktree is not a sandbox. In `accept-edits`, `dangerous`, and similar modes Devin can still read and write any path its permission rules allow, including the caller's checkout by absolute path. The worktree only changes where Devin starts and where its edits land by default.
- A linked worktree shares the caller's `.git` (objects, refs, config, hooks directory). A Devin shell command in `dangerous` mode can run `git branch -D main` or edit `.git/hooks` from inside the worktree. Stopping that would need a separate clone and is out of scope; the docs say so plainly.
- No permission weakening. The `buildDevinPrintArgs` output is identical apart from the process `cwd`: same `--permission-mode`, `--sandbox`, and `--respect-workspace-trust` handling, same `env`. The isolation code adds no flag that relaxes anything and never retries without `--sandbox`. A regression test asserts args parity between worktree and in-place runs.
- Sandbox interplay: with `--sandbox`, Devin's writable set is "the workspace directory" plus granted scopes (`sandbox.mdx`). For a worktree the workspace is the worktree directory, so Devin's own `git add` or `git commit` there must write under `<repo>/.git/worktrees/...` and may be blocked. That is acceptable, because the companion commits from outside, but it is `OPEN (Devin CLI)`. Reviews and the stop gate are unchanged.
- Workspace trust: the worktree path is a new directory. Today the unconditional `--respect-workspace-trust false` hides this. If proposal 4 removes that flag, each new worktree could count as an untrusted workspace and `devin -p` would fail there. How Devin keys trust (path, repo root, git common dir) is `OPEN (Devin CLI)` and must be settled together with #4 before Phase 2.
- Path and ref injection: ids are generated, regex-validated on input, looked up in state, and resolved to paths from the stored record. Ref names pass `git check-ref-format`. The worktree path is asserted to be inside `<worktree-root>` after `realpath`. All git calls keep `shell: false`. Task text never reaches a path or ref name.
- Applied patches are untrusted input to the caller's tree. `git apply` is expected to reject `..`, `.git/`, and beyond-symlink paths (asserted by tests), gitlink changes are blocked, and the preview is the review step. Executable-bit and symlink changes are listed as explicit rows.
- Secrets: the snapshot writes untracked non-ignored files into `.git/objects` and into the branch history. `devin/*` branches and `refs/devin-companion/*` must not be pushed; the plugin never pushes, and the docs say so. Worktree parents are `0700`. The companion never prints snapshot contents.
- Automatic commits run with hooks disabled and a fixed non-user identity.
- Cloud `handoff` is untouched. Its automatic attachment of the tracked diff belongs to proposal 6.

## 13. Phased rollout

Phase 1, foundation PR (opt-in; default behavior unchanged):

- `lib/worktree.mjs`: preconditions, snapshot, create, finalize, inspect, remove, recover. `lib/apply.mjs`: delta, per-path checks, preview, apply. `lib/git.mjs`: small helpers only (`shell: false`). `lib/state.mjs`: metadata read and write, id validation. `lib/workspace.mjs`: remap plugin worktrees to the owning repo.
- `devin-companion.mjs`: `task --worktree`, `--in-place` (accepted, no-op), `--resume-job`, `apply`, `cleanup`, extended `task-resume-candidate` and `status` snapshots.
- Docs and slash commands: `commands/apply.md`, `commands/cleanup.md`, flag docs. Rescue docs mention `--worktree` as experimental but do not make it default, and `devin-rescue.md` does not add `--worktree` on its own.
- Tests (node:test; the fake devin fixture extended to log its `pwd`; temp repos created with `git init`):
  - Create, clean tree: branch, path under root, `baseCommit == startCommit`; the caller's HEAD, index tree, `git status --porcelain`, stash list, and all refs are identical before and after.
  - Create, dirty tree (staged, unstaged, untracked, ignored): `S` contains the first three and not the ignored file; the caller's working files, index, and untracked list are unchanged byte for byte.
  - Refusals with codes: non-git, no commits, `.gitmodules`, sparse checkout, oversize snapshot, `devin` branch conflict.
  - Naming and traversal: ids `../x`, `a b`, `-rf`, uppercase, and overlong are rejected; branch passes `check-ref-format`; collision retry and final failure; realpath containment; symlinked worktree root.
  - Spawn parity: fake devin receives `cwd == worktree path` and exactly the args of an in-place run.
  - `--read-only`, `review`, `adversarial-review`, and the stop-gate invocation never call `git worktree` (a git shim records subcommands).
  - Resume: `--resume-job`, `--resume`, and `--resume-id` resolve to the worktree cwd with `-r`; unknown session id refused; applied job refused; session attribution uses the worktree path.
  - State: metadata survives the 50-job cap and `saveState`; `resolveWorkspaceRoot` from inside a worktree maps to the repo; user-created linked worktrees are not remapped.
  - Finalize: snapshot commit with a pre-commit and a post-commit hook that would write a marker file (neither may run); idempotent; detached HEAD and Devin-made commits produce the right `finalCommit`.
  - Cancel: a running task cancelled mid-run keeps worktree and branch and ends `pending-apply` or `no-changes`; the SessionEnd hook removes nothing; a `cancel_pending` handoff job is never a worktree owner; `apply` and `cleanup` refuse while any job in `jobIds` satisfies `isJobActive`.
  - Apply: preview mutates nothing (tree digest before and after); missing or stale `--confirm` refused; clean apply of add, modify, delete, rename, mode change, symlink, and binary (byte-equal round trip); a carried-dirty file that still equals `S` applies; a touched file edited by the caller is `blocked` with the caller's edit intact and zero files changed; `--3way` conflict leaves markers only in previously clean files; applying twice refused; hand-built patches with `../`, `.git/hooks/x`, and beyond-symlink paths rejected; worktree kept and state `apply-failed` on every failure.
  - Cleanup: dry run mutates nothing; unapplied work requires `--discard-unapplied`; a foreign prunable worktree is not pruned; `--recover` re-creates a deleted directory from the branch; orphan listing.
  - `--json` contract snapshots for `task`, `apply`, `cleanup`, and `status`; `surface-wiring.test.mjs` asserts the new slash commands exist with `disable-model-invocation: true` and that docs reference only shipped flags.
  - Windows path handling tested with injected platform where the repo already does so.

Phase 2, default switch (separate PR, after Phase 1 is released and the Devin CLI items below are verified):

- A write-capable `task` uses a worktree unless `--in-place`; `--worktree` becomes a no-op alias; non-git write tasks refuse with guidance.
- `rescue.md`, `devin-rescue.md`, `devin-cli-runtime/SKILL.md`, `AGENTS.md`, `README.md`, `plugins/devin/README.md`, `skills/devin/SKILL.md`, and `llms.txt` updated; minor version bump and a release note calling out the behavior change (edits no longer appear in the checkout until applied).
- Tests: the default flips for a write task with no flag; `--permission-mode accept-edits|smart|dangerous|autonomous` all isolate; `--read-only` and `--permission-mode normal` do not; `--in-place` prints the NOTE banner and sets `isolation`; `--in-place --worktree` errors; non-git refusal and `--in-place` success; rescue command and agent wiring (argument-hint includes `--in-place`; the subagent never emits `apply`, `cleanup`, or `--in-place` on its own); `task-resume-candidate` end to end with the rescue flow; the stop gate still runs in place.

## 14. Open questions for the maintainer

1. Snapshot-carry (section 4) writes the caller's uncommitted and untracked non-ignored files into the repo's object store and the `devin/*` branch history. Is that acceptable, or do you prefer fail-on-dirty (`--require-clean` semantics) as the Phase 1 policy, with carry added later?
2. Worktrees live outside the repo, under `$CLAUDE_PLUGIN_DATA/worktrees` or `~/.local/share/devin-companion/worktrees`, deliberately not in the `os.tmpdir()` fallback that state uses. Is writing to a user-level data directory acceptable for the portable (non-Claude) path?
3. Should there be any persistent, human-only way to change the default back to in-place (for example a config key set only by `/devin:setup` run by the user)? This design says no, only the explicit flag. Given your position on env-var unlocks in #2, please confirm.
4. Gitignored files (`node_modules`, `.env`, build output) are not carried, so Devin cannot run tests that need them inside the worktree. Should a later phase add an opt-in allowlist (symlink or copy), or is "use `--in-place`" the answer for those repos?
5. `apply --confirm <deltaId>` binds to a previewed delta but is not proof of a human decision. Should apply reuse whatever portable confirmation contract is chosen for proposal 6, even if that is stricter (for example, refusing to mutate in noninteractive invocations)?

### Unverified Devin CLI behavior (to test in Phase 1; these are not decisions)

- Whether `devin -p -r <id>` and `devin -p -c` resume correctly when run with `cwd` set to the worktree where the session was created, and what `-p` does when `-r` names a session from another directory (docs: interactive resume from another directory prompts).
- Whether project-root detection (`.git` or `.jj` "directory", `global-vs-local.mdx`) accepts a linked worktree's `.git` file, so that `.devin/`, `AGENTS.md`, rules, and skills load from the worktree.
- Whether workspace trust applies per path, per repo root, or per git common dir, and how a new worktree path interacts with proposal 4.
- Whether `--sandbox` blocks Devin's own git writes under `<repo>/.git/worktrees/...` from inside a worktree.
- Whether `devin list --format json` reports `working_directory` as the worktree realpath on every platform.
