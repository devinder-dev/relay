// Writes bounded, structured worker logs without serializing payloads, secrets or exceptions.
export type Level = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type WorkerLog = (level: Level, msg: string, fields?: Record<string, unknown>) => void;
const levels: Level[] = ["trace", "debug", "info", "warn", "error", "fatal"];

// Step 1: callers supply safe metadata only; the logger never receives full request rows.
export function createLog(minimum: Level, write = (line: string) => console.log(line)): WorkerLog {
  return (level, msg, fields = {}) => {
    if (levels.indexOf(level) < levels.indexOf(minimum)) return;
    write(JSON.stringify({ ...fields, level, time: new Date().toISOString(), msg }));
  };
}
export function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "UNKNOWN";
}
