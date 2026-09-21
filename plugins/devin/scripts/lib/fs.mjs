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

export function readStdinIfPiped(deps = {}) {
  const { fstatImpl = fs.fstatSync, readImpl = fs.readFileSync, isTTY = process.stdin.isTTY } = deps;
  if (isTTY) {
    return "";
  }
  try {
    const stats = fstatImpl(0);
    if (!stats.isFIFO() && !stats.isFile()) {
      return "";
    }
  } catch (e) {
    if (e.code === "EAGAIN" || e.code === "ENXIO") {
      return "";
    }
    throw e;
  }
  try {
    return readImpl(0, "utf8");
  } catch (e) {
    if (e.code === "EAGAIN" || e.code === "ENXIO") {
      return "";
    }
    throw e;
  }
}
