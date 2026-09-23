---
description: Run a frontier-lead Fusion workflow with Devin as the sidekick
argument-hint: "[--background|--wait] [--resume|--resume-id <id>|--fresh] [--model <id>] [--permission-mode <mode>] [task]"
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), Bash(npm:*), Agent
---

Run the task below as a Fusion session.

Lead model: Claude Opus 5.5.
Sidekick: Devin through the existing `devin-companion` task runtime. The sidekick defaults to `swe-2-max`; pass `--model <id>` only when the user explicitly requests a different sidekick model.

Fusion rules:

- Keep ownership of intent, planning, ambiguity, architecture, security decisions, and final review.
- Delegate bounded mechanical, repetitive, or test-heavy work with a complete prompt and explicit acceptance criteria.
- Keep work that depends on product judgment, unclear requirements, or sensitive security decisions in the lead session.
- Give the sidekick the repository path, relevant files, constraints, and the exact verification command. The sidekick's default `task` mode is `accept-edits`, which cannot run shell commands; you run the verification yourself after it returns.
- After the sidekick returns, inspect the working tree, review its diff, run the relevant checks, and make any final integration decisions yourself.
- If the sidekick cannot complete the work, continue from its output and report the limitation. Do not claim completion without verification.

Invoke the `devin:devin-rescue` subagent for each sidekick handoff when delegation is useful, once per delegation. Preserve the user's task and routing flags. Do not invent a second Fusion scheduler or a new model identifier.

Execution mode:

- If the request includes `--background`, run the sidekick subagent in the background.
- If the request includes `--wait`, run it in the foreground. Default to foreground when neither flag is present.
- `--background` and `--wait` are execution flags for Claude Code. Do not forward them to `task`, and do not treat them as part of the natural-language task text.
- `--model` and `--permission-mode` are runtime-selection flags for the sidekick's `task` call. Preserve them for the forwarded call, but do not treat them as part of the natural-language task text.

User task:

$ARGUMENTS
