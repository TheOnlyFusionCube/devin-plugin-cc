import assert from "node:assert/strict";
import test from "node:test";

import { readStdinIfPiped } from "../plugins/devin/scripts/lib/fs.mjs";

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
