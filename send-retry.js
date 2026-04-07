// 发送重试 + 错误分类 + HTML 降级
// 参考: Claude-to-IM delivery-layer.ts

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const JITTER_MAX_MS = 500;

/**
 * 错误分类
 * @param {Error} error
 * @returns {'rate_limit'|'server_error'|'client_error'|'parse_error'|'network'}
 */
export function classifyError(error) {
  // GrammyError: { error_code, description, parameters }
  const code = error?.error_code || error?.status || 0;
  const desc = error?.description || error?.message || String(error);

  if (code === 429 || /too many requests|retry.after/i.test(desc)) return "rate_limit";
  if (code >= 500) return "server_error";
  if (/can't parse entities|parse entities|find end of the entity/i.test(desc)) return "parse_error";
  if (code >= 400) return "client_error";
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|network|socket/i.test(desc)) return "network";
  return "network"; // 默认当网络错误，可重试
}

/**
 * 提取 retry_after 秒数
 */
function extractRetryAfter(error) {
  // Grammy: error.parameters?.retry_after
  if (error?.parameters?.retry_after) return error.parameters.retry_after;
  const match = String(error?.message || error?.description || "").match(/retry.after[:\s]+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function shouldRetry(category) {
  return category === "rate_limit" || category === "server_error" || category === "network";
}

/**
 * 带重试的函数执行器
 * @param {Function} fn - 要执行的异步函数
 * @param {Object} opts
 * @param {number} opts.maxRetries - 最大重试次数
 * @param {Function} opts.onParseFallback - 解析错误时的降级函数
 * @returns {Promise<any>}
 */
export async function withRetry(fn, opts = {}) {
  const { maxRetries = MAX_RETRIES, onParseFallback } = opts;
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const category = classifyError(error);

      // 解析错误：立即降级，不重试
      if (category === "parse_error" && onParseFallback) {
        try {
          return await onParseFallback();
        } catch (fallbackError) {
          throw fallbackError;
        }
      }

      // 不可重试的错误直接抛出
      if (!shouldRetry(category)) throw error;

      // 最后一次尝试也失败，不再等待
      if (attempt >= maxRetries) break;

      // 指数退避 + 抖动；429 尊重 retry_after
      const retryAfter = extractRetryAfter(error);
      const delay = retryAfter > 0
        ? retryAfter * 1000 + 200
        : BASE_DELAY_MS * Math.pow(2, attempt) + Math.random() * JITTER_MAX_MS;

      console.warn(`[send-retry] attempt ${attempt + 1}/${maxRetries + 1} failed (${category}), retrying in ${Math.round(delay)}ms`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}
