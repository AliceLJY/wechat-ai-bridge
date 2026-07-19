import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readOutboundFile } from "../outbound-files.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "wechat-outbound-test-"));
  const cwd = join(root, "cwd");
  const inboundDir = join(cwd, "files");
  const outside = join(root, "outside");
  mkdirSync(inboundDir, { recursive: true });
  mkdirSync(outside);
  return { root, cwd, inboundDir, outside };
}

test("reads a bounded regular file under the current chat cwd", () => {
  const f = fixture();
  try {
    const output = join(f.cwd, "report.txt");
    writeFileSync(output, "fixture output");
    const result = readOutboundFile("report.txt", {
      cwd: f.cwd,
      inboundDir: f.inboundDir,
      homeDir: f.root,
    });
    assert.equal(result.ok, true);
    assert.equal(result.fileName, "report.txt");
    assert.equal(result.kind, "document");
    assert.equal(result.data.toString(), "fixture output");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects paths outside cwd, inbound uploads, dotfiles, config, and logs", () => {
  const f = fixture();
  try {
    const sensitiveDirectories = [
      "auth", "config", "configs", "credential", "credentials", "keys", "log",
      "logs", "oauth", "secret", "secrets", "session", "sessions", "token", "tokens",
    ];
    const sensitiveFiles = [
      "oauth_creds.json",
      "google-token.json",
      "private-key.pem",
      "client-secret.json",
      "service-account.json",
      "id_ed25519.txt",
      "run.log.gz",
    ];
    const cases = [
      [join(f.outside, "outside.txt"), "outside_cwd"],
      [join(f.inboundDir, "upload.txt"), "inbound_upload"],
      [join(f.cwd, ".secret.txt"), "dotfile"],
      [join(f.cwd, ".hidden", "report.pdf"), "dotfile"],
      [join(f.cwd, "config.json"), "sensitive_path"],
      [join(f.cwd, "credentials", "key.json"), "sensitive_path"],
      [join(f.cwd, "bridge.log"), "sensitive_path"],
      [join(f.cwd, "line\nbreak.pdf"), "invalid_path"],
      ...sensitiveDirectories.map((directory) => [
        join(f.cwd, directory, "report.pdf"),
        "sensitive_path",
      ]),
      ...sensitiveFiles.map((fileName) => [join(f.cwd, fileName), "sensitive_path"]),
    ];
    for (const [path, reason] of cases) {
      if (reason === "invalid_path") continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, "blocked");
    }
    for (const [path, reason] of cases) {
      assert.deepEqual(
        readOutboundFile(path, { cwd: f.cwd, inboundDir: f.inboundDir, homeDir: f.root }),
        { ok: false, reason },
      );
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("uses token boundaries without rejecting ordinary names that merely contain a substring", () => {
  const f = fixture();
  try {
    for (const fileName of ["monkey.json", "keynote.pdf", "tokenization.md"]) {
      const path = join(f.cwd, fileName);
      writeFileSync(path, "safe");
      assert.equal(readOutboundFile(path, { cwd: f.cwd, inboundDir: f.inboundDir }).ok, true);
    }
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("checks lexical and real path segments around intermediate symbolic links", {
  skip: process.platform === "win32",
}, () => {
  const f = fixture();
  try {
    const visibleDirectory = join(f.cwd, "visible");
    const hiddenDirectory = join(f.cwd, ".hidden-real");
    const secretsDirectory = join(f.cwd, "secrets");
    mkdirSync(visibleDirectory);
    mkdirSync(hiddenDirectory);
    mkdirSync(secretsDirectory);
    writeFileSync(join(visibleDirectory, "report.pdf"), "visible");
    writeFileSync(join(hiddenDirectory, "report.pdf"), "hidden");
    writeFileSync(join(secretsDirectory, "report.pdf"), "secret");

    const hiddenLexicalLink = join(f.cwd, ".hidden-link");
    const visibleLink = join(f.cwd, "visible-link");
    const secretsLink = join(f.cwd, "safe-link");
    symlinkSync(visibleDirectory, hiddenLexicalLink, "dir");
    symlinkSync(hiddenDirectory, visibleLink, "dir");
    symlinkSync(secretsDirectory, secretsLink, "dir");

    assert.deepEqual(
      readOutboundFile(join(hiddenLexicalLink, "report.pdf"), { cwd: f.cwd }),
      { ok: false, reason: "dotfile" },
    );
    assert.deepEqual(
      readOutboundFile(join(visibleLink, "report.pdf"), { cwd: f.cwd }),
      { ok: false, reason: "dotfile" },
    );
    assert.deepEqual(
      readOutboundFile(join(secretsLink, "report.pdf"), { cwd: f.cwd }),
      { ok: false, reason: "sensitive_path" },
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("rejects symbolic links, unsupported types, directories, and oversized files before reading", () => {
  const f = fixture();
  try {
    const target = join(f.outside, "target.txt");
    const link = join(f.cwd, "link.txt");
    const linkedDirectory = join(f.cwd, "linked-directory");
    const executable = join(f.cwd, "program.exe");
    const directory = join(f.cwd, "folder.txt");
    const large = join(f.cwd, "large.txt");
    writeFileSync(target, "outside");
    writeFileSync(executable, "binary");
    mkdirSync(directory);
    writeFileSync(large, "12345");

    if (process.platform !== "win32") {
      symlinkSync(target, link);
      assert.deepEqual(readOutboundFile(link, { cwd: f.cwd }), { ok: false, reason: "symlink" });
      symlinkSync(f.outside, linkedDirectory, "dir");
      assert.deepEqual(
        readOutboundFile(join(linkedDirectory, "target.txt"), { cwd: f.cwd }),
        { ok: false, reason: "outside_cwd" },
      );
    }
    assert.deepEqual(readOutboundFile(executable, { cwd: f.cwd }), { ok: false, reason: "unsupported_type" });
    assert.deepEqual(readOutboundFile(directory, { cwd: f.cwd }), { ok: false, reason: "not_regular_file" });
    assert.deepEqual(readOutboundFile(large, { cwd: f.cwd, maxBytes: 4 }), { ok: false, reason: "too_large" });
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
