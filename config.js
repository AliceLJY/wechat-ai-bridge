import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { resolve, dirname, join, isAbsolute } from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";

const REPO_DIR = import.meta.dir;
const DEFAULT_CONFIG_PATH = join(REPO_DIR, "config.json");
export const AVAILABLE_BACKENDS = ["claude", "codex", "gemini"];
export const AVAILABLE_EXECUTORS = ["direct", "local-agent"];
export const CLAUDE_PERMISSION_MODES = ["default", "bypassPermissions"];
const BACKEND_PROFILES = {
  claude: { label: "Claude", maturity: "recommended", summary: "Recommended primary backend." },
  codex: { label: "Codex", maturity: "recommended", summary: "Recommended primary backend." },
  gemini: { label: "Gemini", maturity: "experimental", summary: "Experimental compatibility backend." },
};

function homeDir() {
  return process.env.HOME || REPO_DIR;
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.trim().length > 0;
}

function pushIssue(issues, path, message) {
  issues.push({ path, message });
}

function parseInteger(v) {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isInteger(n)) return n;
  }
  return null;
}

function isPositiveInteger(v) {
  const n = parseInteger(v);
  return n != null && n > 0;
}

function validatePositiveIntegerField(issues, path, value) {
  if (!isPositiveInteger(value)) {
    pushIssue(issues, path, "must be a positive integer.");
  }
}

export function getBackendProfile(name) {
  return BACKEND_PROFILES[normalizeBackendName(name)] || {
    label: String(name || "unknown"), maturity: "unknown", summary: "",
  };
}

function normalizeBackendName(name) {
  return String(name || "claude").toLowerCase();
}

function getBackendCredentialWarning(backend) {
  if (backend === "claude") {
    return { path: join(homeDir(), ".claude"), message: "Claude backend expects login state under ~/.claude." };
  }
  if (backend === "codex") {
    return { path: join(homeDir(), ".codex"), message: "Codex backend expects login state under ~/.codex." };
  }
  return { path: join(homeDir(), ".gemini", "oauth_creds.json"), message: "Gemini backend expects oauth_creds.json under ~/.gemini." };
}

function ensureExistingDirectory(issues, pathLabel, targetPath) {
  if (!isNonEmptyString(targetPath)) { pushIssue(issues, pathLabel, "must be set."); return; }
  const resolved = resolve(targetPath);
  if (!existsSync(resolved)) { pushIssue(issues, pathLabel, `directory does not exist: ${resolved}`); return; }
  try { if (!statSync(resolved).isDirectory()) pushIssue(issues, pathLabel, `must point to a directory: ${resolved}`); } catch { pushIssue(issues, pathLabel, `could not inspect directory: ${resolved}`); }
}

function ensureParentDirectoryExists(issues, pathLabel, targetPath) {
  if (!isNonEmptyString(targetPath)) { pushIssue(issues, pathLabel, "must be set."); return; }
  const parent = dirname(resolve(targetPath));
  if (!existsSync(parent)) { pushIssue(issues, pathLabel, `parent directory does not exist: ${parent}`); return; }
}

function resolvePathMaybe(baseDir, p) {
  if (!p) return p;
  if (isAbsolute(p)) return p;
  return resolve(baseDir, p);
}

// ── 默认配置 ──

export function createDefaultConfig() {
  return {
    shared: {
      cwd: homeDir(),
      defaultVerboseLevel: 1,
      executor: "direct",
      tasksDb: "",
      // 限流
      rateLimitMaxRequests: 10,
      rateLimitWindowMs: 60000,
      // Idle 监控
      idleTimeoutMs: 1800000,
      resetOnIdleMs: 0,
    },
    backends: {
      claude: {
        enabled: true,
        sessionsDb: "sessions.db",
        model: "claude-sonnet-4-6",
        permissionMode: "default",
      },
      codex: {
        enabled: false,
        sessionsDb: "sessions-codex.db",
        model: "",
      },
      gemini: {
        enabled: false,
        sessionsDb: "sessions-gemini.db",
        model: "gemini-2.5-pro",
        oauthClientId: "",
        oauthClientSecret: "",
        googleCloudProject: "",
      },
    },
  };
}

