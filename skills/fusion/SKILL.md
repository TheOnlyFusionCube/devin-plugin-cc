---
name: fusion
description: Run a frontier-lead Fusion workflow with GPT 6 Astra as lead and Devin as the sidekick for bounded coding work.
---

# Fusion

Run this skill when the user invokes `$fusion`, picks Fusion from the `/skills` picker, or asks for a Fusion workflow.

Lead model: GPT 6 Astra.
Sidekick: Devin through the `devin-companion` runtime. The sidekick defaults to `swe-2-max`; pass `--model <id>` only when the user explicitly requests a different sidekick model.

Fusion keeps the lead responsible for intent, planning, ambiguity, architecture, security decisions, and final review. Use Devin for bounded mechanical, repetitive, or test-heavy work that can be described with complete context and acceptance criteria. Keep product judgment, unclear requirements, and sensitive security decisions in the lead session.

`<PLUGIN_ROOT>` is `plugins/devin` inside a devin-plugin-cc checkout, or the plugin cache dir (`~/.codex/plugins/cache/devin-plugin-cc/devin/<version>`) when installed via `codex plugin add`. Run the sidekick from the repository being changed:

```bash
node <PLUGIN_ROOT>/scripts/devin-companion.mjs task --write "<bounded sidekick task>"
```

The sidekick prompt must include the repository path, relevant files, constraints, and exact verification command. The default `task` mode is `accept-edits`, which cannot execute tests or builds, so run the verification in the lead session after it returns; for work that needs the sidekick to execute commands, pass `--sandbox` (or `--permission-mode` when the user names one). After it returns, inspect the working tree, review the diff, run the relevant checks, and make final integration decisions in the lead session. If the sidekick fails, continue from its output and report the limitation. Do not claim completion without fresh verification.

Do not add a second scheduler, invent a model identifier, or delegate work whose main value is product judgment.
