import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { isAbsolute, relative, resolve, sep } from "path";

const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9]|lpt[1-9])$/i;
const DEFAULT_MAX_FILENAME_LENGTH = 180;

function safeSlice(value, maxLength) {
  let sliced = value.slice(0, maxLength);
  if (/[\ud800-\udbff]$/.test(sliced)) sliced = sliced.slice(0, -1);
  return sliced;
}

function truncatePreservingExtension(filename, maxLength) {
  if (filename.length <= maxLength) return filename;

  const dot = filename.lastIndexOf(".");
  const extension = dot > 0 && filename.length - dot <= 20
    ? filename.slice(dot)
    : "";
  const stemSource = extension ? filename.slice(0, dot) : filename;
  const stem = safeSlice(stemSource, Math.max(1, maxLength - extension.length))
    .replace(/[ .]+$/g, "") || "file";
  return `${stem}${extension}`;
}

function safeFallback(value) {
  const normalized = String(value || "file").normalize("NFKC");
  const finalSegment = normalized.split(/[\\/]+/).at(-1) || "file";
  const cleaned = finalSegment
    .replace(WINDOWS_INVALID_CHARS, "_")
    .replace(/^ +|[ .]+$/g, "");
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}

/**
 * Convert an untrusted remote filename into one portable path component.
 * This handles both slash styles even when running on the other OS, removes
 * Windows-invalid characters, and neutralizes DOS device names.
 */
export function sanitizeInboundFilename(value, options = {}) {
  const fallback = safeFallback(options.fallback || "file");
  const maxLength = Math.min(
    240,
    Math.max(16, Number(options.maxLength) || DEFAULT_MAX_FILENAME_LENGTH),
  );
  const normalized = String(value || "").normalize("NFKC");
  let filename = normalized.split(/[\\/]+/).at(-1) || "";

  filename = filename
    .replace(WINDOWS_INVALID_CHARS, "_")
    .replace(/^ +|[ .]+$/g, "");

  if (!filename || filename === "." || filename === "..") filename = fallback;

  const stem = filename.split(".", 1)[0].replace(/[ .]+$/g, "");
  if (WINDOWS_RESERVED_STEM.test(stem)) filename = `_${filename}`;

  filename = truncatePreservingExtension(filename, maxLength)
    .replace(/[ .]+$/g, "");
  return filename || fallback;
}

export function createInboundFileTarget(directory, remoteFilename, options = {}) {
  if (typeof directory !== "string" || !directory.trim()) {
    throw new TypeError("Inbound file directory must be a non-empty path");
  }

  const root = resolve(directory);
  const filename = sanitizeInboundFilename(remoteFilename, {
    fallback: options.fallback || "file",
    maxLength: DEFAULT_MAX_FILENAME_LENGTH,
  });
  const uniqueId = sanitizeInboundFilename(
    options.uniqueId || `${Date.now()}-${randomUUID().slice(0, 8)}`,
    { fallback: "download", maxLength: 48 },
  );
  const storedName = sanitizeInboundFilename(`${uniqueId}-${filename}`, {
    fallback: "download",
    maxLength: 240,
  });
  const path = resolve(root, storedName);
  const relativePath = relative(root, path);

  if (
    !relativePath
    || relativePath === ".."
    || relativePath.startsWith(`..${sep}`)
    || isAbsolute(relativePath)
  ) {
    throw new Error("Refusing to store an inbound file outside the files directory");
  }

  return { directory: root, filename, storedName, path };
}

export function persistInboundFile(directory, remoteFilename, data, options = {}) {
  const target = createInboundFileTarget(directory, remoteFilename, options);
  const ensureDirectory = options.ensureDirectory || mkdirSync;
  const writeFile = options.writeFile || writeFileSync;

  ensureDirectory(target.directory, { recursive: true });
  writeFile(target.path, data, { flag: "wx" });
  return target;
}
