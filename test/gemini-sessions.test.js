import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listLocalGeminiSessions } from "../adapters/gemini.js";

test("Gemini session discovery returns an empty array for missing or empty storage", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-gemini-test-"));
  try {
    assert.deepEqual(listLocalGeminiSessions(root), []);
    mkdirSync(join(root, ".gemini", "tmp"), { recursive: true });
    assert.deepEqual(listLocalGeminiSessions(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Gemini session discovery returns array entries from fixture data", () => {
  const root = mkdtempSync(join(tmpdir(), "wechat-gemini-test-"));
  try {
    const chats = join(root, ".gemini", "tmp", "project", "chats");
    mkdirSync(chats, { recursive: true });
    writeFileSync(join(chats, "session-fixture.json"), JSON.stringify({
      sessionId: "fixture-session",
      messages: [{ type: "user", content: "fixture topic" }],
    }));
    assert.deepEqual(listLocalGeminiSessions(root, 1).map((entry) => ({
      session_id: entry.session_id,
      display_name: entry.display_name,
      backend: entry.backend,
    })), [{
      session_id: "fixture-session",
      display_name: "fixture topic",
      backend: "gemini",
    }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
