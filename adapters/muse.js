// Muse 适配器（实验）：经社区 muse-cli 与 muse.ai 上的个人 agent 对话
//
// 非官方通道：muse-cli 用浏览器登录 Cookie 调 Muse 未版本化的内部接口，
// Cookie 过期或接口变动就会断；用自动化客户端访问 Muse 的账号条款风险由使用者自担。
// 真正和 Muse 打交道的是 muse-helper.py（用 muse-cli 自带的 Python 跑），
// 这里只负责：开侧边对话、把用户发来的图片传进 VM、等回复、把回复里提到的文件取回来。

import { spawn } from "child_process";
import { mkdirSync, realpathSync } from "fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "path";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { resolveHomeDirectory } from "../runtime-paths.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "muse-helper.py");
const FILES_DIR = join(HERE, "..", "files");
// Not under files/: the bridge refuses to send anything from its inbound dir.
// Must sit inside shared.cwd, which defaults to $HOME.
const OUT_DIR = process.env.MUSE_OUT_DIR || join(HERE, "..", "muse-out");
const INBOUND_REMOTE_DIR = "workspace/wechat-in";
const MAX_FILES_PER_TURN = 5;
const TURN_TIMEOUT_S = Number(process.env.MUSE_TURN_TIMEOUT_S) || 1500;

export const MUSE_BRIDGE_HINT = "[系统提示: 你在通过微信跟用户对话（消息经 wechat-ai-bridge 转发）。回复用纯文本，别用 Markdown，微信不渲染。要发给用户的图片或视频，存到 ~/workspace/ 下，并在回复里写出完整路径（例如 ~/workspace/wechat-out/x.mp4），bridge 会把文件取回发到微信，单个文件不超过 20MB。用户发来的图片已经放在 ~/workspace/wechat-in/ 下。]\n\n";

const MEDIA_EXT = "mp4|mov|png|jpe?g|gif|webp";
const VM_PATH_RE = new RegExp(
  String.raw`(?:~\/|\/home\/hatch\/)?(workspace\/[^\s\`'"<>()（）\[\]【】，。；：、]+?\.(?:${MEDIA_EXT}))(?![\w.])`,
  "gi",
);
const INBOUND_MARKER_RE = /\[(图片文件|文件): ([^\]\n]+)\]/g;

function isInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function realOrNull(path) {
  try { return realpathSync(path); } catch { return null; }
}

/** Point the bridge's local inbound-file markers at copies inside the Muse VM.
 * Only files under the bridge's own inbound directory are uploaded. */
export function rewriteInboundMarkers(prompt, inboundDir = FILES_DIR) {
  const root = realOrNull(inboundDir);
  const uploads = [];
  const rewritten = String(prompt).replace(INBOUND_MARKER_RE, (whole, label, rawPath) => {
    const local = realOrNull(rawPath.trim());
    if (!root || !local || !isInside(root, local)) return whole;
    const name = basename(local).replace(/[^\w.-]/g, "_");
    const remote = `${INBOUND_REMOTE_DIR}/${name}`;
    if (!uploads.some(u => u.remote === remote)) uploads.push({ local, remote });
    return `[${label}: ~/${remote}]`;
  });
  return { prompt: rewritten, uploads };
}

/** Media paths Muse mentions in a reply, as VM-relative `workspace/...` paths. */
export function extractMuseFilePaths(text, limit = MAX_FILES_PER_TURN) {
  const found = [];
  for (const match of String(text || "").matchAll(VM_PATH_RE)) {
    const path = match[1];
    if (path.split("/").includes("..") || found.includes(path)) continue;
    found.push(path);
    if (found.length >= limit) break;
  }
  return found;
}

async function* helperEvents(python, args, { input = "", signal } = {}) {
  const child = spawn(python, ["-I", HELPER, ...args], {
    env: { ...process.env, MUSE_NO_UPDATE_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const onAbort = () => child.kill("SIGTERM");
  signal?.addEventListener("abort", onAbort, { once: true });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr = (stderr + d).slice(-2000); });
  const exited = new Promise((resolve) => {
    child.on("close", (code) => resolve(code));
    child.on("error", (err) => { stderr += String(err.message); resolve(-1); });
  });
  child.stdin.on("error", () => {});
  child.stdin.end(input);

  try {
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* not ours */ }
    }
    const code = await exited;
    if (signal?.aborted) {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
    if (code !== 0) yield { type: "exit", code, message: stderr.trim().split("\n").pop() || `muse-helper exit ${code}` };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (child.exitCode === null) child.kill("SIGTERM");
  }
}

