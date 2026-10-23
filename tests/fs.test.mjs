import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readStdinIfPiped } from "../plugins/devin/scripts/lib/fs.mjs";

const FS_MODULE = fileURLToPath(new URL("../plugins/devin/scripts/lib/fs.mjs", import.meta.url));

test("readStdinIfPiped returns empty string when isTTY is true", () => {
  const result = readStdinIfPiped({ isTTY: true });
  assert.equal(result, "");
});

test("readStdinIfPiped reads content from FIFO", () => {
  const mockStats = {
    isFIFO: () => true,
    isFile: () => false
  };
  const mockRead = () => "hello from pipe";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => mockStats,
    readImpl: mockRead
  });
  assert.equal(result, "hello from pipe");
});

test("readStdinIfPiped reads content from regular file", () => {
  const mockStats = {
    isFIFO: () => false,
    isFile: () => true
  };
  const mockRead = () => "hello from file";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => mockStats,
    readImpl: mockRead
  });
  assert.equal(result, "hello from file");
});

test("readStdinIfPiped returns empty string for non-FIFO/non-file (socket)", () => {
  const mockStats = {
    isFIFO: () => false,
    isFile: () => false
  };
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => mockStats,
    readImpl: () => "should not be called"
  });
  assert.equal(result, "");
});

test("readStdinIfPiped returns empty string when fstat throws EAGAIN", () => {
  const error = new Error("EAGAIN: resource temporarily unavailable");
  error.code = "EAGAIN";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => { throw error; },
    readImpl: () => "should not be called"
  });
  assert.equal(result, "");
});

test("readStdinIfPiped returns empty string when fstat throws ENXIO", () => {
  const error = new Error("ENXIO: no such device or address");
  error.code = "ENXIO";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => { throw error; },
    readImpl: () => "should not be called"
  });
  assert.equal(result, "");
});

test("readStdinIfPiped returns empty string when read throws EAGAIN", () => {
  const mockStats = {
    isFIFO: () => true,
    isFile: () => false
  };
  const error = new Error("EAGAIN: resource temporarily unavailable");
  error.code = "EAGAIN";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => mockStats,
    readImpl: () => { throw error; }
  });
  assert.equal(result, "");
});

test("readStdinIfPiped returns empty string when read throws ENXIO", () => {
  const mockStats = {
    isFIFO: () => true,
    isFile: () => false
  };
  const error = new Error("ENXIO: no such device or address");
  error.code = "ENXIO";
  const result = readStdinIfPiped({
    isTTY: false,
    fstatImpl: () => mockStats,
    readImpl: () => { throw error; }
  });
  assert.equal(result, "");
});

test("readStdinIfPiped throws non-EAGAIN/ENXIO errors from fstat", () => {
  const error = new Error("EPERM: operation not permitted");
  error.code = "EPERM";
  assert.throws(
    () => readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => { throw error; },
      readImpl: () => "should not be called"
    }),
    { code: "EPERM" }
  );
});

test("readStdinIfPiped throws non-EAGAIN/ENXIO errors from read", () => {
  const mockStats = {
    isFIFO: () => true,
    isFile: () => false
  };
  const error = new Error("EACCES: permission denied");
  error.code = "EACCES";
  assert.throws(
    () => readStdinIfPiped({
      isTTY: false,
      fstatImpl: () => mockStats,
      readImpl: () => { throw error; }
    }),
    { code: "EACCES" }
  );
});

// End-to-end repro without mocks: fd 0 is the read end of a FIFO whose
// O_NONBLOCK flag is set and whose writer is open but silent, which is what
// the Claude Code Bash tool hands to child processes.
test("readStdinIfPiped returns empty string for a non-blocking FIFO with no data", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-stdin-"));
  const fifo = path.join(dir, "stdin");
  let readFd;
  let writeFd;
  try {
    execFileSync("mkfifo", [fifo]);
    readFd = fs.openSync(fifo, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    writeFd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    const script = `import(${JSON.stringify(FS_MODULE)}).then((m) => process.stdout.write(JSON.stringify(m.readStdinIfPiped())));`;
    const result = spawnSync(process.execPath, ["-e", script], {
      stdio: [readFd, "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '""');
  } finally {
    if (readFd !== undefined) fs.closeSync(readFd);
    if (writeFd !== undefined) fs.closeSync(writeFd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
