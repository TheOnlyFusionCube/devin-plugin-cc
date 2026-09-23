#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const files = [
  "package.json",
  ".claude-plugin/marketplace.json",
  "plugins/devin/.claude-plugin/plugin.json",
  "plugins/devin/scripts/devin-companion.mjs"
];

for (const file of files) {
  if (!fs.existsSync(path.join(root, file))) {
    console.error(`Missing required file: ${file}`);
    process.exit(1);
  }
}

for (const file of files.filter((f) => f.endsWith(".json"))) {
  JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
}

execFileSync(process.execPath, ["--check", path.join(root, "plugins/devin/scripts/devin-companion.mjs")], { stdio: "inherit" });

console.log("devin-plugin-cc install check passed");
