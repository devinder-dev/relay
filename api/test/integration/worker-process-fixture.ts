// Starts a worker child and captures safe logs, with bounded waits and no production settings.
import { fileURLToPath } from "node:url";
import { DATABASE_URL } from "./helpers.ts";

export async function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Test deadline exceeded (${ms} ms)`)), ms);
  })]); } finally { clearTimeout(timer); }
}
// Step 1: reserve a free port briefly; the worker's ready log is the startup barrier.
export function workerChild(allowOrigins = "", url = DATABASE_URL, longStatements = false) {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port; probe.stop(true);
  const args = [process.execPath, ...(longStatements ? ["--preload", "./test/integration/worker-timeout-preload.ts"] : []), "src/worker/main.ts"];
  const child = Bun.spawn(args, { cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, DATABASE_URL: url, HEALTH_PORT: String(port), SSRF_ALLOW_ORIGINS: allowOrigins,
      RETRY_SCHEDULE: "1s,1s", RETRY_JITTER: "0" }, stdout: "pipe", stderr: "pipe" });
  const ready = Promise.withResolvers<void>();
  let output = "";
  const reading = (async () => {
    for await (const bytes of child.stdout) {
      output += Buffer.from(bytes).toString();
      if (output.includes("worker ready")) ready.resolve();
    }
  })();
  const errors = new Response(child.stderr).text();
  const exited = child.exited.then(async (code) => { await reading; output += await errors; return code; });
  exited.then(() => ready.reject(new Error("Worker exited before ready")));
  // Avoid an unhandled ready rejection in the startup-cancellation test.
  ready.promise.catch(() => {});
  return { child, ready: ready.promise, exited, output: () => output, port,
    close: async () => { if (child.exitCode === null) child.kill("SIGKILL"); await exited; } };
}
