import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("package install surface is wired", () => {
  const packageJson = JSON.parse(read("package.json"));
  const workflow = read(".github/workflows/ci.yml");

  assert.equal(packageJson.version, "1.0.1");
  assert.equal(packageJson.scripts.prepare, "node scripts/install.mjs");
  assert.equal(packageJson.scripts.doctor, "node plugins/devin/scripts/devin-companion.mjs setup");
  assert.equal(packageJson.bin["devin-companion"], "./plugins/devin/scripts/devin-companion.mjs");
  assert.match(workflow, /npm install/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run doctor/);
});

test("Fusion surfaces preserve each host's lead model and shared sidekick", () => {
  const claude = read("plugins/devin/commands/fusion.md");
  const codex = read("skills/fusion/SKILL.md");

  assert.match(claude, /Lead model: Claude Opus 5\.5/);
  assert.match(claude, /devin:devin-rescue/);
  assert.match(claude, /swe-2-max/);
  assert.match(codex, /Lead model: GPT 6 Astra/);
  assert.match(codex, /devin-companion\.mjs task --write/);
  assert.match(codex, /swe-2-max/);
});

test("SEO surfaces describe the shipped cross-agent capabilities", () => {
  const packageJson = JSON.parse(read("package.json"));
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const plugin = JSON.parse(read("plugins/devin/.claude-plugin/plugin.json"));
  const readme = read("README.md");
  const llms = read("llms.txt");

  for (const keyword of ["codex", "codex-cli", "agent-skills", "fusion", "developer-tools"]) {
    assert.ok(packageJson.keywords.includes(keyword), `missing npm keyword: ${keyword}`);
  }
  assert.match(readme, /^# Devin Plugin for Claude Code and Codex/m);
  assert.match(readme, /Frequently asked questions/);
  assert.match(llms, /Claude Code and Codex/);
  assert.match(llms, /skills\/fusion\/SKILL\.md/);
  assert.match(marketplace.metadata.description, /Claude Code and Codex/);
  assert.match(plugin.description, /Fusion sidekick workflows/);
});
