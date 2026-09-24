import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const exists = (relativePath) => fs.existsSync(path.join(root, relativePath));

test("package install surface is wired", () => {
  const packageJson = JSON.parse(read("package.json"));
  const workflow = read(".github/workflows/ci.yml");

  assert.equal(packageJson.scripts.prepare, "node scripts/install.mjs");
  assert.equal(packageJson.scripts.doctor, "node plugins/devin/scripts/devin-companion.mjs setup");
  const binTargets = Object.values(packageJson.bin);
  assert.equal(binTargets.length, 1);
  assert.ok(exists(binTargets[0]), `bin target missing: ${binTargets[0]}`);
  assert.match(workflow, /npm ci|npm install/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /npm run doctor/);
});

test("version is consistent across all manifests", () => {
  const packageJson = JSON.parse(read("package.json"));
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const pluginManifests = [
    "plugins/devin/.claude-plugin/plugin.json",
    "plugins/devin/.codex-plugin/plugin.json",
    "skills/fusion/.claude-plugin/plugin.json",
    "skills/fusion/.codex-plugin/plugin.json",
    "skills/devin/.claude-plugin/plugin.json",
    "skills/devin/.codex-plugin/plugin.json",
  ];

  assert.equal(marketplace.metadata.version, packageJson.version);
  for (const entry of marketplace.plugins) {
    assert.equal(entry.version, packageJson.version);
    assert.ok(exists(entry.source), `marketplace source missing: ${entry.source}`);
    const manifest = JSON.parse(read(`${entry.source}/.claude-plugin/plugin.json`));
    assert.equal(manifest.version, packageJson.version, `${entry.name} manifest version`);
    assert.equal(manifest.name, entry.name, `${entry.name} manifest name`);
  }
  for (const manifestPath of pluginManifests) {
    assert.equal(JSON.parse(read(manifestPath)).version, packageJson.version, manifestPath);
  }
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
  assert.match(codex, /\$fusion/);
  assert.doesNotMatch(codex, /`\/fusion`/);
});

test("documented capabilities match shipped surfaces and referenced files exist", () => {
  const packageJson = JSON.parse(read("package.json"));
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  const plugin = JSON.parse(read("plugins/devin/.claude-plugin/plugin.json"));
  const readme = read("README.md");
  const llms = read("llms.txt");

  for (const keyword of ["codex", "codex-cli", "agent-skills", "fusion", "developer-tools"]) {
    assert.ok(packageJson.keywords.includes(keyword), `missing npm keyword: ${keyword}`);
  }
  assert.match(packageJson.description, /Claude Code and Codex/);
  assert.match(marketplace.metadata.description, /Claude Code and Codex/);
  assert.match(plugin.description, /Fusion sidekick workflows/);
  assert.match(readme, /^# .*Claude Code and Codex/m);

  // The Codex install path must select only the two public skills.
  assert.match(readme, /-s devin -s fusion/);
  assert.doesNotMatch(readme, /-s '\*'/);

  // The Devin CLI install path uses the plugin subdir of the marketplace repo.
  assert.match(readme, /devin plugins install TheOnlyFusionCube\/devin-plugin-cc#plugins\/devin/);

  // README links to the machine-readable entry point and the CI workflow.
  assert.match(readme, /\[llms\.txt\]\(llms\.txt\)/);
  assert.match(readme, /actions\/workflows\/ci\.yml\/badge\.svg/);

  // Every relative link in llms.txt resolves to a real file.
  for (const [, href] of llms.matchAll(/\]\(([^)]+)\)/g)) {
    if (!href.startsWith("http")) {
      assert.ok(exists(href), `llms.txt links to missing file: ${href}`);
    }
  }
});
