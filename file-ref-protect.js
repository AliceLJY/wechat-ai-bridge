// 文件引用保护
// 防止 Telegram 将 README.md / main.go / setup.py 等文件名自动识别为域名链接
// 参考: Claude-to-IM markdown/telegram.ts FILE_EXTENSIONS_WITH_TLD

const FILE_EXTENSIONS_WITH_TLD = new Set([
  "md",  // Markdown → Moldova (.md)
  "go",  // Go → (no TLD but Telegram still auto-links)
  "py",  // Python → Paraguay (.py)
  "pl",  // Perl → Poland (.pl)
  "sh",  // Shell → Saint Helena (.sh)
  "am",  // Automake → Armenia (.am)
  "at",  // Assembly → Austria (.at)
  "be",  // Backend → Belgium (.be)
  "cc",  // C++ → Cocos Islands (.cc)
  "rs",  // Rust → Serbia (.rs)
  "is",  // Iceland → also common filenames
  "io",  // IO → British Indian Ocean Territory
  "in",  // India → common in config files
  "me",  // Montenegro → README.me etc
  "to",  // Tonga → config.to etc
  "do",  // Dominican Republic → Makefile.do etc
]);

// 匹配 word.ext 格式的文件名（含路径前缀）
// 不匹配已在 URL 中的（://前缀）
const EXT_GROUP = [...FILE_EXTENSIONS_WITH_TLD].join("|");
const FILE_REF_RE = new RegExp(
  `(?<![:/\\w])([a-zA-Z0-9_][a-zA-Z0-9_.\\-/]*\\.(?:${EXT_GROUP}))(?![a-zA-Z0-9_/])`,
  "gi"
);

/**
 * 在纯文本中将 TLD 类文件名用反引号包裹
 * 跳过已在代码块或行内代码中的内容
 * @param {string} text
 * @returns {string}
 */
export function protectFileReferences(text) {
  if (!text) return text;

  // 按代码块和行内代码切分，只处理纯文本段
  const segments = [];
  let cursor = 0;
  // 匹配三反引号代码块 和 单反引号行内代码
  const codePattern = /```[\s\S]*?```|`[^`\n]+`/g;
  let match;

  while ((match = codePattern.exec(text)) !== null) {
    // 代码块之前的纯文本
    if (match.index > cursor) {
      segments.push({ type: "text", content: text.slice(cursor, match.index) });
    }
    segments.push({ type: "code", content: match[0] });
    cursor = match.index + match[0].length;
  }
  // 剩余纯文本
  if (cursor < text.length) {
    segments.push({ type: "text", content: text.slice(cursor) });
  }

  // 只在纯文本段做替换
  return segments.map(seg => {
    if (seg.type === "code") return seg.content;
    return seg.content.replace(FILE_REF_RE, (fullMatch) => {
      return `\`${fullMatch}\``;
    });
  }).join("");
}
