// iLink 消息长轮询监听器
// getupdates 长轮询收消息，类似 Telegram getUpdates

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { iLinkPost } from "./api.js";
import { MessageType } from "./types.js";
import { STATE_DIR } from "./auth.js";

const SYNC_BUF_PATH = join(STATE_DIR, "sync-buf.json");
const POLL_TIMEOUT_MS = 38000; // 服务器 hold 35s，客户端 38s 超时

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

  async function poll() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), POLL_TIMEOUT_MS);

      const resp = await iLinkPost("/ilink/bot/getupdates", {
        get_updates_buf: syncBuf,
        base_info: { channel_version: "1.0.2" },
      }, token);

      clearTimeout(timeout);

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
            console.error(`[monitor] onMessage error: ${err.message}`);
          }
        }
      }
    } catch (err) {
      // AbortError 是正常超时，不用报错
      if (err.name === "AbortError") return;
      console.error(`[monitor] poll error: ${err.message}`);
      // 出错后短暂等待再重试
      await new Promise(r => setTimeout(r, 3000));
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
