import { fork, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { assertVendorIntegrity } from "./integrity.js";
import { adapterInputSchema, isWrite, resultSchema, workerInputSchema, type AdapterInput, type AdapterResult, type NeteaseAdapter, type Operation, type AdapterErrorCode } from "./protocol.js";

export interface AdapterOptions {
  runtimeDir: string;
  /** Stable per authorization/QR flow, supplied by the server, never the browser. */
  deviceId?: string;
  /** Offline contract runner injection, never supplied by HTTP input. */
  workerPath?: string;
  vendorRoot?: string;
  hardDeadlineMs?: number;
}

export function createNeteaseAdapter(options: AdapterOptions): NeteaseAdapter {
  const workerPath = options.workerPath ?? fileURLToPath(new URL("../../dist/netease/worker.cjs", import.meta.url));
  const vendorRoot = options.vendorRoot ?? fileURLToPath(new URL("../../dist/netease/vendor", import.meta.url));
  const deadline = options.hardDeadlineMs ?? 25000;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > 25000) throw new Error("INVALID_DEADLINE");
  const active = new Map<ChildProcess, string>();
  const directories = new Set<string>();
  const pending = new Set<Promise<unknown>>();
  let disposed = false;
  const stopOnExit = () => {
    for (const child of active.keys()) child.kill("SIGKILL");
    for (const directory of directories) {
      try { rmSync(directory, { recursive: true, force: true }); } catch { /* No raw filesystem errors enter logs. */ }
    }
  };
  process.on("exit", stopOnExit);
  function failure(operation: Operation, code: AdapterErrorCode, possiblySent: boolean): AdapterResult {
    return { ok: false, error: { code, outcome: possiblySent && isWrite(operation) ? "unknown" : "failed" } };
  }

  async function invoke<I extends AdapterInput>(raw: I): Promise<AdapterResult<I["operation"]>> {
    const parsed = adapterInputSchema.safeParse(raw);
    if (!parsed.success || disposed) return { ok: false, error: { code: "INVALID_INPUT", outcome: "failed" } };
    const input = parsed.data;
    try { await assertVendorIntegrity(vendorRoot); }
    catch { return { ok: false, error: { code: "INTEGRITY_ERROR", outcome: "failed" } }; }
    const seed = "cookie" in input ? input.cookie : "key" in input ? input.key : randomBytes(26).toString("hex");
    const deviceId = input.deviceId ?? options.deviceId ?? createHash("sha256").update(seed).digest("hex").slice(0, 52).toUpperCase();
    const message = workerInputSchema.safeParse({ input, cookie: "cookie" in input ? input.cookie : "", deviceId, requestTimeoutMs: 15000 });
    if (!message.success || disposed) return { ok: false, error: { code: "INVALID_INPUT", outcome: "failed" } };
    let directory: string | undefined;
    let child: ChildProcess | undefined;
    let possiblySent = false;
    let result: AdapterResult = failure(input.operation, "PROCESS_ERROR", false);
    try {
      directory = await mkdtemp(join(options.runtimeDir, "netease-"));
      directories.add(directory);
      await chmod(directory, 0o700);
      if (disposed) return { ok: false, error: { code: "INVALID_INPUT", outcome: "failed" } };
      result = await new Promise<AdapterResult>(resolve => {
        child = fork(workerPath, [], {
          cwd: directory, execPath: process.execPath, execArgv: [],
          env: { TMPDIR: directory, TMP: directory, TEMP: directory, HOME: directory, NODE_ENV: "production" },
          stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json"
        });
        active.set(child, directory!);
        let response: AdapterResult | undefined;
        const timer = setTimeout(() => {
          response = failure(input.operation, "DEADLINE", possiblySent);
          child!.kill("SIGKILL");
        }, deadline);
        child.on("message", received => {
          if (response) { response = failure(input.operation, "PARSE_ERROR", possiblySent); child!.kill("SIGKILL"); return; }
          const checked = resultSchema(input.operation).safeParse(received);
          response = checked.success ? checked.data as AdapterResult : failure(input.operation, "PARSE_ERROR", possiblySent);
          if (!checked.success) child!.kill("SIGKILL");
        });
        child.once("error", () => {
          response = failure(input.operation, "PROCESS_ERROR", possiblySent);
          child!.kill("SIGKILL");
        });
        child.once("close", (code, signal) => {
          clearTimeout(timer);
          const parentStopped = response && !response.ok && ["DEADLINE", "PARSE_ERROR", "PROCESS_ERROR"].includes(response.error.code);
          if (!response || ((code !== 0 || signal) && !parentStopped)) response = failure(input.operation, "PROCESS_ERROR", possiblySent);
          resolve(response);
        });
        possiblySent = true;
        child.send(message.data, error => {
          if (error) { response = failure(input.operation, "PROCESS_ERROR", possiblySent); child!.kill("SIGKILL"); }
        });
      });
    } catch { result = failure(input.operation, "PROCESS_ERROR", possiblySent); }
    finally {
      if (directory) {
        try { await rm(directory, { recursive: true, force: true }); directories.delete(directory); }
        catch { result = failure(input.operation, "PROCESS_ERROR", possiblySent); }
      }
      if (child) active.delete(child);
    }
    return result as AdapterResult<I["operation"]>;
  }
  return {
    async assertVendorIntegrity() { await assertVendorIntegrity(vendorRoot); },
    async dispose() {
      disposed = true;
      for (const child of active.keys()) child.kill("SIGKILL");
      await Promise.allSettled([...pending]);
      process.off("exit", stopOnExit);
    },
    call<I extends AdapterInput>(input: I): Promise<AdapterResult<I["operation"]>> {
      const task = invoke(input);
      pending.add(task);
      void task.then(() => pending.delete(task), () => pending.delete(task));
      return task;
    }
  };
}
