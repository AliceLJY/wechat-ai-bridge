// 滑动窗口限流器（借鉴 cc-connect ratelimit.go）
// 入站：防用户消息洪水；出站：防 Telegram API 429

export function createRateLimiter(options = {}) {
  const {
    maxRequests = 10,
    windowMs = 60000,
  } = options;

  // chatId -> timestamp[]
  const windows = new Map();

  function cleanup(chatId) {
    const timestamps = windows.get(chatId);
    if (!timestamps) return;
    const cutoff = Date.now() - windowMs;
    // 移除过期条目
    while (timestamps.length > 0 && timestamps[0] < cutoff) {
      timestamps.shift();
    }
    if (timestamps.length === 0) windows.delete(chatId);
  }

  function isAllowed(chatId) {
    cleanup(chatId);
    const timestamps = windows.get(chatId);
    if (!timestamps || timestamps.length < maxRequests) {
      if (!timestamps) windows.set(chatId, [Date.now()]);
      else timestamps.push(Date.now());
      return true;
    }
    return false;
  }

  function remaining(chatId) {
    cleanup(chatId);
    const timestamps = windows.get(chatId);
    return Math.max(0, maxRequests - (timestamps?.length || 0));
  }

  function retryAfterMs(chatId) {
    cleanup(chatId);
    const timestamps = windows.get(chatId);
    if (!timestamps || timestamps.length < maxRequests) return 0;
    // 最早的条目过期时间
    return Math.max(0, timestamps[0] + windowMs - Date.now());
  }

  function reset(chatId) {
    windows.delete(chatId);
  }

  function stats(chatId) {
    cleanup(chatId);
    const timestamps = windows.get(chatId);
    return {
      used: timestamps?.length || 0,
      max: maxRequests,
      windowMs,
    };
  }

  return { isAllowed, remaining, retryAfterMs, reset, stats };
}
