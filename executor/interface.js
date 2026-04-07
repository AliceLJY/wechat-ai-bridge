import { createExecutor as createDirectExecutor } from "./direct.js";
import { createExecutor as createLocalAgentExecutor } from "./local-agent.js";

const EXECUTORS = {
  direct: createDirectExecutor,
  "local-agent": createLocalAgentExecutor,
};

export const AVAILABLE_EXECUTORS = Object.keys(EXECUTORS);

export function createExecutor(name, config = {}) {
  const executorName = String(name || "direct").toLowerCase();
  const factory = EXECUTORS[executorName];
  if (!factory) {
    throw new Error(`Unknown executor: ${executorName}. Available: ${AVAILABLE_EXECUTORS.join(", ")}`);
  }
  return factory(config);
}
