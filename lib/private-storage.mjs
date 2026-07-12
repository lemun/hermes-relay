import crypto from "node:crypto";
import fs from "node:fs";

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

export function ensurePrivateDirectory(dir, { fsImpl = fs } = {}) {
  try {
    fsImpl.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
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
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      fsImpl.renameSync(temporaryFile, file);
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
    descriptor = fsImpl.openSync(file, "a", PRIVATE_FILE_MODE);
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
