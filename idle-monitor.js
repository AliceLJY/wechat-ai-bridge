// 闲置监控器（借鉴 cc-connect idle session 管理）
// ① 卡死检测：处理中超时自动 abort
// ② 闲置轮转：用户长时间不说话，下次自动开新 session

export function createIdleMonitor(options = {}) {
  const {
    idleTimeoutMs = 30 * 60 * 1000,  // 30 分钟无心跳 → 卡死
    resetOnIdleMs = 0,                // 0 = 禁用闲置轮转
    onTimeout = null,                 // async (chatId) => {}
    onIdleReset = null,               // async (chatId) => {}
  } = options;

  // chatId -> { lastActive, processing, timer, lastHeartbeat }
  const state = new Map();

  function getState(chatId) {
    if (!state.has(chatId)) {
      state.set(chatId, {
        lastActive: Date.now(),
        processing: false,
        timer: null,
        lastHeartbeat: null,
      });
    }
    return state.get(chatId);
  }

  // 记录用户活跃（每条消息到达时调用）
  function touch(chatId) {
    const s = getState(chatId);
    s.lastActive = Date.now();
  }

  // 检查是否需要自动开新 session
  function shouldAutoReset(chatId) {
    if (resetOnIdleMs <= 0) return false;
    const s = state.get(chatId);
    if (!s) return false;
    if (s.processing) return false;
    return (Date.now() - s.lastActive) > resetOnIdleMs;
  }

  // 开始处理（进入 adapter 调用前）
  function startProcessing(chatId) {
    const s = getState(chatId);
    s.processing = true;
    s.lastHeartbeat = Date.now();

    // 启动卡死检测定时器
    if (s.timer) clearTimeout(s.timer);
    if (idleTimeoutMs > 0) {
      s.timer = setTimeout(async () => {
        if (s.processing) {
          console.warn(`[idle-monitor] chatId=${chatId} 处理超时 (${Math.round(idleTimeoutMs / 60000)} 分钟)`);
          if (onTimeout) {
            try { await onTimeout(chatId); } catch (e) {
              console.error(`[idle-monitor] onTimeout error: ${e.message}`);
            }
          }
        }
      }, idleTimeoutMs);
    }
  }

  // adapter 事件到达时调用（重置卡死计时）
  function heartbeat(chatId) {
    const s = state.get(chatId);
    if (!s || !s.processing) return;
    s.lastHeartbeat = Date.now();

    // 重置定时器
    if (s.timer) clearTimeout(s.timer);
    if (idleTimeoutMs > 0) {
      s.timer = setTimeout(async () => {
        if (s.processing) {
          console.warn(`[idle-monitor] chatId=${chatId} 处理超时 (心跳停止)`);
          if (onTimeout) {
            try { await onTimeout(chatId); } catch (e) {
              console.error(`[idle-monitor] onTimeout error: ${e.message}`);
            }
          }
        }
      }, idleTimeoutMs);
    }
  }

  // 结束处理
  function stopProcessing(chatId) {
    const s = state.get(chatId);
    if (!s) return;
    s.processing = false;
    s.lastActive = Date.now();
    if (s.timer) {
      clearTimeout(s.timer);
      s.timer = null;
    }
  }

  function isProcessing(chatId) {
    return state.get(chatId)?.processing || false;
  }

  function getIdleMs(chatId) {
    const s = state.get(chatId);
    if (!s) return 0;
    return Date.now() - s.lastActive;
  }

  function statusInfo() {
    return {
      idleTimeoutMs,
      resetOnIdleMs,
      activeSessions: state.size,
    };
  }

  function destroy() {
    for (const [, s] of state) {
      if (s.timer) clearTimeout(s.timer);
    }
    state.clear();
  }

  return {
    touch,
    shouldAutoReset,
    startProcessing,
    heartbeat,
    stopProcessing,
    isProcessing,
    getIdleMs,
    statusInfo,
    destroy,
  };
}
