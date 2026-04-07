// iLink HTTP API 封装
// 所有 API 调用的底层 HTTP 客户端

import { randomBytes } from "crypto";

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CHANNEL_VERSION = "1.0.2";

/**
 * 生成 iLink 请求 headers
 * @param {string} token - bot_token（登录后获得）
 */
function makeHeaders(token) {
  // X-WECHAT-UIN: 每次随机 uint32 的 base64，防重放
  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");
  const headers = {
    "Content-Type": "application/json",
    "AuthorizationType": "ilink_bot_token",
    "X-WECHAT-UIN": uin,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * 通用 GET 请求
 */
export async function iLinkGet(path, token, baseUrl = DEFAULT_BASE_URL) {
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, { headers: makeHeaders(token) });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`iLink GET ${path} ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

/**
 * 通用 POST 请求
 */
export async function iLinkPost(path, body, token, baseUrl = DEFAULT_BASE_URL) {
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: makeHeaders(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const err = new Error(`iLink POST ${path} ${resp.status}: ${text.slice(0, 300)}`);
    err.status = resp.status;
    throw err;
  }
  return resp.json();
}

/**
 * 上传文件到 CDN（PUT 预签名 URL）
 */
export async function cdnUpload(uploadUrl, encryptedBuffer) {
  const resp = await fetch(uploadUrl, {
    method: "PUT",
    body: encryptedBuffer,
  });
  if (!resp.ok) {
    throw new Error(`CDN upload failed: ${resp.status}`);
  }
}

export { DEFAULT_BASE_URL, CHANNEL_VERSION };
