import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBackend } from "../adapters/interface.js";
import { extractMuseFilePaths, MUSE_BRIDGE_HINT, rewriteInboundMarkers } from "../adapters/muse.js";
import { createBootstrapConfig, loadRuntimeConfig } from "../config.js";
import { readOutboundFile } from "../outbound-files.js";

// Verbatim shape of a real Muse reply (2026-10-08), trimmed after the path.
const REAL_REPLY = "做好了：`~/workspace/cc-shanhai/qingqiu-20s.mp4`（20 秒、704×1248 竖屏，两段接缝处抽帧连续）。";

test("finds the VM path in a real Muse reply", () => {
  assert.deepEqual(extractMuseFilePaths(REAL_REPLY), ["workspace/cc-shanhai/qingqiu-20s.mp4"]);
});

test("normalizes home-relative forms, dedupes, and stops at CJK punctuation", () => {
  const text = [
    "/home/hatch/workspace/a/b.png",
    "~/workspace/a/b.png",
    "workspace/山海/九尾.mp4，好了",
    "见 workspace/out/x.jpeg。",
  ].join("\n");
  assert.deepEqual(extractMuseFilePaths(text), [
    "workspace/a/b.png",
    "workspace/山海/九尾.mp4",
    "workspace/out/x.jpeg",
  ]);
});

test("ignores traversal, non-media files, and paths outside workspace", () => {
  const text = "workspace/../etc/x.png workspace/notes.txt ~/secrets/a.png /etc/b.mp4";
  assert.deepEqual(extractMuseFilePaths(text), []);
});

test("caps how many files one reply can pull back", () => {
  const text = Array.from({ length: 8 }, (_, i) => `workspace/f${i}.png`).join(" ");
  assert.equal(extractMuseFilePaths(text).length, 5);
});

test("rewrites inbound markers only for files inside the inbound dir", () => {
  const root = mkdtempSync(join(tmpdir(), "muse-inbound-"));
  try {
    const inbound = join(root, "files");
    mkdirSync(inbound);
    const inside = join(inbound, "1728-猫 图.jpg");
    const outside = join(root, "elsewhere.jpg");
    writeFileSync(inside, "x");
    writeFileSync(outside, "y");
    const prompt = `请看这张图片\n\n[图片文件: ${inside}]\n[文件: ${outside}]\n[图片文件: ${join(inbound, "missing.jpg")}]`;

    const { prompt: rewritten, uploads } = rewriteInboundMarkers(prompt, inbound);

    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].remote, "workspace/wechat-in/1728-___.jpg");
    assert.match(rewritten, /\[图片文件: ~\/workspace\/wechat-in\/1728-___\.jpg\]/);
    assert.ok(rewritten.includes(`[文件: ${outside}]`), "outside file must stay untouched");
    assert.ok(rewritten.includes("missing.jpg]"), "missing file must stay untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("muse backend loads without contacting Muse and carries its own hint", async () => {
  const adapter = await createBackend("muse", {});
  assert.equal(adapter.name, "muse");
  assert.equal(adapter.bridgeHint, MUSE_BRIDGE_HINT);
  assert.match(adapter.bridgeHint, /纯文本/);
  assert.equal(typeof adapter.streamQuery, "function");
});

test("videos are sendable as attachments", () => {
  const root = mkdtempSync(join(tmpdir(), "muse-video-"));
  try {
    writeFileSync(join(root, "clip.mp4"), "fake video");
    const result = readOutboundFile("clip.mp4", { cwd: root, homeDir: root });
    assert.equal(result.ok, true);
    assert.equal(result.kind, "video");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("muse runtime config passes the interpreter path through", () => {
  const root = mkdtempSync(join(tmpdir(), "muse-config-"));
  try {
    const configPath = join(root, "config.json");
    const config = createBootstrapConfig("muse");
    assert.equal(config.backends.muse.enabled, true);
    assert.equal(config.backends.claude.enabled, false);
    config.shared.cwd = root;
    config.shared.allowedUserIds = ["trusted-user"];
    config.backends.muse.python = "/opt/muse/bin/python";
    writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });

    const runtime = loadRuntimeConfig({ backend: "muse", configPath });
    assert.equal(runtime.env.ENABLED_BACKENDS, "muse");
    assert.equal(runtime.env.MUSE_PYTHON, "/opt/muse/bin/python");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
