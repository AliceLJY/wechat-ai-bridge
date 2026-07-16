// 统一适配器接口定义 + 工厂函数
//
// 每个适配器导出 createAdapter(config) → { name, streamQuery, statusInfo }
// streamQuery 是 async generator，yield 统一事件：
//   { type: "session_init", sessionId }
//   { type: "progress", toolName?, toolIcon?, detail? }
//   { type: "text", text }
//   { type: "result", success, text, cost?, duration? }

const ADAPTER_MODULES = {
  claude: "./claude.js",
  codex: "./codex.js",
  gemini: "./gemini.js",
};

export const AVAILABLE_BACKENDS = Object.freeze(Object.keys(ADAPTER_MODULES));

/** Load only the selected backend so an unavailable optional dependency in one
 * adapter cannot prevent unrelated backends from starting. The importer
 * argument is injectable for deterministic, dependency-free contract tests. */
export async function createBackend(name, config = {}, importer = (specifier) => import(specifier)) {
  const backendName = String(name || "").trim().toLowerCase();
  const modulePath = ADAPTER_MODULES[backendName];
  if (!modulePath) {
    throw new Error(`Unknown backend: ${backendName}. Available: ${AVAILABLE_BACKENDS.join(", ")}`);
  }

  let adapterModule;
  try {
    adapterModule = await importer(modulePath);
  } catch (error) {
    const detail = error?.message ? `: ${error.message}` : "";
    throw new Error(`Backend "${backendName}" could not be loaded${detail}`, { cause: error });
  }

  if (typeof adapterModule?.createAdapter !== "function") {
    throw new Error(`Backend "${backendName}" does not export createAdapter(config)`);
  }
  return adapterModule.createAdapter(config);
}
