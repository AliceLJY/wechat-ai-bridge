import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createDirManager, switchChatDirectory } from "../dir-manager.js";

test("directory command uses switchDir and reports successful changes", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-dir-test-"));
  try {
    const next = join(root, "next");
    mkdirSync(next);
    const manager = createDirManager(root);
    const result = switchChatDirectory(manager, 1, next);
    assert.equal(result.ok, true);
    assert.equal(result.current, resolve(next));
    assert.equal(result.message, `工作目录: ${resolve(next)}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("/dir - reports the missing previous directory and then toggles history", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-dir-test-"));
  try {
    const next = join(root, "next");
    mkdirSync(next);
    const manager = createDirManager(root);

    assert.deepEqual(switchChatDirectory(manager, 1, "-"), {
      ok: false,
      error: "没有上一个目录",
      message: "没有上一个目录",
    });
    switchChatDirectory(manager, 1, next);
    assert.equal(switchChatDirectory(manager, 1, "-").current, root);
    assert.equal(switchChatDirectory(manager, 1, "-").current, resolve(next));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
