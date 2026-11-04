// Checks event envelopes and optional retry keys before they reach the service.
import { z } from "zod";

// Step 1: payloads must be objects; unknown envelope fields are rejected.
export const EventCreate = z.object({
  type: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/),
  payload: z.record(z.string(), z.unknown()),
}).strict();
export const IdempotencyKey = z.string().min(1).max(255).regex(/^[^\p{Cc}]+$/u).optional();
export type EventInput = z.infer<typeof EventCreate>;
