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
export async function downloadMedia(cdnUrl, aesKeyBase64) {
  const resp = await fetch(cdnUrl);
  if (!resp.ok) {
    throw new Error(`CDN download failed: ${resp.status}`);
  }
  const encrypted = Buffer.from(await resp.arrayBuffer());
  const key = Buffer.from(aesKeyBase64, "base64");
  return aesDecrypt(encrypted, key);
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
    const cdnUrl = img.cdn_url || img.full_url || img.url;
    const aesKey = img.aes_key;

    if (!cdnUrl) return null;

    if (aesKey) {
      const data = await downloadMedia(cdnUrl, aesKey);
      return { data, filename: img.file_name || "image.jpg" };
    } else {
      // 无加密，直接下载
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
    const cdnUrl = file.cdn_url || file.full_url || file.url;
    const aesKey = file.aes_key;

    if (!cdnUrl) return null;

    if (aesKey) {
      const data = await downloadMedia(cdnUrl, aesKey);
      return { data, filename: file.file_name || "file" };
    } else {
      const resp = await fetch(cdnUrl);
      if (!resp.ok) return null;
      const data = Buffer.from(await resp.arrayBuffer());
      return { data, filename: file.file_name || "file" };
    }
  } catch (err) {
    console.error(`[media] downloadFile error: ${err.message}`);
    return null;
  }
}
