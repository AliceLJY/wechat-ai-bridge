// iLink 协议类型常量

// 消息类型
export const MessageType = {
  USER: 1,   // 用户发出
  BOT: 2,    // Bot 发出
};

// 消息状态
export const MessageState = {
  SENDING: 1,
  FINISH: 2,
};

// 消息内容类型 (item_list[].type)
export const ItemType = {
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
};

// 二维码扫码状态
export const QRStatus = {
  WAIT: "wait",
  SCANNED: "scanned",
  CONFIRMED: "confirmed",
  EXPIRED: "expired",
};