export function createBootstrapConfig(backend = "claude") {
  const selected = normalizeBackendName(backend);
  const config = createDefaultConfig();
  for (const name of AVAILABLE_BACKENDS) {
    config.backends[name].enabled = name === selected;
  }
  return config;
}

function mergeConfig(base, patch) {
  const result = structuredClone(base);
  if (!patch || typeof patch !== "object") return result;
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = mergeConfig(result[key], value);
      continue;
    }
    result[key] = value;
  }
  return result;
}

function parseJsonConfig(configPath) {
  const raw = readFileSync(configPath, "utf8");
  return mergeConfig(createDefaultConfig(), JSON.parse(raw));
}

function buildEnvFromConfig(config, backend, configPath) {
  const selected = normalizeBackendName(backend);
  if (!AVAILABLE_BACKENDS.includes(selected)) throw new Error(`Unsupported backend: ${selected}`);

  const bc = config.backends?.[selected];
  if (!bc) throw new Error(`Missing backends.${selected} in ${configPath}`);
  if (bc.enabled === false) throw new Error(`Backend "${selected}" is disabled in ${configPath}`);

  const baseDir = dirname(configPath);
  const shared = config.shared || {};
  const env = {
    CC_CWD: resolvePathMaybe(baseDir, shared.cwd || process.env.HOME || REPO_DIR),
    DEFAULT_VERBOSE_LEVEL: String(shared.defaultVerboseLevel ?? 1),
    BRIDGE_EXECUTOR: String(shared.executor || "direct"),
    DEFAULT_BACKEND: selected,
    ENABLED_BACKENDS: selected,
    SESSIONS_DB: resolvePathMaybe(baseDir, bc.sessionsDb || `${selected}.db`),
    TASKS_DB: resolvePathMaybe(baseDir, shared.tasksDb || `tasks-${selected}.db`),
    RATE_LIMIT_MAX_REQUESTS: String(shared.rateLimitMaxRequests ?? 10),
    RATE_LIMIT_WINDOW_MS: String(shared.rateLimitWindowMs ?? 60000),
    IDLE_TIMEOUT_MS: String(shared.idleTimeoutMs ?? 1800000),
    RESET_ON_IDLE_MS: String(shared.resetOnIdleMs ?? 0),
  };

  if (selected === "claude") {
    env.CC_MODEL = bc.model || "claude-sonnet-4-6";
    env.CC_PERMISSION_MODE = bc.permissionMode || "default";
  }
  if (selected === "codex") {
    env.CODEX_MODEL = bc.model || "";
  }
  if (selected === "gemini") {
    env.GEMINI_MODEL = bc.model || "gemini-2.5-pro";
    env.GEMINI_OAUTH_CLIENT_ID = bc.oauthClientId || "";
    env.GEMINI_OAUTH_CLIENT_SECRET = bc.oauthClientSecret || "";
    env.GOOGLE_CLOUD_PROJECT = bc.googleCloudProject || "";
  }
  return env;
}

// ── 验证 ──

