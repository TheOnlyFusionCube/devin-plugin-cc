#!/usr/bin/env node
// Syntax-check every .mjs/.js/.cjs file in the repo with `node --check`.
// Zero-dependency lint gate: catches parse errors on every OS.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", ".git", "dist", "coverage"]);
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (/\.(mjs|cjs|js)$/.test(entry)) files.push(path);
  }
}
walk(root);

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } catch (err) {
    failed++;
    console.error(`SYNTAX FAIL ${relative(root, file)}`);
    if (err.stderr) console.error(String(err.stderr).trim());
  }
}

if (failed > 0) {
  console.error(`${failed} file(s) failed syntax check`);
  process.exit(1);
}
console.log(`syntax check passed (${files.length} files)`);
