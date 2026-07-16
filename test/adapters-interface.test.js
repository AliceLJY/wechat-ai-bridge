import assert from "node:assert/strict";
import test from "node:test";
import { AVAILABLE_BACKENDS, createBackend } from "../adapters/interface.js";

test("the adapter registry imports no optional backend at module load", () => {
  assert.deepEqual([...AVAILABLE_BACKENDS], ["claude", "codex", "gemini"]);
});

test("only the selected backend module is imported", async () => {
  const imported = [];
  const adapter = await createBackend(
    "claude",
    { cwd: "C:\\work" },
    async (specifier) => {
      imported.push(specifier);
      return {
        createAdapter: (config) => ({ name: "claude", cwd: config.cwd }),
      };
    },
  );

  assert.deepEqual(imported, ["./claude.js"]);
  assert.deepEqual(adapter, { name: "claude", cwd: "C:\\work" });
});

test("one unavailable optional backend does not poison another backend", async () => {
  await assert.rejects(
    createBackend("gemini", {}, async () => {
      throw new Error("optional dependency unavailable on this platform");
    }),
    /Backend "gemini" could not be loaded: optional dependency unavailable/,
  );

  const claude = await createBackend("claude", {}, async () => ({
    createAdapter: () => ({ name: "claude" }),
  }));
  assert.equal(claude.name, "claude");
});

test("unknown backend names fail before any import", async () => {
  let imported = false;
  await assert.rejects(
    createBackend("other", {}, async () => {
      imported = true;
      return {};
    }),
    /Unknown backend: other/,
  );
  assert.equal(imported, false);
});
