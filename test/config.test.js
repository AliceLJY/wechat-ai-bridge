import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AVAILABLE_EXECUTORS,
  bootstrapWorkspace,
  createBootstrapConfig,
  loadRuntimeConfig,
  summarizeRuntime,
  validateConfig,
} from "../config.js";
import { AVAILABLE_EXECUTORS as EXECUTOR_REGISTRY } from "../executor/interface.js";

function tempDirectory() {
  return mkdtempSync(join(tmpdir(), "wechat-config-test-"));
}

test("starter config requires an explicit non-empty allowedUserIds array", () => {
  const config = createBootstrapConfig("claude");
  const issues = validateConfig(config, { backend: "claude" });
  assert.ok(issues.some((issue) => issue.path === "shared.allowedUserIds"));

  config.shared.allowedUserIds = ["trusted-user"];
  assert.equal(
    validateConfig(config, { backend: "claude" }).some((issue) => issue.path === "shared.allowedUserIds"),
    false,
  );
});

test("config executor choices match implemented executors and reject local-agent", () => {
  assert.deepEqual(AVAILABLE_EXECUTORS, EXECUTOR_REGISTRY);
  assert.deepEqual(AVAILABLE_EXECUTORS, ["direct"]);

  const config = createBootstrapConfig("claude");
  config.shared.allowedUserIds = ["trusted-user"];
  config.shared.executor = "local-agent";
  const issue = validateConfig(config, { backend: "claude" })
    .find((entry) => entry.path === "shared.executor");
  assert.match(issue?.message || "", /direct/);
});

test("runtime config propagates the allowlist and repairs config mode without exposing IDs", () => {
  const root = tempDirectory();
  try {
    const configPath = join(root, "config.json");
    const config = createBootstrapConfig("claude");
    config.shared.cwd = root;
    config.shared.allowedUserIds = ["trusted-user"];
    writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o644 });
    if (process.platform !== "win32") chmodSync(configPath, 0o644);

    const runtime = loadRuntimeConfig({ backend: "claude", configPath });
    assert.equal(runtime.env.WECHAT_ALLOWED_USER_IDS, '["trusted-user"]');
    assert.equal(summarizeRuntime(runtime).env.WECHAT_ALLOWED_USER_IDS, "[1 configured]");
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrap creates a private starter config without inventing a user ID", () => {
  const root = tempDirectory();
  try {
    const configPath = join(root, "config.json");
    const result = bootstrapWorkspace({ backend: "claude", configPath });
    const written = JSON.parse(readFileSync(result.configPath, "utf8"));
    assert.deepEqual(written.shared.allowedUserIds, []);
    if (process.platform !== "win32") assert.equal(statSync(configPath).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
