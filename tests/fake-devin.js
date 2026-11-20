// Fake `devin` CLI for tests, invoked via devin.cmd on Windows.
// Mirrors the POSIX shell fixture: answers version/auth/list/-p.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const marker = path.join(dir, "invocations.jsonl");
const stderrFile = path.join(dir, "stderr.txt");
const config = JSON.parse(fs.readFileSync(path.join(dir, "fixture.json"), "utf8"));

const args = process.argv.slice(2);
fs.appendFileSync(`${marker}.args`, `${args.join(" ")}\n`);
fs.appendFileSync(`${marker}.argv`, `${JSON.stringify(args)}\n`);
const cmd = args[0] || "";

function emit(obj) {
  fs.appendFileSync(marker, `${JSON.stringify(obj)}\n`);
}

if (cmd === "version") {
  console.log("devin 0.0.0-fake (deadbeef)");
} else if (cmd === "auth") {
  if (config.failAuth) {
    console.error("Not logged in");
    process.exit(1);
  }
  if (config.loggedOutExitZero) {
    console.log("Not logged in.");
    console.log("  Credentials path: /Users/fake/.local/share/devin/credentials.toml");
    console.log("Run `devin auth login` to authenticate.");
    process.exit(0);
  }
  console.log("Logged in (via Devin).");
  console.log("  Email:             fake@example.com");
  console.log("  Tier:              Devin Pro");
} else if (cmd === "list") {
  console.log(JSON.stringify([{
    id: "fake-session-1",
    short_id: "fake-session-1",
    working_directory: "FAKECWD",
    last_activity_at: 9999999999,
    title: "fake session",
  }]));
} else if (cmd === "-p") {
  let promptFile = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--prompt-file") promptFile = args[i + 1] || "";
  }
  emit({ prompt_file: promptFile });
  if (promptFile && fs.existsSync(promptFile)) {
    fs.copyFileSync(promptFile, `${marker}.lastprompt`);
  }
  const stderr = fs.existsSync(stderrFile) ? fs.readFileSync(stderrFile, "utf8") : "";
  if (stderr) process.stderr.write(stderr);
  console.log(config.responseText);
  process.exit(config.exitCode);
} else {
  console.log("FAKE_DEVIN_OUTPUT");
}
