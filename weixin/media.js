// iLink CDN 媒体处理
// 上传/下载 + AES-128-ECB 加解密

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { iLinkPost, cdnUpload } from "./api.js";

const CDN_BASE = "https://novac2c.cdn.weixin.qq.com/c2c";

/**
 * AES-128-ECB 加密
 * @param {Buffer} data - 明文
 * @param {Buffer} key - 16 字节 AES key
 * @returns {Buffer} 密文
 */
export function aesEncrypt(data, key) {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

/**
 * AES-128-ECB 解密
 * @param {Buffer} data - 密文
 * @param {Buffer} key - 16 字节 AES key
 * @returns {Buffer} 明文
 */
export function aesDecrypt(data, key) {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

/**
 * 从 CDN 下载并解密媒体文件
 * @param {string} cdnUrl - CDN URL
 * @param {string} aesKeyBase64 - base64 编码的 AES key
 * @returns {Promise<Buffer>} 解密后的文件数据
 */
export async function downloadMedia(cdnUrl, aesKeyInput) {
  const resp = await fetch(cdnUrl);
  if (!resp.ok) {
    throw new Error(`CDN download failed: ${resp.status}`);
  }
  const encrypted = Buffer.from(await resp.arrayBuffer());
  const key = normalizeAesKey(aesKeyInput);
  return aesDecrypt(encrypted, key);
}

/**
 * 将各种格式的 AES key 统一转为 16 字节 Buffer
 * iLink 的 key 有三种格式：
 *   1. 32 字符 hex string: "c80506fb..."  → Buffer.from(hex, "hex") → 16 bytes
 *   2. base64(hex string): "YzgwNTA2..." → base64 decode → hex string → 同上
 *   3. 直接 base64(16 bytes): 解码后刚好 16 字节
 */
function normalizeAesKey(input) {
  if (Buffer.isBuffer(input) && input.length === 16) return input;

  // 先尝试 base64 解码
  let decoded = Buffer.from(input, "base64");

  // 如果解码后是 16 字节，直接用
  if (decoded.length === 16) return decoded;

  // 如果解码后是 32 字节且全是 hex 字符，说明是 base64(hex)
  const decodedStr = decoded.toString("utf-8");
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decodedStr)) {
    return Buffer.from(decodedStr, "hex"); // 32 hex chars → 16 bytes
  }

  // 也许 input 本身就是 hex string
  if (typeof input === "string" && /^[0-9a-f]{32}$/i.test(input)) {
    return Buffer.from(input, "hex");
  }

  // 兜底：直接用解码结果（可能报错，让调用者知道）
  return decoded;
}

/**
 * 加密并上传媒体文件到 CDN
 * @param {string} token - bot_token
 * @param {Buffer} data - 原始文件数据
 * @param {string} filename - 文件名
 * @param {number} fileType - 1=图片 2=语音 3=文件 4=视频
 * @returns {Promise<object>} CDN 引用参数（用于 sendmessage）
 */
export async function uploadMedia(token, data, filename, fileType = 1) {
  // 生成随机 AES key
  const aesKey = randomBytes(16);
  const aesKeyBase64 = aesKey.toString("base64");

  // 加密
  const encrypted = aesEncrypt(data, aesKey);

  // 获取预签名上传 URL
  const uploadResp = await iLinkPost("/ilink/bot/getuploadurl", {
    file_type: fileType,
    file_name: filename,
    file_size: encrypted.length,
  }, token);

  if (!uploadResp.upload_url) {
    throw new Error(`getuploadurl failed: ${JSON.stringify(uploadResp).slice(0, 200)}`);
  }

  // 上传到 CDN
  await cdnUpload(uploadResp.upload_url, encrypted);

  // 返回 CDN 引用参数
  return {
    aes_key: aesKeyBase64,
    file_id: uploadResp.file_id || "",
    file_size: data.length,
    file_name: filename,
    // 以下字段可能因 API 版本不同而变化
    ...(uploadResp.download_url ? { download_url: uploadResp.download_url } : {}),
  };
}

/**
 * 从收到的消息中提取图片并下载解密
 * @param {object} imageItem - item_list 中 type=2 的 item
 * @returns {Promise<{ data: Buffer, filename: string } | null>}
 */
export async function downloadImage(imageItem) {
  try {
    const img = imageItem.image_item || imageItem;
    const media = img.media || {};

    // URL: media.full_url 优先，兜底拼接
    const cdnUrl = media.full_url || img.cdn_url || img.full_url || img.url;
    // AES key: media.aes_key (base64) 优先，兜底用 img.aeskey (hex → base64)
    let aesKey = media.aes_key || img.aes_key;
    if (!aesKey && img.aeskey) {
      // aeskey 是 hex 格式，转为 base64
      aesKey = Buffer.from(img.aeskey, "hex").toString("base64");
    }

    if (!cdnUrl) {
      console.error("[media] downloadImage: no CDN URL found");
      return null;
    }

    if (aesKey) {
      const data = await downloadMedia(cdnUrl, aesKey);
      return { data, filename: img.file_name || "image.jpg" };
    } else {
      const resp = await fetch(cdnUrl);
      if (!resp.ok) return null;
      const data = Buffer.from(await resp.arrayBuffer());
      return { data, filename: img.file_name || "image.jpg" };
    }
  } catch (err) {
    console.error(`[media] downloadImage error: ${err.message}`);
    return null;
  }
}

/**
 * 从收到的消息中提取文件并下载解密
 */
export async function downloadFile(fileItem) {
  try {
    const file = fileItem.file_item || fileItem;
    const media = file.media || {};

    const cdnUrl = media.full_url || file.cdn_url || file.full_url || file.url;
    let aesKey = media.aes_key || file.aes_key;
    if (!aesKey && file.aeskey) {
      aesKey = Buffer.from(file.aeskey, "hex").toString("base64");
    }

    if (!cdnUrl) {
      console.error("[media] downloadFile: no CDN URL found");
      return null;
    }

    if (aesKey) {
      const data = await downloadMedia(cdnUrl, aesKey);
      return { data, filename: file.file_name || media.file_name || "file" };
    } else {
      const resp = await fetch(cdnUrl);
      if (!resp.ok) return null;
      const data = Buffer.from(await resp.arrayBuffer());
      return { data, filename: file.file_name || media.file_name || "file" };
    }
  } catch (err) {
    console.error(`[media] downloadFile error: ${err.message}`);
    return null;
  }
}
