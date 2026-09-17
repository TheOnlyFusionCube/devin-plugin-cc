// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import { ensureGitRepository } from "./git.mjs";

export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
