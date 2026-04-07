import { spawn } from "node:child_process";
import { join } from "path";
import { createInterface } from "readline";
import { encodeMessage, parseMessage } from "../agent/protocol.js";

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function createExecutor() {
  const serverPath = join(import.meta.dir, "..", "agent", "server.js");

  return {
    name: "local-agent",
    label: "Local Agent",

    async *streamTask(task, abortSignal, overrides = {}) {
      const child = spawn(process.execPath, [serverPath], {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });

      const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const ready = createDeferred();
      const done = createDeferred();
      const eventQueue = [];
      let fatalError = null;
      let stderrOutput = "";

      child.stderr.on("data", (chunk) => {
        stderrOutput += String(chunk || "");
      });

      child.on("error", (error) => {
        fatalError = error;
        done.resolve();
      });

      child.on("close", (code) => {
        if (!fatalError && code && code !== 0) {
          fatalError = new Error(stderrOutput.trim() || `local-agent exited with code ${code}`);
        }
        done.resolve();
      });

      const reader = (async () => {
        for await (const line of stdout) {
          if (!String(line || "").trim()) continue;
          const message = parseMessage(line);

          if (message.type === "ready") {
            ready.resolve();
            continue;
          }

          if (message.type === "event") {
            eventQueue.push(message.event);
            continue;
          }

          if (message.type === "approval_request") {
            const response = overrides.requestPermission
              ? await overrides.requestPermission(message.toolName, message.input, message.sdkOptions)
              : { behavior: "deny", message: "approval handler unavailable" };
            child.stdin.write(encodeMessage({
              type: "approval_response",
              requestId: message.requestId,
              response,
            }));
            continue;
          }

          if (message.type === "error") {
            fatalError = new Error(message.message || "local-agent task failed");
            continue;
          }

          if (message.type === "done") {
            done.resolve();
          }
        }
      })();

      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          child.kill("SIGTERM");
        }, { once: true });
      }

      await ready.promise;
      child.stdin.write(encodeMessage({
        type: "run_task",
        capability: task.capability || "ai_turn",
        backendName: task.backendName,
        prompt: task.prompt,
        sessionId: task.sessionId || null,
        cwd: task.cwd || process.cwd(),
        overrides: {
          ...overrides,
          requestPermission: undefined,
        },
      }));

      while (true) {
        if (eventQueue.length) {
          yield eventQueue.shift();
          continue;
        }

        if (fatalError) {
          await reader;
          throw fatalError;
        }

        const doneResult = await Promise.race([
          done.promise.then(() => "done"),
          new Promise((resolve) => setTimeout(() => resolve("tick"), 20)),
        ]);

        if (doneResult === "done" && !eventQueue.length) {
          await reader;
          if (fatalError) throw fatalError;
          return;
        }
      }
    },
  };
}
