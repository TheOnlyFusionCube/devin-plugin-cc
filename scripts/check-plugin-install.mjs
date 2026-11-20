#!/usr/bin/env node
// Exercise the marketplace's ./plugins/devin source independently of the repo root.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "plugins", "devin");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devin-plugin-isolated-"));
const pluginRoot = path.join(temporaryRoot, "plugin");

function checked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: pluginRoot,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
    ...options
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`);
  return result;
}

try {
  // Copy only the installable plugin, not the parent package.json or node_modules.
  fs.cpSync(source, pluginRoot, { recursive: true, filter: (entry) => path.basename(entry) !== "node_modules" });
  assert.ok(fs.existsSync(path.join(pluginRoot, "package-lock.json")));
  checked(process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]);
  const { runCommand } = await import(pathToFileURL(path.join(pluginRoot, "scripts", "lib", "process.mjs")).href);
  const probe = runCommand(process.execPath, ["-e", "process.stdout.write('isolated-ok')"]);
  assert.ifError(probe.error);
  assert.equal(probe.status, 0);
  assert.equal(probe.stdout, "isolated-ok");
  const companion = checked(process.execPath, [path.join(pluginRoot, "scripts", "devin-companion.mjs"), "setup", "--json"]);
  const report = JSON.parse(companion.stdout);
  assert.equal(typeof report.ready, "boolean");
  console.log("isolated marketplace plugin install passed");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
