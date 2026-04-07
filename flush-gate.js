// FlushGate: 消息合并模块（借鉴 Claude Code bridge/flushGate.ts）
// 空闲时攒 batchDelayMs 窗口合并连续消息；处理中来的消息入缓冲区，处理完自动 flush

export function createFlushGate(options = {}) {
  const {
    batchDelayMs = 800,
    maxBufferSize = 5,
    onBuffered = null, // async (chatId) => {} — 消息入缓冲时的回调（用于发"已收到"提示）
  } = options;

  // 每个 chatId 的状态
  const gates = new Map(); // chatId -> { processing, buffer[], batchTimer }

  function getGate(chatId) {
    if (!gates.has(chatId)) {
      gates.set(chatId, { processing: false, buffer: [], batchTimer: null, processFn: null });
    }
    return gates.get(chatId);
  }

  /**
   * 入队一条消息
   * @param {number} chatId
   * @param {{ ctx, prompt: string }} message
   * @param {function} processFn - async (ctx, combinedPrompt) => void
   */
  async function enqueue(chatId, message, processFn) {
    const gate = getGate(chatId);
    gate.processFn = processFn; // 始终用最新的 processFn

    if (gate.processing) {
      // 正在处理中 → 入缓冲区
      if (gate.buffer.length < maxBufferSize) {
        gate.buffer.push(message);
        if (onBuffered) {
          await onBuffered(chatId, message.ctx).catch(() => {});
        }
      } else {
        console.warn(`[FlushGate] chatId=${chatId} buffer full (${maxBufferSize}), dropping message`);
      }
      return;
    }

    // 空闲态 → 攒一个短窗口
    gate.buffer.push(message);

    if (gate.batchTimer) return; // 已经在等窗口了

    gate.batchTimer = setTimeout(async () => {
      gate.batchTimer = null;
      await flush(chatId);
    }, batchDelayMs);
  }

  async function flush(chatId) {
    const gate = getGate(chatId);
    if (gate.processing || gate.buffer.length === 0) return;

    // 取出缓冲区所有消息
    const batch = gate.buffer.splice(0);
    gate.processing = true;

    try {
      // 合并 prompt
      const combinedPrompt = batch.length === 1
        ? batch[0].prompt
        : batch.map((m, i) => `[消息 ${i + 1}]\n${m.prompt}`).join("\n\n");
      const latestCtx = batch[batch.length - 1].ctx; // 用最后一条消息的 ctx 回复

      await gate.processFn(latestCtx, combinedPrompt);
    } finally {
      gate.processing = false;

      // 处理完成后，如果缓冲区还有新消息，继续 flush
      if (gate.buffer.length > 0) {
        await flush(chatId);
      }
    }
  }

  function isProcessing(chatId) {
    return gates.get(chatId)?.processing || false;
  }

  function getPendingCount(chatId) {
    return gates.get(chatId)?.buffer.length || 0;
  }

  return { enqueue, isProcessing, getPendingCount };
}
