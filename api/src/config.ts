// Reads the environment variables once at startup and checks them with Zod.
// A missing or wrong value stops the app right away with a clear message,
// instead of failing later in the middle of a request.
import { z } from "zod";



// The settings the API needs. Env vars are text, so PORT is converted and checked.
const Env = z.object({

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


});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = Env.safeParse(env);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
