#!/usr/bin/env bun

import {
  resolveCliArgs,
  loadRuntimeConfig,
  applyRuntimeEnv,
  summarizeRuntime,
  getBackendProfile,
  runSetupWizard,
  inspectRuntime,
  bootstrapWorkspace,
  formatValidationIssues,
} from "./config.js";
import { loadToken, loginWithQR } from "./weixin/auth.js";

function printHelp() {
  console.log(`WeChat AI Bridge CLI

Usage:
  bun run start --backend claude
  bun run bootstrap --backend claude
  bun run check --backend claude
  bun run setup

Commands:
  start         Start one backend instance (scans QR if needed)
  bootstrap     Create a starter config.json and files/ directory
  check         Validate config and local prerequisites
  setup         Create or update config.json interactively
  config        Print the resolved runtime config (secrets redacted)

Options:
  --backend, -b   claude | codex | gemini (experimental)
  --config, -c    Path to config.json
  --force, -f     Overwrite an existing config file during bootstrap
  --help, -h      Show this help
`);
}

async function ensureToken() {
  // 尝试加载已保存的 token
  const saved = loadToken();
  if (saved && saved.botToken) {
    console.log("[auth] 使用已保存的 token");
    return saved.botToken;
  }

  // 需要扫码登录
  console.log("[auth] 未找到已保存的 token，需要扫码登录");

  let qrTerminal;
  try {
    qrTerminal = await import("qrcode-terminal");
  } catch {
    console.error("缺少 qrcode-terminal 依赖，请运行: bun add qrcode-terminal");
    process.exit(1);
  }

  const result = await loginWithQR((qrUrl) => {
    console.log("\n请用微信扫描以下二维码：\n");
    qrTerminal.default.generate(qrUrl, { small: true });
    console.log(`\n或在浏览器打开: ${qrUrl}\n`);
  });

  return result.botToken;
}

async function main() {
  const cli = resolveCliArgs(process.argv);

  if (cli.help || cli.command === "help") {
    printHelp();
    return;
  }

  if (cli.command === "setup") {
    const result = await runSetupWizard({
      backend: cli.backendSpecified ? cli.backend : null,
      configPath: cli.configPath,
    });
    console.log(`\nSaved config to ${result.configPath}`);
    return;
  }

  if (cli.command === "bootstrap") {
    const result = bootstrapWorkspace({
      backend: cli.backend,
      configPath: cli.configPath,
      force: cli.force,
    });
    if (result.created) {
      const action = result.overwritten ? "Rewrote" : "Created";
      console.log(`${action} starter config at ${result.configPath}`);
      console.log(`Prepared files directory at ${result.filesDir}`);
      console.log(`Next: edit ${result.configPath}, then run bun run check --backend ${result.backend}`);
      return;
    }
    console.log(`Config already exists at ${result.configPath}`);
    console.log("Pass --force to overwrite, or run bun run setup to edit interactively.");
    return;
  }

  const runtime = loadRuntimeConfig({
    backend: cli.backend,
    configPath: cli.configPath,
  });
  const profile = getBackendProfile(runtime.backend);

  if (cli.command === "config") {
    console.log(JSON.stringify(summarizeRuntime(runtime), null, 2));
    return;
  }

  if (cli.command === "check") {
    const report = inspectRuntime(runtime);
    console.log(`[check] backend=${report.backend} source=${report.source}`);
    console.log(`[check] cwd=${report.cwd}`);
    console.log(`[check] sessions_db=${report.sessionsDb}`);
    console.log(`[check] tasks_db=${report.tasksDb}`);
    for (const w of report.warnings) {
      console.warn(`[check] warning ${w.path}: ${w.message}`);
    }
    if (report.errors.length) {
      console.error(formatValidationIssues(report.errors, "[check] failed"));
      process.exit(1);
    }
    console.log("[check] ok");
    return;
  }

  if (cli.command !== "start") {
    throw new Error(`Unknown command: ${cli.command}`);
  }

  // ── Start 流程 ──
  applyRuntimeEnv(runtime.env);

  // 扫码登录（或加载已保存 token）
  const botToken = await ensureToken();
  process.env.WECHAT_BOT_TOKEN = botToken;

  console.log(`[start] backend=${runtime.backend} source=${runtime.source}`);
  if (profile.maturity === "experimental") {
    console.log(`[start] note=${profile.summary}`);
  }

  // 加载 bridge（bridge.js 从 process.env 读取配置）
  await import("./bridge.js");
}

main().catch((error) => {
  console.error(`[start] ${error.message}`);
  process.exit(1);
});
