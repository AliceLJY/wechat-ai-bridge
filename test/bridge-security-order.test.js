import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "bridge.js"), "utf8");
const start = source.indexOf("async function onMessage(msg)");
const end = source.indexOf("// ── 启动 ──", start);
const body = source.slice(start, end);

test("message authorization precedes media, interactions, commands, and AI submission", () => {
  const authorization = body.indexOf("if (!isAllowedUserId(userId, ALLOWED_USER_IDS))");
  assert.ok(start >= 0 && end > start && authorization >= 0, "onMessage authorization check is missing");

  for (const operation of [
    "extractText(msg)",
    "downloadImage(item)",
    "pendingInteractions.get(chatId)",
    "handleCommand(ctx, text)",
    "submitAndWait(ctx, text)",
  ]) {
    const index = body.indexOf(operation);
    assert.ok(index > authorization, `${operation} must occur after the allowlist check`);
  }
});
