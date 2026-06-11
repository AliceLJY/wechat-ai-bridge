// iLink 消息长轮询监听器
// getupdates 长轮询收消息，类似 Telegram getUpdates

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { iLinkPost } from "./api.js";
import { MessageType } from "./types.js";
import { STATE_DIR } from "./auth.js";

const SYNC_BUF_PATH = join(STATE_DIR, "sync-buf.json");
const POLL_TIMEOUT_MS = 38000; // 服务器 hold 35s，客户端 38s 超时

/** ISO 时间戳，给日志用 */
function ts() {
  return new Date().toISOString();
}

/** 轮询错误分类：benign = 长轮询周期常见的连接关闭/超时；real = 需要关注的真异常 */
function classifyPollError(err) {
  const msg = (err && err.message) || String(err);
  if (/socket connection.*closed|closed unexpectedly|ECONNRESET|other side closed|terminated|ETIMEDOUT|timed out/i.test(msg)) {
    return "benign";
  }
  return "real";
}

/**
 * 加载上次的同步游标
 */
function loadSyncBuf() {
  try {
    if (existsSync(SYNC_BUF_PATH)) {
      const data = JSON.parse(readFileSync(SYNC_BUF_PATH, "utf-8"));
      return data.buf || "";
    }
  } catch {}
  return "";
}

/**
 * 保存同步游标
 */
function saveSyncBuf(buf) {
  writeFileSync(SYNC_BUF_PATH, JSON.stringify({ buf, updatedAt: new Date().toISOString() }));
}

/**
 * 创建消息监听器
 * @param {string} token
 * @param {Function} onMessage - (msg) => void，收到用户消息时回调
 * @param {object} options
 */
export function createMonitor(token, onMessage, options = {}) {
  let running = false;
  let syncBuf = loadSyncBuf();
  let consecutiveFailures = 0;

  async function poll() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);
    try {
      const resp = await iLinkPost("/ilink/bot/getupdates", {
        get_updates_buf: syncBuf,
        base_info: { channel_version: "1.0.2" },
      }, token, undefined, { signal: controller.signal });

      // 成功一轮 → 重置连续失败计数
      consecutiveFailures = 0;

      // 更新游标
      if (resp.get_updates_buf) {
        syncBuf = resp.get_updates_buf;
        saveSyncBuf(syncBuf);
      }

      // 处理消息
      const msgs = resp.msgs || [];
      for (const msg of msgs) {
        // 只处理用户发来的消息
        if (msg.message_type === MessageType.USER) {
          try {
            await onMessage(msg);
          } catch (err) {
            console.error(`[monitor] ${ts()} onMessage error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // AbortError = 客户端 38s 主动超时，属长轮询正常周期结束，静默继续
      if (err.name === "AbortError") return;
      consecutiveFailures++;
      if (classifyPollError(err) === "benign") {
        // iLink 长轮询周期常见的连接关闭/超时：降噪，不逐条刷 error。
        // 注：socket-closed 是否一定是正常空轮询结束尚待 verbose 确认，
        // 故保留连续失败告警，避免真断连被静默吞掉。
        if (consecutiveFailures % 20 === 0) {
          console.warn(`[monitor] ${ts()} 已连续 ${consecutiveFailures} 次轮询未成功，疑似上游异常`);
        }
        await new Promise(r => setTimeout(r, 300)); // 立即重连，避免 3s 接收盲窗
      } else {
        // 真异常（HTTP 4xx/5xx、JSON 解析、DNS 等）逐条报，带时间戳
        console.error(`[monitor] ${ts()} poll error: ${err.message}`);
        await new Promise(r => setTimeout(r, 3000));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async function start() {
    running = true;
    console.log("[monitor] 开始监听消息...");
    while (running) {
      await poll();
    }
    console.log("[monitor] 已停止监听");
  }

  function stop() {
    running = false;
  }

  function isRunning() {
    return running;
  }

  return { start, stop, isRunning };
}
