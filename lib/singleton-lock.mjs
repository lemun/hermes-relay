import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_LOCK_BYTES = 4096;
const DEFAULT_TRUSTED_DIRECTORY = "/tmp";

export class SingletonLockError extends Error {
  constructor(message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SingletonLockError";
  }
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertLockDirectoryUnchanged(directory, expectedStat, { fsImpl }) {
  let current;
  try {
    current = fsImpl.lstatSync(directory);
  } catch (error) {
    throw new SingletonLockError("singleton lock directory changed during acquisition", { cause: error });
  }
  if (current.isSymbolicLink() || !current.isDirectory() || !sameFile(current, expectedStat)) {
    throw new SingletonLockError("singleton lock directory changed during acquisition");
  }
}

function assertTrustedDirectoryAncestry(directory, { fsImpl }) {
  let current = directory;
  let trustedParent = true;
  for (;;) {
    const stat = fsImpl.lstatSync(current);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== 0) {
      throw new SingletonLockError("singleton lock directory ancestry is not root-owned and stable");
    }
    if (trustedParent) {
      if (mode !== 0o1777) {
        throw new SingletonLockError("singleton lock directory is not a root-owned sticky temporary directory");
      }
      trustedParent = false;
    } else if ((mode & 0o022) !== 0) {
      throw new SingletonLockError("singleton lock directory ancestry is writable by non-root users");
    }
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function canonicalRepoRoot(rootPath, { fsImpl }) {
  try {
    const root = fsImpl.realpathSync(rootPath);
    const stat = fsImpl.lstatSync(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SingletonLockError("singleton identity root is not a directory");
    }
    return root;
  } catch (error) {
    if (error instanceof SingletonLockError) throw error;
    throw new SingletonLockError("singleton identity root is unsafe or unavailable", { cause: error });
  }
}

function openLockDirectory(trustedDirectory, { fsImpl }) {
  let directory;
  try {
    directory = fsImpl.realpathSync(trustedDirectory);
    assertTrustedDirectoryAncestry(directory, { fsImpl });
  } catch (error) {
    if (error instanceof SingletonLockError) throw error;
    throw new SingletonLockError("singleton lock directory is unsafe or unavailable", { cause: error });
  }

  let descriptor;
  try {
    const flags = fsImpl.constants.O_RDONLY
      | (fsImpl.constants.O_DIRECTORY || 0)
      | (fsImpl.constants.O_NOFOLLOW || 0);
    descriptor = fsImpl.openSync(directory, flags);
    const stat = fsImpl.fstatSync(descriptor);
    if (!stat.isDirectory()) throw new SingletonLockError("singleton lock parent is not a directory");
    assertLockDirectoryUnchanged(directory, stat, { fsImpl });
    return { directory, descriptor, stat };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    if (error instanceof SingletonLockError) throw error;
    throw new SingletonLockError("singleton lock directory is unsafe or unavailable", { cause: error });
  }
}

function readLockDescriptor(descriptor, { fsImpl }) {
  const stat = fsImpl.fstatSync(descriptor);
  if (!stat.isFile()) throw new SingletonLockError("singleton lock is not a regular file");
  if (stat.size > MAX_LOCK_BYTES) throw new SingletonLockError("singleton lock is too large");
  const parsed = JSON.parse(fsImpl.readFileSync(descriptor, "utf8"));
  if (!Number.isSafeInteger(parsed?.pid) || parsed.pid < 1) {
    throw new SingletonLockError("singleton lock is malformed");
  }
  return { parsed, stat };
}

function openExisting(lockPath, { fsImpl }) {
  const flags = fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fsImpl.openSync(lockPath, flags);
    const value = readLockDescriptor(descriptor, { fsImpl });
    return { descriptor, ...value };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* preserve original error */ }
    }
    if (error instanceof SingletonLockError) throw error;
    throw new SingletonLockError("singleton lock is unsafe or unavailable", { cause: error });
  }
}

