import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MAX_STDIN_BYTES, readStdinIfPiped } from "../plugins/devin/scripts/lib/fs.mjs";

const FS_MODULE = fileURLToPath(new URL("../plugins/devin/scripts/lib/fs.mjs", import.meta.url));

test("readStdinIfPiped returns empty string when isTTY is true", () => {
  const result = readStdinIfPiped({ isTTY: true });
  assert.equal(result, "");
});

const FIFO_STATS = { isFIFO: () => true, isFile: () => false };
const FILE_STATS = { isFIFO: () => false, isFile: () => true };

function errnoError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

// Fake readSync that serves the given steps in order: a Buffer or string is
// copied into the caller's buffer (at most `length` bytes, the rest is kept for
// the next call), an Error is thrown, and an exhausted script reports EOF.
function scriptedRead(steps) {
  const queue = steps.map((step) => (typeof step === "string" ? Buffer.from(step) : step));
  return (fd, buffer, offset, length) => {
    assert.equal(fd, 0);
    if (queue.length === 0) {
      return 0;
    }
    const step = queue.shift();
    if (step instanceof Error) {
      throw step;
    }
    const n = Math.min(length, step.length);
    step.copy(buffer, offset, 0, n);
    if (n < step.length) {
      queue.unshift(step.subarray(n));
    }
    return n;
  };
}

test("readStdinIfPiped reads content from FIFO", () => {
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => FIFO_STATS,
    readSyncImpl: scriptedRead(["hello from pipe"])
  });
  assert.equal(result, "hello from pipe");
});

test("readStdinIfPiped reads content from regular file", () => {
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => FILE_STATS,
    readSyncImpl: scriptedRead(["hello from file"])
  });
  assert.equal(result, "hello from file");
});

test("readStdinIfPiped returns empty string for non-FIFO/non-file (socket)", () => {
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => ({ isFIFO: () => false, isFile: () => false }),
    readSyncImpl: () => { throw new Error("should not be called"); }
  });
  assert.equal(result, "");
});

for (const code of ["EAGAIN", "ENXIO"]) {
  test(`readStdinIfPiped returns empty string when fstat throws ${code}`, () => {
    const result = readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => { throw errnoError(code, "no data"); },
      readSyncImpl: () => { throw new Error("should not be called"); }
    });
    assert.equal(result, "");
  });

  test(`readStdinIfPiped returns empty string when the first read throws ${code}`, () => {
    const result = readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => FIFO_STATS,
      readSyncImpl: scriptedRead([errnoError(code, "no data")])
    });
    assert.equal(result, "");
  });

  test(`readStdinIfPiped keeps bytes already read when a later read throws ${code}`, () => {
    const result = readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => FIFO_STATS,
      readSyncImpl: scriptedRead(["PROMPT ", "DATA\n", errnoError(code, "no more data yet")])
    });
    assert.equal(result, "PROMPT DATA\n");
  });
}

test("readStdinIfPiped throws non-EAGAIN/ENXIO errors from fstat", () => {
  assert.throws(
    () => readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => { throw errnoError("EPERM", "operation not permitted"); },
      readSyncImpl: () => { throw new Error("should not be called"); }
    }),
    { code: "EPERM" }
  );
});

test("readStdinIfPiped throws non-EAGAIN/ENXIO errors from read, even after data", () => {
  assert.throws(
    () => readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => FIFO_STATS,
      readSyncImpl: scriptedRead(["partial", errnoError("EACCES", "permission denied")])
    }),
    { code: "EACCES" }
  );
});

test("readStdinIfPiped joins multiple chunks and honors chunkSize", () => {
  const lengths = [];
  const inner = scriptedRead(["0123456789abcdefghij"]);
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => FIFO_STATS,
    chunkSize: 6,
    readSyncImpl: (fd, buffer, offset, length, position) => {
      lengths.push(length);
      return inner(fd, buffer, offset, length, position);
    }
  });
  assert.equal(result, "0123456789abcdefghij");
  assert.ok(lengths.every((length) => length <= 6), `unexpected read sizes: ${lengths}`);
  assert.ok(lengths.length >= 4);
});

test("readStdinIfPiped decodes multi-byte UTF-8 split across chunks", () => {
  const text = "h\u00e9llo \u2713 \u{1F600}\n";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => FIFO_STATS,
    chunkSize: 1,
    readSyncImpl: scriptedRead([text])
  });
  assert.equal(result, text);
});

test("readStdinIfPiped accepts input of exactly maxBytes", () => {
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => FIFO_STATS,
    chunkSize: 4,
    maxBytes: 10,
    readSyncImpl: scriptedRead(["0123456789"])
  });
  assert.equal(result, "0123456789");
});

test("readStdinIfPiped throws a clear error when input exceeds maxBytes", () => {
  assert.throws(
    () => readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => FIFO_STATS,
      chunkSize: 4,
      maxBytes: 10,
      readSyncImpl: scriptedRead(["0123456789X"])
    }),
    /stdin input exceeds the 10 byte limit/
  );
});

test("MAX_STDIN_BYTES is a positive default cap", () => {
  assert.ok(Number.isInteger(MAX_STDIN_BYTES) && MAX_STDIN_BYTES >= 1024 * 1024);
});

// End-to-end tests without mocks: fd 0 is the read end of a FIFO whose
// O_NONBLOCK flag is set and whose writer stays open, which is what the Claude
// Code Bash tool hands to child processes. `payload` is written before the
// child starts; `options` is the argument passed to readStdinIfPiped.
function readFromOpenFifo(payload, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-stdin-"));
  const fifo = path.join(dir, "stdin");
  let readFd;
  let writeFd;
  try {
    execFileSync("mkfifo", [fifo]);
    readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    writeFd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    if (payload !== undefined) {
      const bytes = Buffer.from(payload, "utf8");
      assert.equal(fs.writeSync(writeFd, bytes), bytes.length);
    }
    const script = `import(${JSON.stringify(FS_MODULE)}).then((m) => process.stdout.write(JSON.stringify(m.readStdinIfPiped(${JSON.stringify(options)}))));`;
    const result = spawnSync(process.execPath, ["-e", script], {
      stdio: [readFd, "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  } finally {
    if (readFd !== undefined) fs.closeSync(readFd);
    if (writeFd !== undefined) fs.closeSync(writeFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const skipWin32 = { skip: process.platform === "win32" };

test("readStdinIfPiped returns empty string for a non-blocking FIFO with no data", skipWin32, () => {
  assert.equal(readFromOpenFifo(undefined), "");
});

test("readStdinIfPiped returns bytes already in a non-blocking FIFO whose writer is still open", skipWin32, () => {
  assert.equal(readFromOpenFifo("PROMPT DATA\n"), "PROMPT DATA\n");
});

test("readStdinIfPiped returns multi-byte UTF-8 from an open non-blocking FIFO", skipWin32, () => {
  assert.equal(readFromOpenFifo("h\u00e9llo \u2713\n"), "h\u00e9llo \u2713\n");
});

test("readStdinIfPiped reads a payload spanning several chunks from an open non-blocking FIFO", skipWin32, () => {
  // 7-byte chunks split the 2- and 3-byte characters at awkward offsets; the
  // payload stays far below the OS pipe buffer so the writer never hits EAGAIN.
  const payload = `${"line of text \u2713 h\u00e9llo\n".repeat(8)}end\n`;
  assert.ok(Buffer.byteLength(payload) > 150 && Buffer.byteLength(payload) < 1024);
  assert.equal(readFromOpenFifo(payload, { chunkSize: 7 }), payload);
});
