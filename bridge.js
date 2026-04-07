#!/usr/bin/env bun
// WeChat → AI Bridge（多后端：Claude Agent SDK / Codex SDK / Gemini）

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "fs";
import { basename, join } from "path";
import {
  getSession,
  setSession,
  deleteSession,
  recentSessions,
  getChatModel,
  setChatModel,
  deleteChatModel,
  getChatEffort,
  setChatEffort,
  deleteChatEffort,
  getChatBackend,
  setChatBackend,
} from "./sessions.js";
import {
  createTask,
  markTaskStarted,
  setTaskApprovalRequired,
  markTaskApproved,
  markTaskRejected,
  completeTask,
  failTask,
} from "./tasks.js";
import { createProgressTracker } from "./progress.js";
import { createBackend, AVAILABLE_BACKENDS } from "./adapters/interface.js";
import { createExecutor } from "./executor/interface.js";
import { getBackendProfile } from "./config.js";
import { createFlushGate } from "./flush-gate.js";
import { createRateLimiter } from "./rate-limiter.js";
import { createDirManager } from "./dir-manager.js";
import { createIdleMonitor } from "./idle-monitor.js";
import { protectFileReferences } from "./file-ref-protect.js";
import { createMonitor } from "./weixin/monitor.js";
import { sendText, sendLongText, sendImage, sendFile } from "./weixin/send.js";
import { ItemType } from "./weixin/types.js";
import { downloadImage, downloadFile as downloadMediaFile, uploadMedia } from "./weixin/media.js";

// 防止嵌套检测
delete process.env.CLAUDECODE;

// ── 配置 ──
const WECHAT_BOT_TOKEN = process.env.WECHAT_BOT_TOKEN;
const CC_CWD = process.env.CC_CWD || process.env.HOME;
const DEFAULT_VERBOSE = Number(process.env.DEFAULT_VERBOSE_LEVEL || 1);
const DEFAULT_BACKEND = process.env.DEFAULT_BACKEND || "claude";
const REQUESTED_BACKENDS = String(process.env.ENABLED_BACKENDS || AVAILABLE_BACKENDS.join(","))
  .split(",").map(v => v.trim().toLowerCase())
  .filter((v, i, a) => v && AVAILABLE_BACKENDS.includes(v) && a.indexOf(v) === i);
const RATE_LIMIT_MAX_REQUESTS = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60000);
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS || 1800000);
const RESET_ON_IDLE_MS = Number(process.env.RESET_ON_IDLE_MS || 0);
const EXECUTOR_MODE = String(process.env.BRIDGE_EXECUTOR || "direct").trim().toLowerCase();

// ── 初始化后端适配器 ──
const adapters = {};
for (const name of REQUESTED_BACKENDS) {
  try {
    adapters[name] = createBackend(name, { cwd: CC_CWD });
  } catch (e) {
    console.warn(`[适配器] ${name} 初始化失败: ${e.message}`);
  }
}
const ACTIVE_BACKENDS = AVAILABLE_BACKENDS.filter(n => adapters[n]);

function getFallbackBackend() {
  return ACTIVE_BACKENDS[0] || DEFAULT_BACKEND || "claude";
}

if (!ACTIVE_BACKENDS.length) {
  console.error("FATAL: no backend available. Check config.json.");
  process.exit(1);
}

// ── 初始化模块 ──
const rateLimiter = createRateLimiter({
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
  windowMs: RATE_LIMIT_WINDOW_MS,
});

const dirManager = createDirManager(CC_CWD);

const idleMonitor = createIdleMonitor({
  idleTimeoutMs: IDLE_TIMEOUT_MS,
  resetOnIdleMs: RESET_ON_IDLE_MS,
  onTimeout: async (chatId) => {
    console.log(`[idle] chatId=${chatId} 处理超时`);
  },
});

const flushGate = createFlushGate({
  batchDelayMs: 800,
  maxBufferSize: 5,
  onBuffered: async (_chatId, ctx) => {
    sendText(WECHAT_BOT_TOKEN, ctx.userId, "📥 已收到，会在当前任务完成后一起处理。", ctx.contextToken).catch(() => {});
  },
});

function resolveBackend(chatId, backendName = null) {
  // 优先用指定的 → 再用 per-chat 设置 → 最后用默认
  const chosen = backendName || getChatBackend(chatId) || null;
  const effective = chosen && adapters[chosen] ? chosen : getFallbackBackend();
  return { backendName: effective, adapter: adapters[effective] || null };
}

function getAdapter(chatId) { return resolveBackend(chatId).adapter; }
function getBackendName(chatId) { return resolveBackend(chatId).backendName; }

