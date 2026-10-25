// Portions adapted from openai/codex-plugin-cc (Apache-2.0). See NOTICE.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

export function createTempDir(prefix = "devin-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

// Prompts are text typed or piped by a person or a script; 8 MiB is far above any
// realistic prompt and still small enough to hold in memory safely.
export const MAX_STDIN_BYTES = 8 * 1024 * 1024;
const STDIN_CHUNK_BYTES = 64 * 1024;

function isNoDataError(e) {
  return e.code === "EAGAIN" || e.code === "ENXIO";
}

export function readStdinIfPiped(deps = {}) {
  const {
    fstatImpl = fs.fstatSync,
    readSyncImpl = fs.readSync,
    isTTY = process.stdin.isTTY,
    chunkSize = STDIN_CHUNK_BYTES,
    maxBytes = MAX_STDIN_BYTES
  } = deps;
  if (isTTY) {
    return "";
  }
  try {
    const stats = fstatImpl(0);
    if (!stats.isFIFO() && !stats.isFile()) {
      return "";
    }
  } catch (e) {
    if (isNoDataError(e)) {
      return "";
    }
    throw e;
  }
  // Read incrementally so bytes already received survive an EAGAIN from a
  // non-blocking FIFO whose writer is still open.
  const chunks = [];
  let total = 0;
  for (;;) {
    // Ask for one byte past the cap so overflow is detected without truncating.
    const length = Math.min(chunkSize, maxBytes + 1 - total);
    const buffer = Buffer.alloc(length);
    let bytesRead;
    try {
      bytesRead = readSyncImpl(0, buffer, 0, length, null);
    } catch (e) {
      if (isNoDataError(e)) {
        break;
      }
      throw e;
    }
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
    if (total > maxBytes) {
      throw new Error(`stdin input exceeds the ${maxBytes} byte limit.`);
    }
    chunks.push(buffer.subarray(0, bytesRead));
  }
  // Decode once so multi-byte characters split across chunks stay intact.
  return Buffer.concat(chunks).toString("utf8");
}
