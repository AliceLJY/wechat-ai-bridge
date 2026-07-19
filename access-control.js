export const ALLOWED_USER_IDS_ENV = "WECHAT_ALLOWED_USER_IDS";

export function normalizeAllowedUserIds(value, options = {}) {
  const source = options.source || "allowed user IDs";
  let parsed = value;

  if (typeof parsed === "string") {
    if (!parsed.trim()) {
      throw new Error(`${source} must be a non-empty JSON array of WeChat from_user_id strings.`);
    }
    try {
      parsed = JSON.parse(parsed);
    } catch {
      throw new Error(`${source} must be valid JSON containing an array of WeChat from_user_id strings.`);
    }
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${source} must be a non-empty array of WeChat from_user_id strings.`);
  }

  const normalized = [];
  const seen = new Set();
  for (let i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== "string" || !parsed[i].trim()) {
      throw new Error(`${source}[${i}] must be a non-empty WeChat from_user_id string.`);
    }
    const userId = parsed[i].trim();
    if (!seen.has(userId)) {
      seen.add(userId);
      normalized.push(userId);
    }
  }
  return normalized;
}

export function createAllowedUserSet(value, options = {}) {
  return new Set(normalizeAllowedUserIds(value, options));
}

export function isAllowedUserId(userId, allowedUserIds) {
  return typeof userId === "string"
    && userId.length > 0
    && allowedUserIds instanceof Set
    && allowedUserIds.has(userId);
}
