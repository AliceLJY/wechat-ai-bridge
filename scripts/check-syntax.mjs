import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skippedDirectories = new Set([".git", "node_modules"]);

function collectJavaScriptFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        collectJavaScriptFiles(join(directory, entry.name), files);
      }
      continue;
    }
    if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const files = collectJavaScriptFiles(root).sort();
let failed = false;

for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    failed = true;
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
  }
}

if (failed) process.exit(1);
console.log(`[syntax] checked ${files.length} JavaScript files`);