export function acquireSingletonLock({
  rootPath,
  trustedDirectory = DEFAULT_TRUSTED_DIRECTORY,
  pid = process.pid,
  isAlive = (candidate) => {
    try { process.kill(candidate, 0); return true; }
    catch (error) { return error?.code === "EPERM"; }
  },
  fsImpl = fs,
  now = Date.now,
} = {}) {
  if (!rootPath) throw new TypeError("rootPath is required");
  const root = canonicalRepoRoot(rootPath, { fsImpl });
  const lockDirectory = openLockDirectory(trustedDirectory, { fsImpl });
  const key = crypto.createHash("sha256").update(root).digest("hex");
  const lockPath = path.join(lockDirectory.directory, `hermes-${key}.lock`);
  let directoryClosed = false;
  const closeLockDirectory = () => {
    if (directoryClosed) return;
    directoryClosed = true;
    fsImpl.closeSync(lockDirectory.descriptor);
  };
  const assertStableDirectory = () => {
    assertLockDirectoryUnchanged(lockDirectory.directory, lockDirectory.stat, { fsImpl });
  };

  const claim = () => {
    assertStableDirectory();
    const flags = fsImpl.constants.O_RDWR | fsImpl.constants.O_CREAT | fsImpl.constants.O_EXCL
      | (fsImpl.constants.O_NOFOLLOW || 0);
    const descriptor = fsImpl.openSync(lockPath, flags, 0o600);
    try {
      fsImpl.fchmodSync(descriptor, 0o600);
      fsImpl.writeFileSync(descriptor, JSON.stringify({ pid, at: Number(now()) }), "utf8");
      fsImpl.fsyncSync(descriptor);
      assertStableDirectory();
      return descriptor;
    } catch (error) {
      let ownedStat;
      try { ownedStat = fsImpl.fstatSync(descriptor); } catch { /* best-effort cleanup only */ }
      try { fsImpl.closeSync(descriptor); } catch { /* preserve original error */ }
      try {
        assertStableDirectory();
        const current = fsImpl.lstatSync(lockPath);
        if (ownedStat && !current.isSymbolicLink() && current.isFile() && sameFile(current, ownedStat)) {
          fsImpl.unlinkSync(lockPath);
        }
      } catch { /* preserve original error */ }
      throw new SingletonLockError("singleton lock could not be written", { cause: error });
    }
  };

  let descriptor;
  try {
    try {
      descriptor = claim();
    } catch (error) {
      if (error?.code !== "EEXIST") {
        if (error instanceof SingletonLockError) throw error;
        throw new SingletonLockError("singleton lock could not be acquired", { cause: error });
      }
      assertStableDirectory();
      const existing = openExisting(lockPath, { fsImpl });
      try {
        assertStableDirectory();
        if (existing.parsed.pid !== pid && isAlive(existing.parsed.pid)) {
          closeLockDirectory();
          return { ok: false, pid: existing.parsed.pid };
        }
        assertStableDirectory();
        const current = fsImpl.lstatSync(lockPath);
        if (current.isSymbolicLink() || !current.isFile() || !sameFile(current, existing.stat)) {
          throw new SingletonLockError("singleton lock changed during stale-lock recovery");
        }
        fsImpl.unlinkSync(lockPath);
        assertStableDirectory();
      } finally {
        fsImpl.closeSync(existing.descriptor);
      }
      try {
        descriptor = claim();
      } catch (claimError) {
        throw new SingletonLockError("singleton stale lock could not be reclaimed", { cause: claimError });
      }
    }
  } catch (error) {
    try { closeLockDirectory(); } catch { /* preserve original error */ }
    throw error;
  }

  const ownedStat = fsImpl.fstatSync(descriptor);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      assertStableDirectory();
      const current = fsImpl.lstatSync(lockPath);
      if (!current.isSymbolicLink() && current.isFile() && sameFile(current, ownedStat)) fsImpl.unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    } finally {
      fsImpl.closeSync(descriptor);
      closeLockDirectory();
    }
  };
  return { ok: true, release, lockPath };
}