export function validateConfig(config, options = {}) {
  const issues = [];
  const selected = normalizeBackendName(options.backend);
  const shared = config?.shared;
  if (!shared || typeof shared !== "object") { pushIssue(issues, "shared", "is required."); return issues; }

  if (!isNonEmptyString(shared.cwd)) pushIssue(issues, "shared.cwd", "must be set.");
  if (!AVAILABLE_EXECUTORS.includes(String(shared.executor || "").trim().toLowerCase())) {
    pushIssue(issues, "shared.executor", `must be one of: ${AVAILABLE_EXECUTORS.join(", ")}.`);
  }

  const backends = config?.backends;
  if (!backends || typeof backends !== "object") { pushIssue(issues, "backends", "is required."); return issues; }

  const targets = selected && AVAILABLE_BACKENDS.includes(selected)
    ? [selected]
    : AVAILABLE_BACKENDS.filter((n) => backends[n]?.enabled);
  if (!targets.length) pushIssue(issues, "backends", "at least one backend must be enabled.");

  for (const b of targets) {
    const bc = backends[b];
    if (!bc || typeof bc !== "object") { pushIssue(issues, `backends.${b}`, "is required."); continue; }
    if (bc.enabled === false) { pushIssue(issues, `backends.${b}.enabled`, "must be true for the selected backend."); continue; }
    if (!isNonEmptyString(bc.sessionsDb)) pushIssue(issues, `backends.${b}.sessionsDb`, "must be set.");
    if (b === "claude" && !CLAUDE_PERMISSION_MODES.includes(String(bc.permissionMode || "").trim())) {
      pushIssue(issues, "backends.claude.permissionMode", `must be one of: ${CLAUDE_PERMISSION_MODES.join(", ")}.`);
    }
    if (b === "gemini") {
      if (!isNonEmptyString(bc.oauthClientId)) pushIssue(issues, "backends.gemini.oauthClientId", "must be set when Gemini is enabled.");
      if (!isNonEmptyString(bc.oauthClientSecret)) pushIssue(issues, "backends.gemini.oauthClientSecret", "must be set when Gemini is enabled.");
    }
  }
  return issues;
}

export function validateResolvedEnv(env, options = {}) {
  const issues = [];
  const selected = normalizeBackendName(options.backend || env.DEFAULT_BACKEND);
  const cwd = isNonEmptyString(env.CC_CWD) ? env.CC_CWD : homeDir();

  if (!AVAILABLE_BACKENDS.includes(selected)) pushIssue(issues, "DEFAULT_BACKEND", `must be one of: ${AVAILABLE_BACKENDS.join(", ")}.`);
  ensureExistingDirectory(issues, "CC_CWD", cwd);
  if (isNonEmptyString(env.SESSIONS_DB)) ensureParentDirectoryExists(issues, "SESSIONS_DB", env.SESSIONS_DB);
  if (isNonEmptyString(env.TASKS_DB)) ensureParentDirectoryExists(issues, "TASKS_DB", env.TASKS_DB);

  const verbose = parseInteger(env.DEFAULT_VERBOSE_LEVEL);
  if (env.DEFAULT_VERBOSE_LEVEL != null && String(env.DEFAULT_VERBOSE_LEVEL).trim() !== "" && (verbose == null || verbose < 0 || verbose > 2)) {
    pushIssue(issues, "DEFAULT_VERBOSE_LEVEL", "must be an integer between 0 and 2.");
  }
  if (isNonEmptyString(env.BRIDGE_EXECUTOR) && !AVAILABLE_EXECUTORS.includes(String(env.BRIDGE_EXECUTOR).trim().toLowerCase())) {
    pushIssue(issues, "BRIDGE_EXECUTOR", `must be one of: ${AVAILABLE_EXECUTORS.join(", ")}.`);
  }
  if (selected === "claude" && isNonEmptyString(env.CC_PERMISSION_MODE) && !CLAUDE_PERMISSION_MODES.includes(String(env.CC_PERMISSION_MODE).trim())) {
    pushIssue(issues, "CC_PERMISSION_MODE", `must be one of: ${CLAUDE_PERMISSION_MODES.join(", ")}.`);
  }
  if (selected === "gemini") {
    if (!isNonEmptyString(env.GEMINI_OAUTH_CLIENT_ID)) pushIssue(issues, "GEMINI_OAUTH_CLIENT_ID", "must be set.");
    if (!isNonEmptyString(env.GEMINI_OAUTH_CLIENT_SECRET)) pushIssue(issues, "GEMINI_OAUTH_CLIENT_SECRET", "must be set.");
  }
  return issues;
}

