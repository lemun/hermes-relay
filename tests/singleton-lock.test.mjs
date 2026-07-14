import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireSingletonLock, SingletonLockError } from "../lib/singleton-lock.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "hermes-singleton-"));

function releasedLockPath(rootPath) {
  const lock = acquireSingletonLock({ rootPath, isAlive: () => false });
  const { lockPath } = lock;
  lock.release();
  return lockPath;
}

test("singleton lock ignores a replaced legacy state parent and uses the canonical repo identity", (t) => {
  const root = tmp();
  const rootAlias = `${root}-alias`;
  const stateDir = path.join(root, "state");
  const oldStateDir = path.join(root, "state-old");
  const redirectTarget = path.join(root, "redirect-target");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(redirectTarget);
  fs.symlinkSync(root, rootAlias);
  t.after(() => { try { fs.unlinkSync(rootAlias); } catch { /* test cleanup */ } });

  let replaced = false;
  const fsImpl = {
    ...fs,
    openSync(targetPath, ...args) {
      if (!replaced && /^hermes-[a-f0-9]{64}\.lock$/.test(path.basename(String(targetPath)))) {
        replaced = true;
        fs.renameSync(stateDir, oldStateDir);
        fs.symlinkSync(redirectTarget, stateDir);
      }
      return fs.openSync(targetPath, ...args);
    },
  };

  const lock = acquireSingletonLock({ rootPath: root, pid: 100, isAlive: () => false, fsImpl });
  try {
    assert.equal(lock.ok, true);
    assert.equal(replaced, true, "legacy state replacement must race the trusted leaf open");
    assert.deepEqual(fs.readdirSync(redirectTarget), []);
    const duplicate = acquireSingletonLock({
      rootPath: rootAlias,
      pid: 200,
      isAlive: (candidate) => candidate === 100,
    });
    assert.deepEqual(duplicate, { ok: false, pid: 100 });
  } finally {
    lock.release();
  }
});

test("singleton lock refuses symlink leaves without touching their target", (t) => {
  const root = tmp();
  const target = path.join(root, "target");
  const lockPath = releasedLockPath(root);
  t.after(() => { try { fs.unlinkSync(lockPath); } catch { /* test cleanup */ } });
  fs.writeFileSync(target, "do not truncate");
  fs.symlinkSync(target, lockPath);

  assert.throws(
    () => acquireSingletonLock({ rootPath: root, pid: 100, isAlive: () => false }),
    SingletonLockError,
  );
  assert.equal(fs.readFileSync(target, "utf8"), "do not truncate");
  assert.equal(fs.lstatSync(lockPath).isSymbolicLink(), true);
});

test("singleton lock rejects an untrusted parent before creating a leaf", () => {
  const root = tmp();
  const untrusted = path.join(root, "untrusted-temp");
  fs.mkdirSync(untrusted, { mode: 0o777 });
  fs.chmodSync(untrusted, 0o777);

  assert.throws(
    () => acquireSingletonLock({
      rootPath: root,
      trustedDirectory: untrusted,
      pid: 100,
      isAlive: () => false,
    }),
    SingletonLockError,
  );
  assert.deepEqual(fs.readdirSync(untrusted), []);
});

test("singleton lock reclaims a dead regular pidfile and releases only its own inode", () => {
  const root = tmp();
  const lockPath = releasedLockPath(root);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 10, at: 1 }));

  const lock = acquireSingletonLock({ rootPath: root, pid: 20, isAlive: () => false, now: () => 2 });
  assert.equal(lock.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 20);

  fs.unlinkSync(lockPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 30, at: 3 }));
  lock.release();
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 30);
});

test("singleton lock reports a live owner without replacing it", (t) => {
  const root = tmp();
  const lockPath = releasedLockPath(root);
  t.after(() => { try { fs.unlinkSync(lockPath); } catch { /* test cleanup */ } });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 10, at: 1 }));
  const lock = acquireSingletonLock({ rootPath: root, pid: 20, isAlive: (pid) => pid === 10 });
  assert.deepEqual(lock, { ok: false, pid: 10 });
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).pid, 10);
});
