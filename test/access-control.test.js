import assert from "node:assert/strict";
import test from "node:test";
import {
  createAllowedUserSet,
  isAllowedUserId,
  normalizeAllowedUserIds,
} from "../access-control.js";

test("normalizes configured user IDs without claiming an unlisted sender", () => {
  const allowed = createAllowedUserSet([" trusted-a ", "trusted-a", "trusted-b"]);
  assert.deepEqual([...allowed], ["trusted-a", "trusted-b"]);
  assert.equal(isAllowedUserId("trusted-a", allowed), true);
  assert.equal(isAllowedUserId("first-contact", allowed), false);
  assert.deepEqual([...allowed], ["trusted-a", "trusted-b"]);
});

test("parses the JSON environment representation", () => {
  assert.deepEqual(
    normalizeAllowedUserIds('["trusted-a","trusted-b"]', { source: "WECHAT_ALLOWED_USER_IDS" }),
    ["trusted-a", "trusted-b"],
  );
});

test("fails closed for missing, empty, malformed, or non-string entries", () => {
  for (const value of [undefined, "", "[]", [], [""], [123], "not-json"]) {
    assert.throws(() => normalizeAllowedUserIds(value), /must be|valid JSON/);
  }
});