export function formatValidationIssues(issues, heading = "Invalid configuration") {
  if (!issues.length) return heading;
  return [heading, ...issues.map((i, idx) => `${idx + 1}. ${i.path}: ${i.message}`)].join("\n");
}

export function inspectRuntime(runtime) {
  const warnings = [];
  const errors = validateResolvedEnv(runtime.env, { backend: runtime.backend });
  const cwd = isNonEmptyString(runtime.env.CC_CWD) ? runtime.env.CC_CWD : homeDir();
  const sessionsDb = isNonEmptyString(runtime.env.SESSIONS_DB) ? runtime.env.SESSIONS_DB : join(REPO_DIR, "sessions.db");
  const tasksDb = isNonEmptyString(runtime.env.TASKS_DB) ? runtime.env.TASKS_DB : join(REPO_DIR, "tasks.db");

  const cred = getBackendCredentialWarning(runtime.backend);
  if (!existsSync(cred.path)) warnings.push({ path: cred.path, message: cred.message });

  return { backend: runtime.backend, source: runtime.source, configPath: runtime.configPath, cwd, sessionsDb, tasksDb, errors, warnings };
}

// ── Workspace bootstrap ──

export function bootstrapWorkspace(options = {}) {
  const selected = normalizeBackendName(options.backend || "claude");
  if (!AVAILABLE_BACKENDS.includes(selected)) throw new Error(`Unsupported backend: ${selected}`);

  const configPath = options.configPath ? resolve(options.configPath) : DEFAULT_CONFIG_PATH;
  const filesDir = join(dirname(configPath), "files");
  const exists = existsSync(configPath);

  if (exists && !options.force) {
    mkdirSync(filesDir, { recursive: true });
    return { created: false, overwritten: false, configPath, filesDir, backend: selected };
  }

  const config = createBootstrapConfig(selected);
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  mkdirSync(filesDir, { recursive: true });
  return { created: true, overwritten: exists, configPath, filesDir, backend: selected, config };
}

// ── CLI 参数解析 ──

export function resolveCliArgs(argv) {
  const args = argv.slice(2);
  let command = "start";
  let backend = "claude";
  let backendSpecified = false;
  let configPath = process.env.BRIDGE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  let help = false;
  let force = false;

  if (args[0] && !args[0].startsWith("-")) command = args.shift();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--backend" || arg === "-b") { backend = normalizeBackendName(args[++i]); backendSpecified = true; continue; }
    if (arg === "--config" || arg === "-c") { configPath = resolve(REPO_DIR, args[++i]); continue; }
    if (arg === "--force" || arg === "-f") { force = true; continue; }
    if (arg === "--help" || arg === "-h") { help = true; continue; }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
  }

  return { command, backend, backendSpecified, configPath: resolve(configPath), help, force };
}

// ── 加载运行时配置 ──

export function loadRuntimeConfig(options = {}) {
  const backend = normalizeBackendName(options.backend);
  const configPath = options.configPath ? resolve(options.configPath) : DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    throw new Error(`Missing config file: ${configPath}. Run \`bun run bootstrap --backend ${backend}\`.`);
  }

  const config = parseJsonConfig(configPath);
  const configIssues = validateConfig(config, { backend, configPath });
  if (configIssues.length) throw new Error(formatValidationIssues(configIssues, `Invalid config: ${configPath}`));

  const runtime = {
    backend,
    configPath,
    source: configPath.split("/").pop(),
    env: buildEnvFromConfig(config, backend, configPath),
    config,
  };
  const runtimeIssues = validateResolvedEnv(runtime.env, { backend });
  if (runtimeIssues.length) throw new Error(formatValidationIssues(runtimeIssues, `Invalid runtime for "${backend}"`));
  return runtime;
}

export function applyRuntimeEnv(env) {
  for (const [k, v] of Object.entries(env)) {
    if (v != null) process.env[k] = String(v);
  }
}

