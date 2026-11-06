// Reads the environment variables once at startup and checks them with Zod.
// A missing or wrong value stops the app right away with a clear message,
// instead of failing later in the middle of a request.
import { z } from "zod";



// Step 1: only operators set these exact origins; Phase 4 adds the demo receiver.
// Empty in production until then. Customers never control this exception list.
export const AllowOrigins = z.string().default("").transform((raw, ctx) => {
  const origins: string[] = [];
  for (const item of raw.split(",").map((value) => value.trim()).filter(Boolean)) {
    try {
      const url = new URL(item);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.pathname !== "/" || url.href.includes("?") || url.href.includes("#")) throw new Error("Invalid origin");
      origins.push(url.origin);
    } catch {
      ctx.addIssue({ code: "custom", message: "must contain only http or https origins without credentials, paths, query or hash" });
      return z.NEVER;
    }
  }
  return origins;
});

// The settings the API needs. Env vars are text, so PORT is converted and checked.
const Env = z.object({
  SSRF_ALLOW_ORIGINS: AllowOrigins,

  PORT: z
    .string()
    .transform((s) => Number(s))
    .refine((n) => Number.isInteger(n), { message: "must be a whole number" })
    .refine((n) => n >= 1 && n <= 65535, { message: "must be a whole number between 1 and 65535" })
    .default(8080),
    
  GIT_SHA: z
  .string().default("dev"),

   LOG_LEVEL: z
  .enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Where Postgres is, with the login and password in it. Required: without a database the
  // API can't do its job, so a missing value stops it at once instead of at the first request.
  // In Kubernetes it comes from the Secret relay-db (key url), never from a file in git.
  DATABASE_URL: z
    .string()
    .refine((s) => s.startsWith("postgres://") || s.startsWith("postgresql://"), {
      message: "must be a postgres:// URL",
    }),

  // How many connections this pod may hold open. 5 is plenty for one pod with 100m CPU, and
  // keeps every pod together under Postgres's max_connections (the budget in the Phase 2 plan).
  DB_POOL_MAX: z
    .string()
    .transform((s) => Number(s))
    .refine((n) => Number.isInteger(n) && n >= 1 && n <= 20, { message: "must be a whole number between 1 and 20" })
    .default(5),

});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = Env.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
