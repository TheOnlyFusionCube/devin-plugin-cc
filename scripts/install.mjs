#!/usr/bin/env node

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

console.log("devin-plugin-cc install check passed");
