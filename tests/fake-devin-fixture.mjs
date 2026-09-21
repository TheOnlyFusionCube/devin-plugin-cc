import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Creates a fake `devin` executable that answers the subcommands the companion
// uses. The marker file records each -p invocation's prompt file for assertions.
export function createFakeDevin({ responseText = "FAKE_DEVIN_OUTPUT", exitCode = 0, failAuth = false, loggedOutExitZero = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-devin-"));
  const marker = path.join(dir, "invocations.jsonl");
  const script = `#!/usr/bin/env bash
set -euo pipefail
marker="${marker}"
echo "$@" >> "\${marker}.args"
cmd="\${1:-}"
case "$cmd" in
  version)
    echo "devin 0.0.0-fake (deadbeef)"
    ;;
  auth)
    if [ "${failAuth}" = "true" ]; then
      echo "Not logged in" >&2
      exit 1
    fi
    if [ "${loggedOutExitZero}" = "true" ]; then
      echo "Not logged in."
      echo "  Credentials path: /Users/fake/.local/share/devin/credentials.toml"
      echo "Run \\\`devin auth login\\\` to authenticate."
      exit 0
    fi
    echo "Logged in (via Devin)."
    echo "  Email:             fake@example.com"
    echo "  Tier:              Devin Pro"
    ;;
  list)
    cat <<'JSON'
[{"id":"fake-session-1","short_id":"fake-session-1","working_directory":"FAKECWD","last_activity_at":9999999999,"title":"fake session"}]
JSON
    ;;
  -p)
    prompt_file=""
    prev=""
    for arg in "$@"; do
      if [ "$prev" = "--prompt-file" ]; then prompt_file="$arg"; fi
      prev="$arg"
    done
    echo "{\\"prompt_file\\":\\"$prompt_file\\"}" >> "$marker"
    if [ -n "$prompt_file" ] && [ -f "$prompt_file" ]; then
      cp "$prompt_file" "\${marker}.lastprompt"
    fi
    echo "${responseText}"
    exit ${exitCode}
    ;;
  *)
    echo "FAKE_DEVIN_OUTPUT"
    ;;
esac
`;
  const binPath = path.join(dir, "devin");
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return {
    dir,
    binPath,
    marker,
    env: { DEVIN_COMPANION_DEVIN_BINARY: binPath },
    invocations() {
      if (!fs.existsSync(marker)) {
        return [];
      }
      return fs.readFileSync(marker, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    },
    lastPrompt() {
      return fs.existsSync(`${marker}.lastprompt`) ? fs.readFileSync(`${marker}.lastprompt`, "utf8") : null;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

export function createTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-plugin-test-"));
  return {
    dir,
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}