const executor = createExecutor(EXECUTOR_MODE, { resolveBackend });

// ── 内存状态 ──
const verboseSettings = new Map();
const pendingInteractions = new Map(); // chatId -> { type, resolve, options?, cleanup? }
const chatPermState = new Map();
const chatAbortControllers = new Map();

// ── 工具函数 ──

/** 微信用户 ID → 数字 chatId（sessions.db 用 INTEGER） */
function userIdToNumeric(userId) {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) || 1;
}

/** 提取收到消息中的文本 */
function extractText(msg) {
  for (const item of msg.item_list || []) {
    if (item.type === ItemType.TEXT && item.text_item?.text) {
      return item.text_item.text.trim();
    }
  }
  return "";
}

/** 发长文本（自动分段 + 文件引用保护） */
async function weSendLong(userId, text, contextToken) {
  text = protectFileReferences(text);
  await sendLongText(WECHAT_BOT_TOKEN, userId, text, contextToken);
}

/** 从文本中提取可发送的文件路径 */
const SENDABLE_EXT_GROUP = "png|jpg|jpeg|gif|webp|pdf|docx|xlsx|csv|html|svg|txt|md|json|js|ts|py|sh|yaml|yml|xml|log|zip|tar|gz";

function extractFilePathsFromText(text, fileList) {
  const HOME = process.env.HOME || "";
  const existing = new Set(fileList.map(f => f.filePath));
  const absRe = new RegExp(`(\\/(?:[\\w.\\-]+\\/)*[\\w.\\-\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef ]+\\.(?:${SENDABLE_EXT_GROUP}))`, "gi");
  const tildeRe = new RegExp(`(~\\/(?:[\\w.\\-]+\\/)*[\\w.\\-\\u4e00-\\u9fff\\u3000-\\u303f\\uff00-\\uffef ]+\\.(?:${SENDABLE_EXT_GROUP}))`, "gi");

  function add(p) {
    const resolved = p.startsWith("~/") ? p.replace("~", HOME) : p.trim();
    if (!existing.has(resolved)) { existing.add(resolved); fileList.push({ filePath: resolved, source: "text_scan" }); }
  }
  for (const m of text.match(absRe) || []) add(m);
  for (const m of text.match(tildeRe) || []) add(m);
}

function summarizeText(text, maxLen = 120) {
  const n = String(text || "").replace(/\s+/g, " ").trim();
  return !n ? "" : n.length > maxLen ? `${n.slice(0, maxLen - 3)}...` : n;
}

/** 快捷回复检测 */
function detectQuickReplies(text) {
  const tail = text.slice(-300);
  if (/要(吗|不要|么)[？?]?\s*$/.test(tail)) return ["要", "不要"];
  if (/好(吗|不好|么)[？?]?\s*$/.test(tail)) return ["好", "不好"];
  if (/是(吗|不是|么)[？?]?\s*$/.test(tail)) return ["是", "不是"];
  if (/对(吗|不对|么)[？?]?\s*$/.test(tail)) return ["对", "不对"];
  if (/可以(吗|么)[？?]?\s*$/.test(tail)) return ["可以", "不用了"];
  if (/继续(吗|么)[？?]?\s*$/.test(tail)) return ["继续", "算了"];
  if (/确认(吗|么)[？?]?\s*$/.test(tail)) return ["确认", "取消"];

  const breakIdx = text.lastIndexOf("\n\n");
  const block = breakIdx >= 0 && text.length - breakIdx < 600 ? text.slice(breakIdx) : text.slice(-500);
  const re = /(?:^|\n)\s*(\d+)[.、)）]\s*(.+)/g;
  const opts = [];
  let m;
  while ((m = re.exec(block)) !== null) {
    opts.push(`${m[1]}. ${m[2].trim().split("\n")[0].slice(0, 40)}`);
  }
  if (opts.length >= 2 && opts.length <= 6) return opts;
  return null;
}

// ── Tool Approval（工具审批）──

function getPermState(chatId) {
  if (!chatPermState.has(chatId)) chatPermState.set(chatId, { alwaysAllowed: new Set(), yolo: false });
  return chatPermState.get(chatId);
}

function formatToolInput(toolName, input) {
  if (toolName === "Bash" && input.command) {
    return (input.description ? `${input.description}\n${input.command}` : input.command).slice(0, 300);
  }
  if (["Edit", "Write", "Read"].includes(toolName) && input.file_path) return input.file_path;
  const json = JSON.stringify(input, null, 2);
  return json.length > 300 ? json.slice(0, 300) + "..." : json;
}

