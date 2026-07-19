import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensurePrivateDirectory,
  securePrivateFile,
  writePrivateFile,
} from "../private-storage.js";

test("private state directories and files are forced to 0700 and 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-private-test-"));
  try {
    const stateDir = join(root, "state");
    const privateFile = join(stateDir, "fixture.json");
    ensurePrivateDirectory(stateDir);
    writePrivateFile(privateFile, '{"fixture":true}');
    if (process.platform !== "win32") {
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      assert.equal(statSync(privateFile).mode & 0o777, 0o600);
      chmodSync(stateDir, 0o755);
      chmodSync(privateFile, 0o644);
      ensurePrivateDirectory(stateDir);
      securePrivateFile(privateFile);
      assert.equal(statSync(stateDir).mode & 0o777, 0o700);
      assert.equal(statSync(privateFile).mode & 0o777, 0o600);
    }
    assert.equal(readFileSync(privateFile, "utf8"), '{"fixture":true}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("private file writes refuse symbolic links", { skip: process.platform === "win32" }, () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-private-test-"));
  try {
    const target = join(root, "target.json");
    const link = join(root, "link.json");
    const targetDirectory = join(root, "target-directory");
    const directoryLink = join(root, "directory-link");
    const brokenLink = join(root, "broken-link.json");
    writeFileSync(target, "unchanged");
    ensurePrivateDirectory(targetDirectory);
    symlinkSync(target, link);
    symlinkSync(targetDirectory, directoryLink, "dir");
    symlinkSync(join(root, "missing-target.json"), brokenLink);
    assert.throws(() => writePrivateFile(link, "replacement"), /symbolic link/);
    assert.throws(() => writePrivateFile(brokenLink, "replacement"), /symbolic link/);
    assert.throws(() => ensurePrivateDirectory(directoryLink), /symbolic link/);
    assert.equal(readFileSync(target, "utf8"), "unchanged");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
