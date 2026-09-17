import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs, splitRawArgumentString } from "../plugins/devin/scripts/lib/args.mjs";

test("parseArgs separates boolean flags, value flags, and positionals", () => {
  const { options, positionals } = parseArgs(
    ["--wait", "--base", "main", "--model=opus", "fix", "the", "tests"],
    { booleanOptions: ["wait"], valueOptions: ["base", "model"] }
  );
  assert.equal(options.wait, true);
  assert.equal(options.base, "main");
  assert.equal(options.model, "opus");
  assert.deepEqual(positionals, ["fix", "the", "tests"]);
});

test("parseArgs treats everything after -- as positional", () => {
  const { options, positionals } = parseArgs(
    ["--wait", "--", "--not-a-flag", "text"],
    { booleanOptions: ["wait"], valueOptions: [] }
  );
  assert.equal(options.wait, true);
  assert.deepEqual(positionals, ["--not-a-flag", "text"]);
});

test("parseArgs throws on missing value", () => {
  assert.throws(
    () => parseArgs(["--base"], { valueOptions: ["base"] }),
    /Missing value for --base/
  );
});

test("stopAtFirstPositional passes flag-like text through verbatim", () => {
  const { options, positionals } = parseArgs(
    ["--read-only", "explain", "the", "--permission-mode", "dangerous", "flag"],
    { booleanOptions: ["read-only"], valueOptions: ["permission-mode"], stopAtFirstPositional: true }
  );
  assert.equal(options["read-only"], true);
  assert.equal(options["permission-mode"], undefined);
  assert.deepEqual(positionals, ["explain", "the", "--permission-mode", "dangerous", "flag"]);
});

test("splitRawArgumentString handles quotes and escapes", () => {
  assert.deepEqual(splitRawArgumentString('--background fix "the flaky test"'), [
    "--background",
    "fix",
    "the flaky test"
  ]);
  assert.deepEqual(splitRawArgumentString("it's fine"), ["its fine"]);
});