function createPermissionHandler(ctx, taskId) {
  const chatId = ctx.chatId;

  return async (toolName, input, sdkOptions) => {
    const state = getPermState(chatId);

    if (state.yolo) {
      if (taskId) markTaskApproved(taskId, toolName);
      return { behavior: "allow", toolUseID: sdkOptions.toolUseID };
    }
    if (state.alwaysAllowed.has(toolName)) {
      if (taskId) markTaskApproved(taskId, toolName);
      return { behavior: "allow", updatedPermissions: sdkOptions.suggestions || [], toolUseID: sdkOptions.toolUseID };
    }

    // 发送数字选择
    const display = formatToolInput(toolName, input);
    const reason = sdkOptions.decisionReason ? `\n${sdkOptions.decisionReason}` : "";
    if (taskId) setTaskApprovalRequired(taskId, toolName);

    const text = `🔒 工具审批\n\n工具: ${toolName}${reason}\n${display}\n\n请回复数字:\n1. 允许\n2. 拒绝\n3. 始终允许 "${toolName}"\n4. YOLO（全部允许）`;
    await sendText(WECHAT_BOT_TOKEN, ctx.userId, text, ctx.contextToken);

    return new Promise((promiseResolve) => {
      const timeout = setTimeout(() => {
        pendingInteractions.delete(chatId);
        if (taskId) markTaskRejected(taskId, toolName);
        promiseResolve({ behavior: "deny", message: "审批超时（5分钟）", toolUseID: sdkOptions.toolUseID });
      }, 5 * 60 * 1000);

      pendingInteractions.set(chatId, {
        type: "permission",
        resolve: (userInput) => {
          clearTimeout(timeout);
          const num = parseInt(userInput.trim());
          if (num === 1) {
            if (taskId) markTaskApproved(taskId, toolName);
            promiseResolve({ behavior: "allow", toolUseID: sdkOptions.toolUseID });
          } else if (num === 3) {
            state.alwaysAllowed.add(toolName);
            if (taskId) markTaskApproved(taskId, toolName);
            promiseResolve({ behavior: "allow", updatedPermissions: sdkOptions.suggestions || [], toolUseID: sdkOptions.toolUseID });
          } else if (num === 4) {
            state.yolo = true;
            if (taskId) markTaskApproved(taskId, toolName);
            promiseResolve({ behavior: "allow", toolUseID: sdkOptions.toolUseID });
          } else {
            if (taskId) markTaskRejected(taskId, toolName);
            promiseResolve({ behavior: "deny", message: "用户拒绝", toolUseID: sdkOptions.toolUseID });
          }
        },
        cleanup: () => clearTimeout(timeout),
      });
    });
  };
}

// ── 核心：processPrompt ──

