import assert from "node:assert/strict";
import test from "node:test";
import { dirname, resolve } from "node:path";
import {
  createInboundFileTarget,
  persistInboundFile,
  sanitizeInboundFilename,
} from "../inbound-files.js";

test("sanitizes traversal from Unix, Windows, UNC, and normalized Unicode paths", () => {
  const cases = [
    ["../../../../etc/passwd", "passwd"],
    ["..\\..\\Windows\\System32\\drivers\\etc\\hosts", "hosts"],
    ["C:\\temp\\report.pdf", "report.pdf"],
    ["\\\\server\\share\\payload.txt", "payload.txt"],
    ["．．／CON.txt", "_CON.txt"],
    ["folder/", "file"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(sanitizeInboundFilename(input), expected, input);
  }
});

test("normalizes Windows-invalid characters, device names, and trailing dots or spaces", () => {
  const cases = [
    ["report<final>:v1?.txt", "report_final__v1_.txt"],
    ["CON", "_CON"],
    ["con.txt", "_con.txt"],
    ["aux. ", "_aux"],
    ["LPT9 .txt", "_LPT9 .txt"],
    ["COM¹.txt", "_COM1.txt"],
    ["notes.txt. ", "notes.txt"],
    ["..", "file"],
    [".env", ".env"],
    ["line\nbreak.txt", "line_break.txt"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(sanitizeInboundFilename(input), expected, input);
  }
});

test("bounds long components while preserving a short extension", () => {
  const filename = sanitizeInboundFilename(`${"a".repeat(400)}.pdf`);
  assert.ok(filename.length <= 180);
  assert.ok(filename.endsWith(".pdf"));
});

test("resolved download targets remain direct children of the files directory", () => {
  const root = resolve("fixtures", "files");
  const target = createInboundFileTarget(root, "../../../../outside.txt", {
    uniqueId: "..\\..\\fixed",
  });

  assert.equal(target.filename, "outside.txt");
  assert.equal(target.storedName, "fixed-outside.txt");
  assert.equal(dirname(target.path), root);
});

test("persistence uses exclusive creation and the sanitized display name without I/O", () => {
  const calls = [];
  const data = Buffer.from("fixture");
  const saved = persistInboundFile("fixtures/files", "..\\CON.txt", data, {
    uniqueId: "case-1",
    ensureDirectory: (...args) => calls.push(["mkdir", ...args]),
    writeFile: (...args) => calls.push(["write", ...args]),
  });

  assert.equal(saved.filename, "_CON.txt");
  assert.equal(saved.storedName, "case-1-_CON.txt");
  assert.deepEqual(calls[0], ["mkdir", resolve("fixtures/files"), { recursive: true }]);
  assert.deepEqual(calls[1], ["write", saved.path, data, { flag: "wx" }]);
});
