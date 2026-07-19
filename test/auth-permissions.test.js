import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("token persistence uses a 0700 state directory and 0600 token file", async () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-auth-test-"));
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  try {
    process.env.HOME = root;
    delete process.env.USERPROFILE;
    const auth = await import(`../weixin/auth.js?permissions=${Date.now()}`);
    auth.saveToken("fixture-value", "fixture-bot", "https://fixture.invalid");

    if (process.platform !== "win32") {
      assert.equal(statSync(auth.STATE_DIR).mode & 0o777, 0o700);
      assert.equal(statSync(auth.TOKEN_PATH).mode & 0o777, 0o600);
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
    rmSync(root, { recursive: true, force: true });
  }
});