async function processPrompt(ctx, prompt) {
  const chatId = ctx.chatId;
  const adapter = getAdapter(chatId);
  const backendName = getBackendName(chatId);
  const verboseLevel = verboseSettings.get(chatId) ?? DEFAULT_VERBOSE;
  const progress = createProgressTracker(WECHAT_BOT_TOKEN, ctx.userId, ctx.contextToken, verboseLevel, adapter.label);
  const taskId = createTask({
    chatId,
    backend: backendName,
    executor: executor.name,
    capability: "ai_turn",
    action: "stream_query",
    promptSummary: summarizeText(prompt, 120),
  });
  let taskFinalized = false;

  function finalizeSuccess(summary = "") {
    if (!taskFinalized) { completeTask(taskId, summary); taskFinalized = true; }
  }
  function finalizeFailure(summary = "", errorCode = "RESULT_ERROR") {
    if (!taskFinalized) { failTask(taskId, summary, errorCode); taskFinalized = true; }
  }

  try {
    markTaskStarted(taskId);
    idleMonitor.startProcessing(chatId);
    await progress.start();

    // 注入 bridge 行为指令
    const bridgeHint = "[系统提示: 你通过微信 Bridge 与用户对话。当用户要求发送文件、截图或查看图片时：1) 用工具找到/生成文件 2) 在回复中包含文件的完整绝对路径（如 /Users/xxx/file.png），bridge 会自动检测路径并发送给用户。绝对不要自己调用 curl 或任何 API。]\n\n";
    const fullPrompt = bridgeHint + prompt;
    const session = getSession(chatId);
    const sessionId = (session && session.backend === backendName) ? session.session_id : null;

    let capturedSessionId = sessionId || null;
    let resultText = "";
    let resultSuccess = true;
    const capturedImages = [];  // { data, mediaType }
    const capturedFiles = [];

    const abortController = new AbortController();
    chatAbortControllers.set(chatId, abortController);

    const startTime = Date.now();
    const WATCHDOG_MS = 15 * 60 * 1000;
    const watchdog = setTimeout(() => {
      console.warn(`[watchdog] chatId=${chatId} 已运行 15 分钟`);
    }, WATCHDOG_MS);

    const modelOverride = getChatModel(chatId);
    const effortOverride = getChatEffort(chatId);
    const chatCwd = dirManager.current(chatId);
    const streamOverrides = {
      ...(modelOverride ? { model: modelOverride } : {}),
      ...(effortOverride ? { effort: effortOverride } : {}),
      ...(chatCwd !== CC_CWD ? { cwd: chatCwd } : {}),
    };

    if (backendName === "claude") {
      streamOverrides.requestPermission = createPermissionHandler(ctx, taskId);
    }

    try {
      for await (const event of executor.streamTask({
        chatId,
        backendName,
        prompt: fullPrompt,
        sessionId,
      }, abortController.signal, streamOverrides)) {
        if (event.type === "session_init") {
          capturedSessionId = event.sessionId;
        }

        // AskUserQuestion: 发送带编号的选项（用户回复数字，作为新 prompt）
        if (event.type === "question") {
          let qText = event.header ? `${event.header}\n\n` : "";
          qText += `❓ ${event.question}\n`;
          for (let i = 0; i < event.options.length; i++) {
            const opt = event.options[i];
            qText += `\n${i + 1}. ${opt.label}`;
            if (opt.description) qText += `\n   ${opt.description}`;
          }
          qText += "\n\n请回复对应数字：";
          await sendText(WECHAT_BOT_TOKEN, ctx.userId, qText, ctx.contextToken);

          pendingInteractions.set(chatId, {
            type: "question",
            options: event.options.map(o => o.label),
          });
        }

        // 收集图片/文件
        if (event.type === "image" && capturedImages.length < 10) {
          capturedImages.push(event);
        }
        if (event.type === "file_persisted") {
          capturedFiles.push({ filePath: event.filename, source: "persisted" });
        }
        if (event.type === "file_written") {
          capturedFiles.push({ filePath: event.filePath, source: event.tool });
        }
        if (event.type === "text" && event.text) {
          extractFilePathsFromText(event.text, capturedFiles);
        }

        idleMonitor.heartbeat(chatId);
        progress.processEvent(event);

        if (event.type === "result") {
          resultSuccess = event.success;
          resultText = event.text || "";
          extractFilePathsFromText(resultText, capturedFiles);
          const costStr = event.cost != null ? ` $${event.cost.toFixed(4)}` : "";
          const durStr = event.duration != null ? ` ${event.duration}ms` : "";
          console.log(`[${adapter.label}] ${resultSuccess ? "ok" : "err"}${durStr}${costStr}`);
        }
      }
    } catch (err) {
      if (err.name === "AbortError" || err.message?.includes("aborted")) {
        resultText = "";
        resultSuccess = true;
        console.log(`[${adapter.label}] 已取消`);
      } else {
        resultText = `SDK 错误: ${err.message}`;
        resultSuccess = false;
        console.error(`[${adapter.label}] SDK 异常: ${err.message}`);
        finalizeFailure(summarizeText(resultText, 240), "EXECUTOR_ERROR");
      }
    } finally {
      clearTimeout(watchdog);
      idleMonitor.stopProcessing(chatId);
      chatAbortControllers.delete(chatId);
    }

    // 保存 session
    if (capturedSessionId) {
      setSession(chatId, capturedSessionId, prompt.slice(0, 30), backendName, "owned");
    }

    // 结束进度
    const durationMs = Date.now() - startTime;
    await progress.finish({ durationMs });

    // 详细度 >=1 时发工具调用摘要
    if (verboseLevel >= 1 && resultSuccess) {
      const summary = progress.getSummary(durationMs);
      if (summary) await sendText(WECHAT_BOT_TOKEN, ctx.userId, summary, ctx.contextToken).catch(() => {});
    }

    // 文件/图片回传：CDN 上传 + 发送
    if (resultSuccess && capturedFiles.length > 0) {
      const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
      const DOC_EXTS = new Set([".pdf", ".docx", ".xlsx", ".csv", ".html", ".txt", ".md", ".json", ".js", ".ts", ".py", ".sh", ".yaml", ".yml", ".xml", ".log", ".zip", ".tar", ".gz"]);
      const HOME = process.env.HOME || "";
      const sentPaths = new Set();
      for (const f of capturedFiles) {
        if (!f.filePath) continue;
        const resolved = f.filePath.startsWith("~/") ? f.filePath.replace("~", HOME) : f.filePath;
        if (sentPaths.has(resolved)) continue;
        const ext = resolved.slice(resolved.lastIndexOf(".")).toLowerCase();
        if (!IMAGE_EXTS.has(ext) && !DOC_EXTS.has(ext)) continue;
        if (!existsSync(resolved)) continue;
        sentPaths.add(resolved);
        const fileName = basename(resolved);
        console.log(`[Bridge] 发送文件: ${fileName} (来源: ${f.source})`);
        try {
          const fileData = readFileSync(resolved);
          if (fileData.length > 20 * 1024 * 1024) {
            console.log(`[Bridge] 跳过大文件: ${fileName} (${Math.round(fileData.length / 1024 / 1024)}MB)`);
            continue;
          }
          if (IMAGE_EXTS.has(ext)) {
            const ref = await uploadMedia(WECHAT_BOT_TOKEN, fileData, fileName, 1, ctx.userId);
            await sendImage(WECHAT_BOT_TOKEN, ctx.userId, ctx.contextToken, ref);
          } else {
            const ref = await uploadMedia(WECHAT_BOT_TOKEN, fileData, fileName, 3, ctx.userId);
            await sendFile(WECHAT_BOT_TOKEN, ctx.userId, ctx.contextToken, ref);
          }
        } catch (e) {
          console.error(`[Bridge] 文件发送失败 (${fileName}): ${e.message}`);
        }
      }
    }

    // base64 图片回传（AI 直接返回的图片数据）
    if (resultSuccess && capturedImages.length > 0) {
      for (const img of capturedImages) {
        try {
          const buf = Buffer.from(img.data, "base64");
          if (buf.length > 10 * 1024 * 1024) continue;
          const ext = (img.mediaType || "image/png").split("/")[1] || "png";
          const ref = await uploadMedia(WECHAT_BOT_TOKEN, buf, `output.${ext}`, 1, ctx.userId);
          await sendImage(WECHAT_BOT_TOKEN, ctx.userId, ctx.contextToken, ref);
        } catch (e) {
          console.error(`[Bridge] base64 图片发送失败: ${e.message}`);
        }
      }
    }

    // 发送最终结果
    if (resultText) resultText = protectFileReferences(resultText);
    if (!resultSuccess) {
      finalizeFailure(summarizeText(resultText, 240), "RESULT_ERROR");
      await weSendLong(ctx.userId, `${adapter.label} 错误: ${resultText}`, ctx.contextToken);
    } else if (resultText) {
      finalizeSuccess(summarizeText(resultText, 240));
      // 快捷回复检测
      const replies = detectQuickReplies(resultText);
      if (replies) {
        const replyText = replies.map((r, i) => `${i + 1}. ${r}`).join("\n");
        await weSendLong(ctx.userId, `${resultText}\n\n快捷回复：\n${replyText}`, ctx.contextToken);
        pendingInteractions.set(chatId, { type: "quick_reply", options: replies });
      } else {
        await weSendLong(ctx.userId, resultText, ctx.contextToken);
      }
    } else {
      finalizeSuccess("");
      await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.label} 无输出。`, ctx.contextToken);
    }

    // 新会话提示
    if (capturedSessionId && capturedSessionId !== sessionId) {
      await sendText(WECHAT_BOT_TOKEN, ctx.userId,
        `${adapter.icon} 新会话 ${capturedSessionId.slice(0, 8)}...`,
        ctx.contextToken,
      ).catch(() => {});
    }
  } catch (e) {
    finalizeFailure(summarizeText(e.message, 240), "BRIDGE_ERROR");
    await progress.finish();
    await sendText(WECHAT_BOT_TOKEN, ctx.userId, `桥接错误: ${e.message}`, ctx.contextToken).catch(() => {});
  }
}

// ── submitAndWait ──

async function submitAndWait(ctx, prompt) {
  const chatId = ctx.chatId;
  if (idleMonitor.shouldAutoReset(chatId)) {
    deleteSession(chatId);
    await sendText(WECHAT_BOT_TOKEN, ctx.userId, "🔄 长时间未活跃，已自动开启新会话。", ctx.contextToken).catch(() => {});
  }
  idleMonitor.touch(chatId);
  await flushGate.enqueue(chatId, { ctx, prompt }, processPrompt);
}

// ── 命令处理 ──

async function handleCommand(ctx, text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(" ").trim();
  const chatId = ctx.chatId;

  switch (cmd) {
    case "/help": {
      const adapter = getAdapter(chatId);
      await sendText(WECHAT_BOT_TOKEN, ctx.userId, [
        `WeChat AI Bridge — ${adapter.icon} ${adapter.label}`,
        "",
        "📋 会话管理",
        "/new — 开启新会话",
        "/cancel — 中断当前任务",
        "/sessions — 查看历史会话",
        "/resume <id> — 恢复指定会话",
        "",
        "⚙️ 设置",
        "/backend [name] — 切换后端 (claude/codex/gemini)",
        "/model [name] — 切换模型",
        "/effort [level] — 切换思考深度",
        "/dir [path] — 切换工作目录",
        "/verbose [0-2] — 输出详细度",
        "",
        "📊 状态",
        "/status — 当前状态",
        "",
        "💡 直接发文字即可与 AI 对话",
      ].join("\n"), ctx.contextToken);
      break;
    }

    case "/cancel": {
      const controller = chatAbortControllers.get(chatId);
      if (controller) {
        controller.abort();
        chatAbortControllers.delete(chatId);
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, "⏹ 已发送中断信号。", ctx.contextToken);
      } else {
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, "当前没有正在执行的任务。", ctx.contextToken);
      }
      break;
    }

    case "/new": {
      deleteSession(chatId);
      chatPermState.delete(chatId);
      const adapter = getAdapter(chatId);
      await sendText(WECHAT_BOT_TOKEN, ctx.userId, `会话已重置，下条消息将开启新 ${adapter.label} 会话。`, ctx.contextToken);
      break;
    }

    case "/resume": {
      if (!args) {
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, "用法: /resume <session-id>\n也可以用 /sessions 查看列表。", ctx.contextToken);
        break;
      }
      const backend = getBackendName(chatId);
      const adapter = getAdapter(chatId);
      setSession(chatId, args, "", backend, "owned");
      await sendText(WECHAT_BOT_TOKEN, ctx.userId,
        `${adapter.icon} 已绑定会话 ${args.slice(0, 8)}...（${backend}）\n后续消息继续此 session。`,
        ctx.contextToken,
      );
      break;
    }

    case "/sessions": {
      const backend = getBackendName(chatId);
      const sessions = recentSessions(10, { chatId, backend, ownership: "owned" });
      if (!sessions.length) {
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, "没有找到历史会话。", ctx.contextToken);
        break;
      }
      const current = getSession(chatId);
      const lines = sessions.map((s, i) => {
        const mark = current && current.session_id === s.session_id ? " ✦" : "";
        const time = new Date(s.last_active).toISOString().slice(5, 16).replace("T", " ");
        const name = s.display_name ? ` · ${s.display_name.slice(0, 20)}` : "";
        return `${i + 1}. ${s.session_id.slice(0, 8)}...${name} · ${time}${mark}`;
      });
      await sendText(WECHAT_BOT_TOKEN, ctx.userId,
        `历史会话：\n${lines.join("\n")}\n\n回复 /resume <id> 恢复`,
        ctx.contextToken,
      );
      break;
    }

    case "/status": {
      const adapter = getAdapter(chatId);
      const backendName = getBackendName(chatId);
      const session = getSession(chatId);
      const verbose = verboseSettings.get(chatId) ?? DEFAULT_VERBOSE;
      const modelOverride = getChatModel(chatId);
      const effortOverride = getChatEffort(chatId);
      const info = adapter.statusInfo(modelOverride, effortOverride);
      const sessionLine = session ? `当前会话: ${session.session_id.slice(0, 8)}...` : "当前会话: 无";
      await sendText(WECHAT_BOT_TOKEN, ctx.userId, [
        `${adapter.icon} 后端: ${adapter.label} (${backendName})`,
        `模式: ${info.mode}`,
        `模型: ${info.model}`,
        `思考深度: ${info.effort || "默认"}`,
        `工作目录: ${dirManager.current(chatId)}`,
        sessionLine,
        `进度详细度: ${verbose}`,
      ].join("\n"), ctx.contextToken);
      break;
    }

    case "/model": {
      const adapter = getAdapter(chatId);
      if (!args) {
        const models = typeof adapter.availableModels === "function" ? adapter.availableModels() : [];
        if (!models.length) {
          await sendText(WECHAT_BOT_TOKEN, ctx.userId, "当前后端不支持模型切换。", ctx.contextToken);
          break;
        }
        const lines = models.map((m, i) => `${i + 1}. ${m.label || m.id}`);
        lines.push(`${models.length + 1}. 恢复默认`);
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, `选择模型:\n${lines.join("\n")}`, ctx.contextToken);
        pendingInteractions.set(chatId, {
          type: "model_select",
          resolve: async (input) => {
            const num = parseInt(input.trim());
            if (num === models.length + 1) {
              deleteChatModel(chatId);
              await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 已恢复默认模型。`, ctx.contextToken);
            } else if (num >= 1 && num <= models.length) {
              setChatModel(chatId, models[num - 1].id);
              await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 模型已切换为: ${models[num - 1].label || models[num - 1].id}`, ctx.contextToken);
            } else {
              await sendText(WECHAT_BOT_TOKEN, ctx.userId, "无效选择。", ctx.contextToken);
            }
          },
        });
        break;
      }
      setChatModel(chatId, args);
      await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 模型已切换为: ${args}`, ctx.contextToken);
      break;
    }

    case "/effort": {
      const adapter = getAdapter(chatId);
      const levels = typeof adapter.availableEfforts === "function" ? adapter.availableEfforts() : [];
      if (!args) {
        if (!levels.length) {
          await sendText(WECHAT_BOT_TOKEN, ctx.userId, "当前后端不支持思考深度切换。", ctx.contextToken);
          break;
        }
        const lines = levels.map((e, i) => `${i + 1}. ${e.label}`);
        lines.push(`${levels.length + 1}. 恢复默认`);
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, `选择思考深度:\n${lines.join("\n")}`, ctx.contextToken);
        pendingInteractions.set(chatId, {
          type: "effort_select",
          resolve: async (input) => {
            const num = parseInt(input.trim());
            if (num === levels.length + 1) {
              deleteChatEffort(chatId);
              await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 已恢复默认。`, ctx.contextToken);
            } else if (num >= 1 && num <= levels.length) {
              setChatEffort(chatId, levels[num - 1].id);
              await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 思考深度: ${levels[num - 1].label}`, ctx.contextToken);
            }
          },
        });
        break;
      }
      setChatEffort(chatId, args);
      await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 思考深度: ${args}`, ctx.contextToken);
      break;
    }

    case "/verbose": {
      if (args) {
        const level = parseInt(args);
        if (level >= 0 && level <= 2) {
          verboseSettings.set(chatId, level);
          await sendText(WECHAT_BOT_TOKEN, ctx.userId, `进度详细度: ${level}`, ctx.contextToken);
        } else {
          await sendText(WECHAT_BOT_TOKEN, ctx.userId, "范围: 0-2 (0=关/1=工具名/2=详细)", ctx.contextToken);
        }
      } else {
        const current = verboseSettings.get(chatId) ?? DEFAULT_VERBOSE;
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, `当前: ${current}\n用法: /verbose 0|1|2`, ctx.contextToken);
      }
      break;
    }

    case "/dir": {
      if (args) {
        dirManager.set(chatId, args);
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, `工作目录: ${dirManager.current(chatId)}`, ctx.contextToken);
      } else {
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, `当前: ${dirManager.current(chatId)}\n用法: /dir <path>`, ctx.contextToken);
      }
      break;
    }

    case "/backend": {
      if (args && ACTIVE_BACKENDS.includes(args.toLowerCase())) {
        const target = args.toLowerCase();
        setChatBackend(chatId, target);
        deleteSession(chatId); // 切后端要开新 session
        const adapter = adapters[target];
        await sendText(WECHAT_BOT_TOKEN, ctx.userId, `${adapter.icon} 已切换到 ${adapter.label}，下条消息开启新会话。`, ctx.contextToken);
      } else {
        const current = getBackendName(chatId);
        const lines = ACTIVE_BACKENDS.map(b => {
          const a = adapters[b];
          const mark = b === current ? " ✦" : "";
          return `${a.icon} ${b} — ${a.label}${mark}`;
        });
        await sendText(WECHAT_BOT_TOKEN, ctx.userId,
          `当前后端: ${current}\n可用:\n${lines.join("\n")}\n\n用法: /backend claude 或 /backend codex`,
          ctx.contextToken,
        );
      }
      break;
    }

    default:
      // 未知命令 → 当普通消息处理
      await submitAndWait(ctx, text);
  }
}

// ── 消息入口 ──

async function onMessage(msg) {
  const userId = msg.from_user_id;
  const contextToken = msg.context_token;
  const chatId = userIdToNumeric(userId);
  const ctx = { userId, contextToken, chatId };

  const text = extractText(msg);

  // 非文本消息：下载媒体文件并注入 prompt
  if (!text) {
    const items = msg.item_list || [];
    let mediaPrompt = "";

    for (const item of items) {
      if (item.type === ItemType.IMAGE) {
        try {
          console.log(`[media] 图片 item 结构: ${JSON.stringify(item).slice(0, 2000)}`);
          const result = await downloadImage(item);
          if (result) {
            const localPath = join(FILE_DIR, `${Date.now()}-${result.filename}`);
            writeFileSync(localPath, result.data);
            mediaPrompt += `请看这张图片\n\n[图片文件: ${localPath}]\n`;
            console.log(`[media] 图片已下载: ${localPath} (${result.data.length} bytes)`);
          } else {
            mediaPrompt += "[收到图片但下载失败]\n";
          }
        } catch (err) {
          console.error(`[media] 图片下载失败: ${err.message}`);
          mediaPrompt += "[收到图片但下载失败]\n";
        }
      } else if (item.type === ItemType.FILE) {
        try {
          console.log(`[media] 文件 item 结构: ${JSON.stringify(item).slice(0, 500)}`);
          const result = await downloadMediaFile(item);
          if (result) {
            const localPath = join(FILE_DIR, `${Date.now()}-${result.filename}`);
            writeFileSync(localPath, result.data);
            mediaPrompt += `请处理这个文件: ${result.filename}\n\n[文件: ${localPath}]\n`;
            console.log(`[media] 文件已下载: ${localPath} (${result.data.length} bytes)`);
          } else {
            mediaPrompt += "[收到文件但下载失败]\n";
          }
        } catch (err) {
          console.error(`[media] 文件下载失败: ${err.message}`);
          mediaPrompt += "[收到文件但下载失败]\n";
        }
      } else if (item.type === ItemType.VOICE) {
        await sendText(WECHAT_BOT_TOKEN, userId, "🎤 语音暂不支持，请发文字或图片。", contextToken).catch(() => {});
        return;
      } else if (item.type === ItemType.VIDEO) {
        await sendText(WECHAT_BOT_TOKEN, userId, "🎬 视频暂不支持，请发文字或图片。", contextToken).catch(() => {});
        return;
      }
    }

    if (!mediaPrompt) return;
    // 有图片/文件内容就提交给 AI
    await submitAndWait(ctx, mediaPrompt.trim());
    return;
  }

  // 限流
  if (!rateLimiter.isAllowed(chatId)) {
    const sec = Math.ceil(rateLimiter.retryAfterMs(chatId) / 1000);
    await sendText(WECHAT_BOT_TOKEN, userId, `🐌 消息太快了，${sec}s 后再试`, contextToken).catch(() => {});
    return;
  }

  // 检查待处理交互
  const pending = pendingInteractions.get(chatId);
  if (pending) {
    pendingInteractions.delete(chatId);

    if (pending.type === "permission") {
      // 工具审批：resolve Promise
      pending.resolve(text);
      return;
    }

    if (pending.type === "quick_reply" || pending.type === "question") {
      // 数字选择 → 映射到选项文本并提交
      const num = parseInt(text.trim());
      if (num >= 1 && num <= pending.options.length) {
        await submitAndWait(ctx, pending.options[num - 1]);
      } else {
        // 不是有效数字 → 当普通消息
        await submitAndWait(ctx, text);
      }
      return;
    }

    if (pending.type === "model_select" || pending.type === "effort_select") {
      if (pending.resolve) await pending.resolve(text);
      return;
    }
  }

  // 命令
  if (text.startsWith("/")) {
    await handleCommand(ctx, text);
    return;
  }

  // 普通消息 → AI
  await submitAndWait(ctx, text);
}

// ── 启动 ──

if (!WECHAT_BOT_TOKEN) {
  console.error("FATAL: WECHAT_BOT_TOKEN not set. Run login flow first.");
  process.exit(1);
}

const FILE_DIR = join(import.meta.dir, "files");
mkdirSync(FILE_DIR, { recursive: true });

console.log("WeChat-AI-Bridge 启动中...");
console.log(`  后端: ${getFallbackBackend()}`);
console.log(`  工作目录: ${CC_CWD}`);
console.log(`  详细度: ${DEFAULT_VERBOSE}`);
console.log(`  限流: ${RATE_LIMIT_MAX_REQUESTS}/${Math.round(RATE_LIMIT_WINDOW_MS / 1000)}s`);
console.log(`  Idle: timeout=${IDLE_TIMEOUT_MS > 0 ? Math.round(IDLE_TIMEOUT_MS / 60000) + "min" : "off"}, reset=${RESET_ON_IDLE_MS > 0 ? Math.round(RESET_ON_IDLE_MS / 60000) + "min" : "off"}`);

const monitor = createMonitor(WECHAT_BOT_TOKEN, onMessage);
monitor.start();

// Graceful shutdown
async function shutdown(signal) {
  console.log(`[bridge] ${signal}, shutting down...`);
  monitor.stop();
  for (const [, ac] of chatAbortControllers) ac.abort();
  console.log("[bridge] done");
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
