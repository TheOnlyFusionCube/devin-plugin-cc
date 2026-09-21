import assert from "node:assert/strict";
import test from "node:test";

import { isOnboardingOutput } from "../plugins/devin/scripts/lib/devin.mjs";

test("isOnboardingOutput matches welcome screen with ANSI codes", () => {
  const withAnsi = "\x1b[1mWelcome to Devin CLI!\x1b[0m\n \x1b[32m✓\x1b[0m Logged in as someone@example.com.\nYou're all set. Run devin to get started.";
  assert.equal(isOnboardingOutput(withAnsi), true);
});

test("isOnboardingOutput matches welcome screen without ANSI codes", () => {
  const withoutAnsi = "Welcome to Devin CLI!\n ✓ Logged in as someone@example.com.\nYou're all set. Run devin to get started.";
  assert.equal(isOnboardingOutput(withoutAnsi), true);
});

test("isOnboardingOutput does not match normal review output", () => {
  const reviewOutput = "## Verdict\nAPPROVE\n\nThe changes look good.";
  assert.equal(isOnboardingOutput(reviewOutput), false);
});

test("isOnboardingOutput does not match partial welcome patterns", () => {
  const partial = "Welcome to Devin CLI!\nSome other text here.";
  assert.equal(isOnboardingOutput(partial), false);
});

test("isOnboardingOutput does not match empty output", () => {
  assert.equal(isOnboardingOutput(""), false);
});

test("isOnboardingOutput is case-insensitive for key phrases", () => {
  const mixedCase = "WELCOME TO DEVIN CLI!\n ✓ LOGGED IN AS someone@example.com.\nYou're all set. Run devin to get started.";
  assert.equal(isOnboardingOutput(mixedCase), true);
});
