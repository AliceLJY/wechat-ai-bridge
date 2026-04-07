export function createExecutor(config = {}) {
  const { resolveBackend } = config;
  if (typeof resolveBackend !== "function") {
    throw new Error("direct executor requires resolveBackend(chatId, backendName)");
  }

  return {
    name: "direct",
    label: "Direct",

    async *streamTask(task, abortSignal, overrides = {}) {
      const resolved = resolveBackend(task.chatId, task.backendName);
      if (!resolved?.adapter) {
        throw new Error(`No backend adapter available for chat ${task.chatId}`);
      }

      yield* resolved.adapter.streamQuery(
        task.prompt,
        task.sessionId || null,
        abortSignal,
        overrides,
      );
    },
  };
}
