---
title: Devin Plugin for Claude Code and Codex
description: Open-source plugin that brings Devin AI code review, task delegation, Fusion sidekick workflows, and cloud handoffs into Claude Code, Codex, and other coding agents.
---

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  "name": "devin-plugin-cc",
  "alternateName": "Devin Plugin for Claude Code and Codex",
  "description": "Devin plugin for Claude Code and Codex: AI code reviews, delegated coding tasks, Fusion sidekick workflows, and cloud handoffs to app.devin.ai.",
  "codeRepository": "https://github.com/TheOnlyFusionCube/devin-plugin-cc",
  "programmingLanguage": "JavaScript",
  "runtimePlatform": "Node.js 18.18+",
  "license": "https://www.apache.org/licenses/LICENSE-2.0",
  "keywords": "devin, devin ai, claude code, codex, claude code plugin, coding agent, ai code review, fusion, agent skills",
  "author": {
    "@type": "Organization",
    "name": "devin-plugin-cc contributors",
    "url": "https://github.com/TheOnlyFusionCube/devin-plugin-cc"
  },
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  }
}
</script>

# Devin Plugin for Claude Code and Codex

`devin-plugin-cc` is an open-source plugin that puts [Devin](https://devin.ai) inside terminal coding workflows: AI code reviews, delegated coding tasks, cloud handoffs to app.devin.ai sessions, and a Fusion workflow where a frontier model leads while Devin handles bounded mechanical work.

**Repository:** [github.com/TheOnlyFusionCube/devin-plugin-cc](https://github.com/TheOnlyFusionCube/devin-plugin-cc)

## What it does

- **AI code review** — read-only review of a working tree or branch diff
- **Adversarial review** — implementation choices, tradeoffs, assumptions, failure modes
- **Task delegation** — bounded coding tasks with resumable sessions and job control
- **Fusion workflow** — Claude Opus 5.5 or GPT 6 Astra leads; Devin is the sidekick
- **Cloud handoff** — open a Devin session carrying repo, branch, context, and uncommitted diff
- **Cross-agent runtime** — one Node CLI drives Claude Code, Codex, OpenCode, Cursor, Gemini CLI, Amp, Jules, Aider, and Devin's own plugin system

## Install

Claude Code:

```bash
claude plugin marketplace add TheOnlyFusionCube/devin-plugin-cc
claude plugin install devin@devin-plugin-cc
```

Codex:

```bash
codex plugin marketplace add TheOnlyFusionCube/devin-plugin-cc
codex plugin add devin@devin-plugin-cc
```

Devin CLI:

```bash
devin plugins install TheOnlyFusionCube/devin-plugin-cc#plugins/devin
```

Portable skills only (any agent):

```bash
npx skills add TheOnlyFusionCube/devin-plugin-cc -a codex -g -s devin -s fusion -y
```

## Frequently asked questions

### What is devin-plugin-cc?

`devin-plugin-cc` is a Claude Code plugin and cross-agent integration that adds Devin AI code review, task delegation, cloud handoffs, and Fusion sidekick workflows to repository-based coding work.

### Does it work with Claude Code and Codex?

Yes. Claude Code installs the `devin` marketplace plugin and exposes `/devin:review`, `/devin:rescue`, `/devin:fusion`, and related commands. Codex installs the same marketplace natively or loads the portable `devin` and `fusion` skills, then invokes Fusion with `$fusion`.

### Does local use require a Devin API key?

No. Local review and task commands use an installed, authenticated Devin CLI. Only cloud handoffs to app.devin.ai require `DEVIN_API_KEY`.

## Links

- [Source on GitHub](https://github.com/TheOnlyFusionCube/devin-plugin-cc)
- [Issues](https://github.com/TheOnlyFusionCube/devin-plugin-cc/issues)
- [llms.txt](https://raw.githubusercontent.com/TheOnlyFusionCube/devin-plugin-cc/main/llms.txt)
- [AGENTS.md](https://github.com/TheOnlyFusionCube/devin-plugin-cc/blob/main/AGENTS.md)
