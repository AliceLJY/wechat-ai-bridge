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

function rejected(reason) {
  return { ok: false, reason };
}

function isWithin(root, target) {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function hasDotPathSegment(relativePath) {
  return relativePath.split(sep).some((segment) => segment.startsWith("."));
}

function isSensitivePath(relativePath) {
  const segments = relativePath.split(sep);
  return segments.some((segment, index) => {
    const lower = segment.toLowerCase();
    if (["config", "log", "logs"].includes(lower)) return true;
    if (index !== segments.length - 1) return false;
    return /^(?:config|token|credentials?|secrets?)(?:\.|$)/i.test(segment)
      || /\.log(?:\.|$)/i.test(segment);
  });
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
    const cwdReal = realpathSync(resolve(cwd));
    if (!statSync(cwdReal).isDirectory()) return rejected("invalid_cwd");

    const rawPath = candidate.trim();
    const expanded = rawPath === "~"
      ? homeDir
      : rawPath.startsWith("~/")
        ? resolve(homeDir, rawPath.slice(2))
        : rawPath;
    const lexicalPath = isAbsolute(expanded) ? resolve(expanded) : resolve(cwdReal, expanded);
    const lexicalStat = lstatSync(lexicalPath);
    if (lexicalStat.isSymbolicLink()) return rejected("symlink");
    if (!lexicalStat.isFile()) return rejected("not_regular_file");

    const realPath = realpathSync(lexicalPath);
    if (!isWithin(cwdReal, realPath) || realPath === cwdReal) return rejected("outside_cwd");

    const relativePath = relative(cwdReal, realPath);
    if (hasDotPathSegment(relativePath)) return rejected("dotfile");
    if (isSensitivePath(relativePath)) return rejected("sensitive_path");

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