function redactValue(key, value) {
  if (!value) return value;
  if (!/(TOKEN|SECRET|PASSWORD)/i.test(key)) return value;
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function summarizeRuntime(runtime) {
  const profile = getBackendProfile(runtime.backend);
  return {
    source: runtime.source,
    backend: runtime.backend,
    backendProfile: { label: profile.label, maturity: profile.maturity, summary: profile.summary },
    configPath: runtime.configPath,
    env: Object.fromEntries(Object.entries(runtime.env).map(([k, v]) => [k, redactValue(k, v)])),
  };
}

// ── 交互式设置向导 ──

async function askText(rl, label, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const v = (await rl.question(`${label}${suffix}: `)).trim();
  return v || defaultValue;
}

async function askBoolean(rl, label, defaultValue) {
  const suffix = defaultValue ? " [Y/n]" : " [y/N]";
  while (true) {
    const v = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
    if (!v) return defaultValue;
    if (["y", "yes"].includes(v)) return true;
    if (["n", "no"].includes(v)) return false;
  }
}

export async function runSetupWizard(options = {}) {
  const configPath = options.configPath ? resolve(options.configPath) : DEFAULT_CONFIG_PATH;
  const backendOnly = options.backend ? normalizeBackendName(options.backend) : null;
  const existing = existsSync(configPath) ? parseJsonConfig(configPath) : createDefaultConfig();
  const config = mergeConfig(createDefaultConfig(), existing);
  const rl = createInterface({ input, output });

  try {
    console.log("WeChat AI Bridge setup wizard\n");
    console.log(`Config file: ${configPath}`);
    console.log("Press Enter to keep the current value.\n");

    config.shared.cwd = await askText(rl, "Working directory", config.shared.cwd || process.env.HOME || REPO_DIR);
    config.shared.defaultVerboseLevel = Number(await askText(rl, "Default verbose level", String(config.shared.defaultVerboseLevel ?? 1)));
    config.shared.executor = await askText(rl, "Executor mode (direct/local-agent)", config.shared.executor || "direct");
    config.shared.tasksDb = await askText(rl, "Tasks SQLite path", config.shared.tasksDb || "tasks.db");

    const targets = backendOnly ? [backendOnly] : AVAILABLE_BACKENDS;
    for (const b of targets) {
      const profile = getBackendProfile(b);
      console.log(`\n[${b}]`);
      if (profile.summary) console.log(`${profile.label}: ${profile.summary}`);
      const current = config.backends[b] || {};
      const enableLabel = profile.maturity === "experimental" ? `Enable ${b} (experimental)` : `Enable ${b}`;
      current.enabled = await askBoolean(rl, enableLabel, current.enabled ?? false);
      config.backends[b] = current;
      if (!current.enabled) continue;

      current.sessionsDb = await askText(rl, `${b} SQLite path`, current.sessionsDb || `sessions-${b}.db`);
      if (b === "claude") {
        current.model = await askText(rl, "Claude model", current.model || "claude-sonnet-4-6");
        current.permissionMode = await askText(rl, "Claude permission mode", current.permissionMode || "default");
      }
      if (b === "codex") current.model = await askText(rl, "Codex model (optional)", current.model || "");
      if (b === "gemini") {
        current.model = await askText(rl, "Gemini model", current.model || "gemini-2.5-pro");
        current.oauthClientId = await askText(rl, "Gemini OAuth client ID", current.oauthClientId || "");
        current.oauthClientSecret = await askText(rl, "Gemini OAuth client secret", current.oauthClientSecret || "");
        current.googleCloudProject = await askText(rl, "Google Cloud project (optional)", current.googleCloudProject || "");
      }
    }
  } finally {
    rl.close();
  }

  const issues = validateConfig(config, { backend: backendOnly, configPath });
  if (issues.length) throw new Error(formatValidationIssues(issues, "Setup aborted: config incomplete"));

  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return { configPath, config };
}
