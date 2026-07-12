import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

export class PrivateStorageError extends Error {
  constructor(operation, target, cause) {
    super(`Cannot ${operation} ${target}: ${cause?.message || cause}`, { cause });
    this.name = "PrivateStorageError";
    this.code = cause?.code;
    this.operation = operation;
    this.path = target;
  }
}

function storageError(operation, target, cause) {
  return cause instanceof PrivateStorageError
    ? cause
    : new PrivateStorageError(operation, target, cause);
}

function lstatIfPresent(target, fsImpl) {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function rejectUnsafeExistingPath(target, { kind, fsImpl }) {
  const stat = lstatIfPresent(target, fsImpl);
  if (!stat) return null;
  if (stat.isSymbolicLink()) {
    const error = new Error(`${kind} must not be a symbolic link`);
    error.code = "ELOOP";
    throw error;
  }
  const valid = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (!valid) {
    const error = new Error(`${kind} has an unexpected file type`);
    error.code = "EINVAL";
    throw error;
  }
  return stat;
}

function rejectUnsafeDirectoryAncestors(dir, fsImpl) {
  const allowedMacAliases = new Set(["/tmp", "/var", "/etc"]);
  let current = path.resolve(dir);
  while (current !== path.dirname(current)) {
    const stat = lstatIfPresent(current, fsImpl);
    if (stat?.isSymbolicLink() && !allowedMacAliases.has(current)) {
      const error = new Error("directory ancestry must not contain a symbolic link");
      error.code = "ELOOP";
      throw error;
    }
    current = path.dirname(current);
  }
}

export function ensurePrivateDirectory(dir, { fsImpl = fs } = {}) {
  try {
    rejectUnsafeDirectoryAncestors(dir, fsImpl);
    rejectUnsafeExistingPath(dir, { kind: "directory", fsImpl });
    fsImpl.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    rejectUnsafeExistingPath(dir, { kind: "directory", fsImpl });
    fsImpl.chmodSync(dir, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    throw storageError("secure private directory", dir, error);
  }
}

export function writePrivateFileAtomic(file, contents, { fsImpl = fs } = {}) {
  const suffix = crypto.randomBytes(8).toString("hex");
  const temporaryFile = `${file}.tmp-${process.pid}-${suffix}`;
  let descriptor;

  try {
    try {
      const existing = rejectUnsafeExistingPath(file, { kind: "file", fsImpl });
      if (existing) fsImpl.chmodSync(file, PRIVATE_FILE_MODE);
    } catch (error) {
      throw storageError("secure existing private file", file, error);
    }

    try {
      descriptor = fsImpl.openSync(temporaryFile, "wx", PRIVATE_FILE_MODE);
    } catch (error) {
      throw storageError("create private temporary file for", file, error);
    }

    try {
      fsImpl.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    } catch (error) {
      throw storageError("secure private temporary file for", file, error);
    }

    try {
      fsImpl.writeFileSync(descriptor, contents);
      fsImpl.fsyncSync?.(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      fsImpl.renameSync(temporaryFile, file);
      rejectUnsafeExistingPath(file, { kind: "file", fsImpl });
      fsImpl.chmodSync(file, PRIVATE_FILE_MODE);
      const directoryDescriptor = fsImpl.openSync(
        path.dirname(file),
        fsImpl.constants.O_RDONLY | (fsImpl.constants.O_DIRECTORY || 0),
      );
      try { fsImpl.fsyncSync?.(directoryDescriptor); }
      finally { fsImpl.closeSync(directoryDescriptor); }
    } catch (error) {
      throw storageError("atomically replace private file", file, error);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    try { fsImpl.unlinkSync(temporaryFile); } catch { /* absent or already renamed */ }
    throw error;
  }
}

export function writePrivateJsonAtomic(file, value, options) {
  writePrivateFileAtomic(file, JSON.stringify(value, null, 2), options);
}

export function openPrivateFileForAppend(file, { fsImpl = fs } = {}) {
  let descriptor;
  try {
    rejectUnsafeExistingPath(file, { kind: "file", fsImpl });
    const flags = fsImpl.constants.O_WRONLY
      | fsImpl.constants.O_APPEND
      | fsImpl.constants.O_CREAT
      | (fsImpl.constants.O_NOFOLLOW || 0);
    descriptor = fsImpl.openSync(file, flags, PRIVATE_FILE_MODE);
    fsImpl.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    return descriptor;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
    throw storageError("secure private file", file, error);
  }
}

export function ensurePrivateFile(file, { fsImpl = fs } = {}) {
  const descriptor = openPrivateFileForAppend(file, { fsImpl });
  fsImpl.closeSync(descriptor);
}

function openPrivateRegularFileForRead(file, fsImpl) {
  rejectUnsafeExistingPath(file, { kind: "file", fsImpl });
  const descriptor = fsImpl.openSync(
    file,
    fsImpl.constants.O_RDONLY | (fsImpl.constants.O_NOFOLLOW || 0),
  );
  try {
    const stat = fsImpl.fstatSync(descriptor);
    if (!stat.isFile()) {
      const error = new Error("file descriptor is not a regular file");
      error.code = "EINVAL";
      throw error;
    }
    fsImpl.fchmodSync(descriptor, PRIVATE_FILE_MODE);
    return { descriptor, stat };
  } catch (error) {
    try { fsImpl.closeSync(descriptor); } catch { /* preserve */ }
    throw error;
  }
}

export function assertPrivateRegularFile(file, { fsImpl = fs } = {}) {
  try {
    const { descriptor } = openPrivateRegularFileForRead(file, fsImpl);
    fsImpl.closeSync(descriptor);
  } catch (error) {
    throw storageError("validate private file", file, error);
  }
}

export function readPrivateFile(file, { fsImpl = fs, encoding = "utf8" } = {}) {
  try {
    const { descriptor } = openPrivateRegularFileForRead(file, fsImpl);
    try { return fsImpl.readFileSync(descriptor, encoding); }
    finally { fsImpl.closeSync(descriptor); }
  } catch (error) {
    throw storageError("read private file", file, error);
  }
}

export function readPrivateFileTail(file, { fsImpl = fs, maxBytes = 262144 } = {}) {
  try {
    const { descriptor, stat } = openPrivateRegularFileForRead(file, fsImpl);
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const buffer = Buffer.alloc(stat.size - start);
      fsImpl.readSync(descriptor, buffer, 0, buffer.length, start);
      return buffer.toString("utf8");
    } finally { fsImpl.closeSync(descriptor); }
  } catch (error) {
    throw storageError("read private file tail", file, error);
  }
}
