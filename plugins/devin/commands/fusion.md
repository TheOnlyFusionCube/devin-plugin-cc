---
description: Run a frontier-lead Fusion workflow with Devin as the sidekick
argument-hint: "[--background|--wait] [--resume|--resume-id <id>|--fresh] [--model <id>] [task]"
allowed-tools: Read, Glob, Grep, Bash(node:*), Agent
---

Run the task below as a Fusion session.

Lead model: Claude Opus 5.5.
Sidekick: Devin through the existing `devin-companion` task runtime. The sidekick defaults to `swe-2-max`; pass `--model <id>` only when the user explicitly requests a different sidekick model.

Fusion rules:

- Keep ownership of intent, planning, ambiguity, architecture, security decisions, and final review.
- Delegate bounded mechanical, repetitive, or test-heavy work with a complete prompt and explicit acceptance criteria.
- Keep work that depends on product judgment, unclear requirements, or sensitive security decisions in the lead session.
- Give the sidekick the repository path, relevant files, constraints, and the exact verification command.
- After the sidekick returns, inspect the working tree, review its diff, run the relevant checks, and make any final integration decisions yourself.
- If the sidekick cannot complete the work, continue from its output and report the limitation. Do not claim completion without verification.

Invoke the `devin:devin-rescue` subagent once for the sidekick handoff when delegation is useful. Preserve the user's task and routing flags. Do not invent a second Fusion scheduler or a new model identifier.

User task:

$ARGUMENTS
