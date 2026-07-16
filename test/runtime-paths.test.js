import assert from "node:assert/strict";
import test from "node:test";
import { resolveHomeDirectory } from "../runtime-paths.js";

test("HOME remains the first-choice home directory", () => {
  assert.equal(
    resolveHomeDirectory({ HOME: "/home/alice", USERPROFILE: "C:\\Users\\Alice" }, "/os-home"),
    "/home/alice",
  );
});

test("USERPROFILE supports Windows environments without HOME", () => {
  assert.equal(
    resolveHomeDirectory({ HOME: "", USERPROFILE: "C:\\Users\\Alice" }, "/os-home"),
    "C:\\Users\\Alice",
  );
});

test("the platform home is used when shell variables are absent", () => {
  assert.equal(resolveHomeDirectory({}, "/os-home"), "/os-home");
});
