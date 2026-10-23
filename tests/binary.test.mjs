import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeDevin, createTempRepo } from "./fake-devin-fixture.mjs";
import {
  DESKTOP_BINARY_CANDIDATE,
  DESKTOP_CANDIDATE_ENV,
  resolveDevinBinary
} from "../plugins/devin/scripts/lib/devin.mjs";
import { renderSetupReport } from "../plugins/devin/scripts/lib/render.mjs";

const COMPANION = fileURLToPath(new URL("../plugins/devin/scripts/devin-companion.mjs", import.meta.url));

function makeDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

// A PATH directory holding only the tools the fake devin script and the companion need,
// so a real devin installed on the host machine can never be found.
function makeToolOnlyPath() {
  const dir = makeDir("devin-tool-path-");
  for (const tool of ["bash", "cat", "cp", "git"]) {
    for (const hostDir of (process.env.PATH ?? "").split(path.delimiter)) {
      const candidate = path.join(hostDir, tool);
      if (hostDir && fs.existsSync(candidate)) {
        fs.symlinkSync(candidate, path.join(dir, tool));
        break;
      }
    }
  }
  return dir;
}

function makeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return file;
}

test("explicit DEVIN_COMPANION_DEVIN_BINARY wins over PATH and the app bundle", () => {
  const root = makeDir("devin-resolve-");
  try {
    const onPath = makeExecutable(path.join(root, "bin", "devin"));
    const bundle = makeExecutable(path.join(root, "bundle", "devin"));
    const resolved = resolveDevinBinary({
      env: { DEVIN_COMPANION_DEVIN_BINARY: "/custom/devin", PATH: path.dirname(onPath) },
      platform: "darwin",
      candidates: [bundle]
    });
    assert.deepEqual(resolved, { path: "/custom/devin", source: "env" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("devin on PATH beats the app bundle", () => {
  const root = makeDir("devin-resolve-");
  try {
    const onPath = makeExecutable(path.join(root, "bin", "devin"));
    const bundle = makeExecutable(path.join(root, "bundle", "devin"));
    const resolved = resolveDevinBinary({
      env: { PATH: [path.join(root, "empty"), path.dirname(onPath)].join(path.delimiter) },
      platform: "darwin",
      candidates: [bundle]
    });
    assert.deepEqual(resolved, { path: onPath, source: "path" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Desktop-only install selects the app bundle and uses its realpath", () => {
  const root = makeDir("devin-resolve-");
  try {
    const real = makeExecutable(path.join(root, "real", "devin"));
    const link = path.join(root, "Devin.app", "devin");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(real, link);
    const resolved = resolveDevinBinary({
      env: { PATH: path.join(root, "empty") },
      platform: "darwin",
      candidates: [link]
    });
    assert.deepEqual(resolved, { path: real, source: "desktop" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("app bundle candidate is ignored off macOS", () => {
  const root = makeDir("devin-resolve-");
  try {
    const bundle = makeExecutable(path.join(root, "bundle", "devin"));
    for (const platform of ["linux", "freebsd"]) {
      assert.equal(resolveDevinBinary({ env: { PATH: "" }, platform, candidates: [bundle] }), null);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("non-executable files and directories are skipped", () => {
  const root = makeDir("devin-resolve-");
  try {
    const plainFile = path.join(root, "plain", "devin");
    fs.mkdirSync(path.dirname(plainFile), { recursive: true });
    fs.writeFileSync(plainFile, "not executable", { mode: 0o644 });
    const dirNamedDevin = path.join(root, "dirbin", "devin");
    fs.mkdirSync(dirNamedDevin, { recursive: true });
    const bundleDir = path.join(root, "bundle-dir");
    fs.mkdirSync(bundleDir);
    const good = makeExecutable(path.join(root, "good", "devin"));

    const env = { PATH: [path.dirname(plainFile), path.dirname(dirNamedDevin)].join(path.delimiter) };
    assert.equal(resolveDevinBinary({ env, platform: "darwin", candidates: [plainFile, bundleDir] }), null);
    assert.deepEqual(
      resolveDevinBinary({ env, platform: "darwin", candidates: [plainFile, bundleDir, good] }),
      { path: good, source: "desktop" }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("nothing found returns null", () => {
  assert.equal(resolveDevinBinary({ env: { PATH: "" }, platform: "darwin", candidates: ["/nonexistent/devin"] }), null);
});

test("the default app-bundle candidate is the documented macOS path", () => {
  assert.equal(
    DESKTOP_BINARY_CANDIDATE,
    "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"
  );
});

test("setup guidance for a missing CLI mentions Devin Desktop", () => {
  const text = renderSetupReport({
    ready: false,
    devin: { installed: false, path: null, source: null, authenticated: false, authDetail: "devin not installed" },
    cloud: { available: false },
    git: { available: true },
    config: { stopReviewGate: false }
  });
  assert.match(text, /NOT FOUND/);
  assert.match(text, /Devin Desktop/);
});

function runSetup(env, cwd) {
  const result = spawnSync(process.execPath, [COMPANION, "setup", "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, DEVIN_COMPANION_DEVIN_BINARY: "", ...env },
    timeout: 30000
  });
  return { result, report: result.stdout ? JSON.parse(result.stdout) : null };
}

test("setup reports not installed when no devin is reachable", () => {
  const repo = createTempRepo();
  const emptyPath = makeDir("devin-empty-path-");
  try {
    const { result, report } = runSetup({ PATH: emptyPath, [DESKTOP_CANDIDATE_ENV]: path.join(emptyPath, "missing") }, repo.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.devin.installed, false);
    assert.equal(report.devin.path, null);
    assert.equal(report.ready, false);
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
    repo.cleanup();
  }
});

test("Desktop-only machine: setup and task use the app-bundle binary", () => {
  const repo = createTempRepo();
  const fake = createFakeDevin({ responseText: "FROM_BUNDLE" });
  const emptyPath = makeToolOnlyPath();
  const dataDir = makeDir("devin-plugin-data-");
  try {
    const env = { PATH: emptyPath, [DESKTOP_CANDIDATE_ENV]: fake.binPath, CLAUDE_PLUGIN_DATA: dataDir };
    const { result, report } = runSetup(env, repo.dir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(report.devin.installed, true);
    assert.equal(report.devin.path, fs.realpathSync(fake.binPath));
    assert.equal(report.devin.source, "Devin Desktop app bundle");
    assert.equal(report.ready, true);

    // Same binary for print runs: the fake logs every invocation's args.
    const task = spawnSync(process.execPath, [COMPANION, "task", "--", "hello"], {
      cwd: repo.dir,
      encoding: "utf8",
      env: { ...process.env, DEVIN_COMPANION_DEVIN_BINARY: "", ...env },
      timeout: 30000
    });
    const argsLog = fs.readFileSync(`${fake.marker}.args`, "utf8");
    assert.match(argsLog, /^version$/m);
    assert.match(argsLog, /^auth status$/m);
    assert.equal(task.status, 0, task.stderr);
    assert.match(task.stdout, /FROM_BUNDLE/);
    assert.match(argsLog, /^-p /m);
  } finally {
    fs.rmSync(emptyPath, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
    fake.cleanup();
    repo.cleanup();
  }
});

test("PATH devin wins over the app bundle in the companion", () => {
  const repo = createTempRepo();
  const onPath = createFakeDevin();
  const bundle = createFakeDevin();
  try {
    const { report } = runSetup({ PATH: onPath.dir, [DESKTOP_CANDIDATE_ENV]: bundle.binPath }, repo.dir);
    assert.equal(report.devin.path, path.join(onPath.dir, "devin"));
    assert.equal(report.devin.source, "PATH");
  } finally {
    onPath.cleanup();
    bundle.cleanup();
    repo.cleanup();
  }
});

test("explicit env binary that cannot run is reported, not replaced by a fallback", () => {
  const repo = createTempRepo();
  const bundle = createFakeDevin();
  try {
    const missing = path.join(repo.dir, "no-such-devin");
    const { report } = runSetup(
      { DEVIN_COMPANION_DEVIN_BINARY: missing, PATH: bundle.dir, [DESKTOP_CANDIDATE_ENV]: bundle.binPath },
      repo.dir
    );
    assert.equal(report.devin.installed, false);
    assert.equal(report.devin.path, missing);
    assert.equal(report.devin.source, "DEVIN_COMPANION_DEVIN_BINARY");
  } finally {
    bundle.cleanup();
    repo.cleanup();
  }
});
