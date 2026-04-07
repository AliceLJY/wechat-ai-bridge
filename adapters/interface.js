// 统一适配器接口定义 + 工厂函数
//
// 每个适配器导出 createAdapter(config) → { name, streamQuery, statusInfo }
// streamQuery 是 async generator，yield 统一事件：
//   { type: "session_init", sessionId }
//   { type: "progress", toolName?, toolIcon?, detail? }
//   { type: "text", text }
//   { type: "result", success, text, cost?, duration? }

import { createAdapter as createClaudeAdapter } from "./claude.js";
import { createAdapter as createCodexAdapter } from "./codex.js";
import { createAdapter as createGeminiAdapter } from "./gemini.js";

const ADAPTERS = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  gemini: createGeminiAdapter,
};

export function createBackend(name, config = {}) {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(`Unknown backend: ${name}. Available: ${Object.keys(ADAPTERS).join(", ")}`);
  }
  return factory(config);
}

export const AVAILABLE_BACKENDS = Object.keys(ADAPTERS);
