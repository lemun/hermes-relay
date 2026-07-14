import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
  PrivateStorageError,
  ensurePrivateDirectory,
  openPrivateFileForAppend,
  writePrivateFileAtomic,
} from "../lib/private-storage.mjs";
import { savePrefs } from "../lib/paperclip.mjs";
import { enforcePrivateUmask } from "../lib/runtime-security.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hermes-private-"));

test("private storage rejects symlinked directories and append targets", () => {
  const root = tmp();
  const realDir = path.join(root, "real");
  const linkedDir = path.join(root, "linked");
  fs.mkdirSync(realDir);
  fs.symlinkSync(realDir, linkedDir);
  assert.throws(() => ensurePrivateDirectory(linkedDir), PrivateStorageError);

  const target = path.join(realDir, "target.log");
  const link = path.join(realDir, "coder.log");
  fs.writeFileSync(target, "untouched");
  fs.symlinkSync(target, link);
  assert.throws(() => openPrivateFileForAppend(link), PrivateStorageError);
  assert.equal(fs.readFileSync(target, "utf8"), "untouched");

  const nested = path.join(linkedDir, "nested");
  fs.mkdirSync(path.join(realDir, "nested"));
  assert.throws(() => ensurePrivateDirectory(nested), /ancestry.*symbolic link/i);
});

test("atomic private writes tighten insecure files and remain private under umask 000", () => {
  const root = tmp();
  const file = path.join(root, "state.json");
  const previous = process.umask(0o000);
  try {
    fs.chmodSync(root, 0o777);
    fs.writeFileSync(file, "old", { mode: 0o666 });
    ensurePrivateDirectory(root);
    writePrivateFileAtomic(file, "new");
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(file, "utf8"), "new");
  } finally {
    process.umask(previous);
  }
});

test("directory and pre-existing file chmod failures fail closed", () => {
  const root = tmp();
  const file = path.join(root, "state.json");
  fs.writeFileSync(file, "old", { mode: 0o644 });
  const fsImpl = {
    ...fs,
    chmodSync() {
      const error = new Error("chmod denied");
      error.code = "EPERM";
      throw error;
    },
  };
  assert.throws(() => ensurePrivateDirectory(root, { fsImpl }), /secure private directory/i);
  assert.throws(() => writePrivateFileAtomic(file, "new", { fsImpl }), /secure existing private file/i);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
});

for (const failure of ["openSync", "fchmodSync", "writeFileSync", "renameSync"]) {
  test(`atomic private write surfaces ${failure} failure without replacing old data`, () => {
    const root = tmp();
    const file = path.join(root, "state.json");
    fs.writeFileSync(file, "old", { mode: 0o600 });
    let calls = 0;
    const fsImpl = {
      ...fs,
      [failure](...args) {
        calls += 1;
        if ((failure === "fchmodSync" && calls > 0) || failure !== "fchmodSync") {
          const error = new Error(`${failure} denied`);
          error.code = "EACCES";
          throw error;
        }
        return fs[failure](...args);
      },
    };
    assert.throws(() => writePrivateFileAtomic(file, "new", { fsImpl }), PrivateStorageError);
    assert.equal(fs.readFileSync(file, "utf8"), "old");
    assert.equal(fs.readdirSync(root).some((name) => name.includes(".tmp-")), false);
  });
}

test("atomic private writes refuse a pre-existing final symlink", () => {
  const root = tmp();
  const target = path.join(root, "target");
  const link = path.join(root, "prefs.json");
  fs.writeFileSync(target, "secret target", { mode: 0o600 });
  fs.symlinkSync(target, link);
  assert.throws(() => writePrivateFileAtomic(link, "replacement"), /symbolic link/i);
  assert.equal(fs.readFileSync(target, "utf8"), "secret target");
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
});

test("preference persistence surfaces storage failures to callers", () => {
  const root = tmp();
  const target = path.join(root, "target");
  const prefs = path.join(root, "hermes-prefs.json");
  fs.writeFileSync(target, "keep");
  fs.symlinkSync(target, prefs);
  assert.throws(() => savePrefs({ lastPrompt: "do not lose me" }, { file: prefs }), PrivateStorageError);
  assert.equal(fs.readFileSync(target, "utf8"), "keep");

  const ordinary = path.join(root, "ordinary-prefs.json");
  const fsImpl = {
    ...fs,
    openSync() {
      const error = new Error("open denied");
      error.code = "EACCES";
      throw error;
    },
  };
  assert.throws(() => savePrefs({ lastPrompt: "must surface" }, { file: ordinary, fsImpl }), /create private temporary file/i);
});

test("manual runtime installs a private umask", () => {
  let received;
  const processImpl = { umask(value) { received = value; } };
  assert.equal(enforcePrivateUmask({ processImpl }), 0o077);
  assert.equal(received, 0o077);
});

test("direct runtime and launchd wrapper create replacement-style child files as 0600", () => {
  const root = tmp();
  const moduleUrl = pathToFileURL(path.resolve("lib/runtime-security.mjs")).href;
  const direct = path.join(root, "direct.txt");
  const code = `import fs from "node:fs"; import { enforcePrivateUmask } from ${JSON.stringify(moduleUrl)}; enforcePrivateUmask(); fs.writeFileSync(process.argv[1], "ok");`;
  let result = spawnSync(process.execPath, ["--input-type=module", "-e", code, direct], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(direct).mode & 0o777, 0o600);

  const wrapped = path.join(root, "wrapped.txt");
  const script = path.join(root, "write.mjs");
  fs.writeFileSync(script, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(wrapped)}, "ok");`);
  result = spawnSync(path.resolve("launchd/run-node.sh"), [script], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.statSync(wrapped).mode & 0o777, 0o600);
});