async function runHelper(python, args, options) {
  let last = null;
  let error = null;
  for await (const ev of helperEvents(python, args, options)) {
    if (ev.type === "error") error = error || ev;
    else if (ev.type === "exit") error = error || ev;
    else last = ev;
  }
  return error || last || { type: "error", message: "muse-helper 没有输出" };
}

function failed(text, started) {
  return { type: "result", success: false, text, cost: null, duration: Date.now() - started };
}

export function createAdapter(config = {}) {
  const python = process.env.MUSE_PYTHON
    || join(resolveHomeDirectory(), ".local", "share", "uv", "tools", "muse-cli", "bin", "python");
  // thread → seq of the last reply handed to WeChat; lets the next turn pick up
  // anything Muse said after we stopped waiting. In memory only.
  const lastSeq = new Map();

  return {
    name: "muse",
    label: "Muse",
    icon: "🟣",
    bridgeHint: MUSE_BRIDGE_HINT,

    availableModels() {
      return [{ id: "__default__", label: "Muse 默认" }];
    },

    async *streamQuery(prompt, sessionId, abortSignal, overrides = {}) {
      const started = Date.now();
      let sid = sessionId;
      if (!sid) {
        const day = new Date().toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
        const ev = await runHelper(python, ["new-thread", `微信 ${day}`], { signal: abortSignal });
        if (!ev.session_id) { yield failed(`开 Muse 对话失败: ${ev.message || "unknown"}`, started); return; }
        sid = ev.session_id;
      }
      yield { type: "session_init", sessionId: sid };

      const { prompt: text, uploads } = rewriteInboundMarkers(prompt);
      for (const u of uploads) {
        yield { type: "progress", toolName: "upload", detail: `上传 ${basename(u.local)} 到 Muse` };
        const ev = await runHelper(python, ["put", u.local, u.remote], { signal: abortSignal });
        if (ev.type !== "uploaded") { yield failed(`图片传给 Muse 失败: ${ev.message || "unknown"}`, started); return; }
      }

      let reply = null;
      let error = null;
      const missed = [];
      const turnArgs = ["turn", sid, String(TURN_TIMEOUT_S), String(lastSeq.get(sid) ?? "")];
      for await (const ev of helperEvents(python, turnArgs, { input: text, signal: abortSignal })) {
        if (ev.type === "heartbeat") yield { type: "progress", toolName: "muse", detail: `Muse 处理中 ${ev.seconds}s` };
        else if (ev.type === "missed") missed.push(ev.text);
        else if (ev.type === "reply") reply = ev;
        else if (ev.type === "error" || ev.type === "exit") error = error || ev.message;
      }
      if (!reply) { yield failed(error || "Muse 没有回复", started); return; }
      lastSeq.set(sid, reply.seq);

      let resultText = missed.length
        ? `（上一条之后 Muse 还说了）\n${missed.join("\n\n")}\n\n———\n\n${reply.text}`
        : reply.text;

      const remotes = extractMuseFilePaths([...missed, reply.text].join("\n"));
      if (remotes.length) mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
      for (const remote of remotes) {
        yield { type: "progress", toolName: "download", detail: `从 Muse 取回 ${basename(remote)}` };
        const local = join(OUT_DIR, `${Date.now()}-${basename(remote)}`);
        const ev = await runHelper(python, ["get", remote, local], { signal: abortSignal });
        if (ev.type === "downloaded") yield { type: "file_written", filePath: local, tool: "muse" };
        else resultText += `\n\n（${basename(remote)} 没能取回：${ev.message || "unknown"}）`;
      }

      yield { type: "text", text: resultText };
      yield { type: "result", success: true, text: resultText, cost: null, duration: Date.now() - started };
    },

    statusInfo() {
      return { model: "Muse", cwd: "Muse VM (muse.ai)", mode: "muse-cli（非官方，实验）" };
    },
  };
}
