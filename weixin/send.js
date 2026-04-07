// iLink 发送消息 + 文本分段 + typing 状态

import { randomUUID } from "crypto";
import { iLinkPost } from "./api.js";
import { MessageType, MessageState, ItemType } from "./types.js";
import { withRetry } from "../send-retry.js";

const MAX_TEXT_LENGTH = 2000; // 保守切分长度

/**
 * 发送文本消息
 * @param {string} token
 * @param {string} toUserId - 目标用户 ID (xxx@im.wechat)
 * @param {string} text - 要发送的文本
 * @param {string} contextToken - 从收到的消息中原样带回
 */
export async function sendText(token, toUserId, text, contextToken) {
  return withRetry(async () => {
    const resp = await iLinkPost("/ilink/bot/sendmessage", {
      msg: {
        to_user_id: toUserId,
        client_id: `wab-${randomUUID().slice(0, 8)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{ type: ItemType.TEXT, text_item: { text } }],
      },
    }, token);
    return resp;
  });
}

/**
 * 发送长文本（自动分段）
 * @returns {Promise<void>}
 */
export async function sendLongText(token, toUserId, text, contextToken) {
  if (text.length <= MAX_TEXT_LENGTH) {
    return sendText(token, toUserId, text, contextToken);
  }

  const chunks = [];
  let remaining = text;

  while (remaining.length > MAX_TEXT_LENGTH) {
    let cut = remaining.lastIndexOf("\n\n", MAX_TEXT_LENGTH);
    if (cut < MAX_TEXT_LENGTH * 0.3) {
      cut = remaining.lastIndexOf("\n", MAX_TEXT_LENGTH);
    }
    if (cut < MAX_TEXT_LENGTH * 0.3) {
      cut = MAX_TEXT_LENGTH;
    }
    let chunk = remaining.slice(0, cut);

    // 代码块修补：奇数个 ``` → 补一个闭合
    const fenceCount = (chunk.match(/^```/gm) || []).length;
    if (fenceCount % 2 !== 0) chunk += "\n```";

    chunks.push(chunk);
    remaining = remaining.slice(cut).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);

  for (const chunk of chunks) {
    await sendText(token, toUserId, chunk, contextToken);
  }
}

/**
 * 发送"正在输入"状态
 */
export async function sendTyping(token, toUserId, contextToken, typingTicket) {
  try {
    await iLinkPost("/ilink/bot/sendtyping", {
      to_user_id: toUserId,
      context_token: contextToken,
      typing_ticket: typingTicket || "",
      typing_status: 1, // 1=开始输入
    }, token);
  } catch {
    // typing 失败不影响主流程
  }
}

/**
 * 取消"正在输入"状态
 */
export async function cancelTyping(token, toUserId, contextToken, typingTicket) {
  try {
    await iLinkPost("/ilink/bot/sendtyping", {
      to_user_id: toUserId,
      context_token: contextToken,
      typing_ticket: typingTicket || "",
      typing_status: 0, // 0=停止输入
    }, token);
  } catch {}
}

/**
 * 发送图片消息（需要先上传到 CDN）
 * @param {string} token
 * @param {string} toUserId
 * @param {string} contextToken
 * @param {object} imageRef - CDN 引用参数（从上传流程获得）
 */
export async function sendImage(token, toUserId, contextToken, imageRef) {
  return withRetry(async () => {
    const resp = await iLinkPost("/ilink/bot/sendmessage", {
      msg: {
        to_user_id: toUserId,
        client_id: `wab-${randomUUID().slice(0, 8)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: ItemType.IMAGE,
          image_item: {
            aeskey: imageRef.aes_key,
            media: {
              encrypt_query_param: imageRef.encrypt_query_param,
              aes_key: Buffer.from(imageRef.aes_key, "hex").toString("base64"),
              file_key: imageRef.file_key,
            },
          },
        }],
      },
    }, token);
    return resp;
  });
}

/**
 * 发送文件消息
 */
export async function sendFile(token, toUserId, contextToken, fileRef) {
  return withRetry(async () => {
    const resp = await iLinkPost("/ilink/bot/sendmessage", {
      msg: {
        to_user_id: toUserId,
        client_id: `wab-${randomUUID().slice(0, 8)}`,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        context_token: contextToken,
        item_list: [{
          type: ItemType.FILE,
          file_item: {
            aeskey: fileRef.aes_key,
            file_name: fileRef.file_name,
            file_size: fileRef.file_size,
            media: {
              encrypt_query_param: fileRef.encrypt_query_param,
              aes_key: Buffer.from(fileRef.aes_key, "hex").toString("base64"),
              file_key: fileRef.file_key,
            },
          },
        }],
      },
    }, token);
    return resp;
  });
}

export { MAX_TEXT_LENGTH };
