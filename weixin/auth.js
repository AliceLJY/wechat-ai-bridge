// iLink 扫码登录 + token 持久化

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { iLinkGet } from "./api.js";
import { QRStatus } from "./types.js";

const STATE_DIR = join(process.env.HOME || ".", ".wechat-ai-bridge");
const TOKEN_PATH = join(STATE_DIR, "token.json");

/**
 * 加载已保存的 token
 * @returns {{ botToken: string, botId: string, baseUrl: string } | null}
 */
export function loadToken() {
  try {
    if (!existsSync(TOKEN_PATH)) return null;
    const data = JSON.parse(readFileSync(TOKEN_PATH, "utf-8"));
    if (data.botToken) return data;
  } catch {}
  return null;
}

/**
 * 保存 token
 */
export function saveToken(botToken, botId, baseUrl) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(TOKEN_PATH, JSON.stringify({ botToken, botId, baseUrl, savedAt: new Date().toISOString() }, null, 2));
  console.log(`[auth] token saved to ${TOKEN_PATH}`);
}

/**
 * 扫码登录流程
 * @param {Function} renderQR - 渲染二维码的回调 (qrUrl) => void
 * @returns {{ botToken: string, botId: string, baseUrl: string }}
 */
export async function loginWithQR(renderQR) {
  const MAX_RETRIES = 3;
  const POLL_INTERVAL_MS = 2000;
  const QR_TIMEOUT_MS = 120000; // 2 分钟

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    console.log(`[auth] 获取登录二维码 (attempt ${attempt + 1}/${MAX_RETRIES})...`);
    const qrResp = await iLinkGet("/ilink/bot/get_bot_qrcode?bot_type=3");

    const qrUrl = qrResp.qrcode_img_content || qrResp.url;
    if (!qrResp.qrcode || !qrUrl) {
      throw new Error(`获取二维码失败: ${JSON.stringify(qrResp).slice(0, 200)}`);
    }

    const qrcode = qrResp.qrcode;

    // 渲染二维码
    renderQR(qrUrl);
    console.log("[auth] 请用微信扫码...");

    // 长轮询等待扫码
    const deadline = Date.now() + QR_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const statusResp = await iLinkGet(`/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`);
        const status = statusResp.status;

        if (status === QRStatus.CONFIRMED) {
          const botToken = statusResp.bot_token;
          const botId = statusResp.ilink_bot_id || "";
          const baseUrl = statusResp.baseurl || "";
          console.log("[auth] 登录成功！");
          saveToken(botToken, botId, baseUrl);
          return { botToken, botId, baseUrl };
        }

        if (status === QRStatus.SCANNED) {
          console.log("[auth] 已扫码，等待确认...");
        }

        if (status === QRStatus.EXPIRED) {
          console.log("[auth] 二维码过期，重新获取...");
          break;
        }
      } catch (err) {
        console.warn(`[auth] 轮询状态出错: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  throw new Error("登录失败：已达最大重试次数");
}

export { STATE_DIR, TOKEN_PATH };
