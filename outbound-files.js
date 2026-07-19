import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "fs";
import { basename, extname, isAbsolute, relative, resolve, sep } from "path";

export const MAX_OUTBOUND_FILE_BYTES = 20 * 1024 * 1024;
export const OUTBOUND_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
export const OUTBOUND_DOCUMENT_EXTENSIONS = new Set([
  ".pdf", ".docx", ".xlsx", ".csv", ".html", ".txt", ".md", ".json",
  ".js", ".ts", ".py", ".sh", ".yaml", ".yml", ".xml", ".zip", ".tar", ".gz",
]);
const SENSITIVE_DIRECTORY_NAMES = new Set([
  "auth",
  "config",
  "configs",
  "credential",
  "credentials",
  "keys",
  "log",
  "logs",
  "oauth",
  "secret",
  "secrets",
  "session",
  "sessions",
  "token",
  "tokens",
]);
const SENSITIVE_FILE_STEM_RE = /^(?:access[-_.]?token|api[-_.]?key|auth|authorization|client[-_.]?secret|config|cookie|cookies|credential|credentials|debug|history|id[-_.]?(?:rsa|dsa|ecdsa|ed25519)|key|keys|login|oauth2?|oauth[-_.]?creds?|password|passwd|private[-_.]?key|refresh[-_.]?token|secret|secrets|service[-_.]?account|session|sessions|settings|stderr|stdout|token|tokens|transcript)(?:[-_.].*)?$/i;
const SENSITIVE_FILE_PART_RE = /(?:^|[-_.])(?:access[-_.]?token|api[-_.]?key|auth|client[-_.]?secret|credential|credentials|id[-_.]?(?:rsa|dsa|ecdsa|ed25519)|key|keys|oauth2?|oauth[-_.]?creds?|password|passwd|private[-_.]?key|refresh[-_.]?token|secret|secrets|service[-_.]?account|session|sessions|token|tokens)(?=$|[-_.])/i;

function rejected(reason) {
  return { ok: false, reason };
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizePolicyName(value) {
  return String(value)
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function pathSegments(relativePath) {
  return relativePath.split(sep).filter(Boolean);
}

function hasSensitiveFileName(fileName) {
  const normalized = normalizePolicyName(fileName);
  if (/\.log(?:\.|$)/i.test(normalized)) return true;
  const extension = extname(normalized);
  const stem = extension ? normalized.slice(0, -extension.length) : normalized;
  return SENSITIVE_FILE_STEM_RE.test(stem) || SENSITIVE_FILE_PART_RE.test(stem);
}

function blockedRelativePathReason(relativePath) {
  const segments = pathSegments(relativePath);
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (/[\u0000-\u001f\u007f]/.test(segment)) return "invalid_path";
    if (segment.startsWith(".")) return "dotfile";
    if (
      index < segments.length - 1
      && SENSITIVE_DIRECTORY_NAMES.has(normalizePolicyName(segment))
    ) {
      return "sensitive_path";
    }
  }
  return segments.length && hasSensitiveFileName(segments.at(-1))
    ? "sensitive_path"
    : null;
}

function readExact(fd, size) {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const bytesRead = readSync(fd, data, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === size ? data : data.subarray(0, offset);
}

export function readOutboundFile(candidate, options = {}) {
  const cwd = options.cwd;
  const homeDir = options.homeDir || "";
  const inboundDir = options.inboundDir || "";
  const maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : MAX_OUTBOUND_FILE_BYTES;

  if (typeof candidate !== "string" || !candidate.trim()) return rejected("empty_path");
  if (typeof cwd !== "string" || !cwd.trim()) return rejected("invalid_cwd");

  let fd = null;
  try {
    const cwdLexical = resolve(cwd);
    const cwdReal = realpathSync(cwdLexical);
    if (!statSync(cwdReal).isDirectory()) return rejected("invalid_cwd");

    const rawPath = candidate.trim();
    const expanded = rawPath === "~"
      ? homeDir
      : rawPath.startsWith("~/")
        ? resolve(homeDir, rawPath.slice(2))
        : rawPath;
    const lexicalPath = isAbsolute(expanded) ? resolve(expanded) : resolve(cwdLexical, expanded);
    if (!isWithin(cwdLexical, lexicalPath) || lexicalPath === cwdLexical) {
      return rejected("outside_cwd");
    }
    const lexicalReason = blockedRelativePathReason(relative(cwdLexical, lexicalPath));
    if (lexicalReason) return rejected(lexicalReason);

    const lexicalStat = lstatSync(lexicalPath);
    if (lexicalStat.isSymbolicLink()) return rejected("symlink");
    if (!lexicalStat.isFile()) return rejected("not_regular_file");

    const realPath = realpathSync(lexicalPath);
    if (!isWithin(cwdReal, realPath) || realPath === cwdReal) return rejected("outside_cwd");

    const realReason = blockedRelativePathReason(relative(cwdReal, realPath));
    if (realReason) return rejected(realReason);

    if (inboundDir) {
      try {
        const inboundReal = realpathSync(resolve(inboundDir));
        if (isWithin(inboundReal, realPath)) return rejected("inbound_upload");
      } catch (error) {
        if (error?.code !== "ENOENT") return rejected("inbound_unverifiable");
        // A missing inbound directory cannot contain the candidate.
      }
    }

    const extension = extname(realPath).toLowerCase();
    const kind = OUTBOUND_IMAGE_EXTENSIONS.has(extension)
      ? "image"
      : OUTBOUND_DOCUMENT_EXTENSIONS.has(extension)
        ? "document"
        : null;
    if (!kind) return rejected("unsupported_type");

    const noFollow = Number(constants.O_NOFOLLOW || 0);
    fd = openSync(realPath, constants.O_RDONLY | noFollow);
    const before = fstatSync(fd);
    if (!before.isFile()) return rejected("not_regular_file");
    if (before.size > maxBytes) return rejected("too_large");

    const data = readExact(fd, before.size);
    const after = fstatSync(fd);
    if (data.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return rejected("changed_during_read");
    }

    return {
      ok: true,
      data,
      extension,
      fileName: basename(realPath),
      kind,
      realPath,
    };
  } catch (error) {
    return rejected(error?.code === "ENOENT" ? "not_found" : "unreadable");
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
