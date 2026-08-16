import assert from "node:assert/strict";
import test from "node:test";

import { createAdapter } from "../adapters/gemini.js";

test("the gemini backend is disabled and says why", () => {
  assert.throws(
    () => createAdapter(),
    /piggybacks on Gemini CLI OAuth/,
    "creating the gemini adapter must fail with the account-safety reason",
  );
  assert.throws(() => createAdapter(), /geminicli\.com\/docs\/resources\/faq/);
});

test("the disabled reason points at the supported alternatives", () => {
  assert.throws(() => createAdapter(), /Vertex AI/);
  assert.throws(() => createAdapter(), /Claude or Codex/);
});
