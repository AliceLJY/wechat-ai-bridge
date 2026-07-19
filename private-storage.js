import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "fs";

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function chmodIfSupported(path, mode) {
  if (process.platform !== "win32") chmodSync(path, mode);
}

function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function assertExpectedType(path, expected, stat = lstatSync(path)) {
  if (stat.isSymbolicLink()) throw new Error(`Refusing to use symbolic link for private ${expected}: ${path}`);
  if (expected === "directory" && !stat.isDirectory()) {
    throw new Error(`Private state path is not a directory: ${path}`);
  }
  if (expected === "file" && !stat.isFile()) {
    throw new Error(`Private state path is not a regular file: ${path}`);
  }
}

export function ensurePrivateDirectory(path) {
  if (!lstatIfPresent(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  assertExpectedType(path, "directory");
  chmodIfSupported(path, PRIVATE_DIRECTORY_MODE);
  return path;
}

export function securePrivateFile(path) {
  const stat = lstatIfPresent(path);
  if (!stat) return false;
  assertExpectedType(path, "file", stat);
  chmodIfSupported(path, PRIVATE_FILE_MODE);
  return true;
}

export function writePrivateFile(path, data, encoding = "utf8") {
  const stat = lstatIfPresent(path);
  if (stat) assertExpectedType(path, "file", stat);
  const noFollow = Number(constants.O_NOFOLLOW || 0);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow,
    PRIVATE_FILE_MODE,
  );
  try {
    if (process.platform !== "win32") fchmodSync(fd, PRIVATE_FILE_MODE);
    writeFileSync(fd, data, { encoding });
  } finally {
    closeSync(fd);
  }
  return path;
}
