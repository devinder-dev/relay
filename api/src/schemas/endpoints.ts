// Validates endpoint input, applying defaults and keeping the first of duplicate event types.
import { z } from "zod";
import { OwnerName } from "./owners.ts";

// Step 1: reject unknown fields before the service checks where the URL leads.
export const EndpointCreate = z.object({
  name: OwnerName,
  url: z.string().max(2048),
  event_types: z.array(z.union([z.literal("*"), z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,99}$/)]))
    .min(1).max(20).transform((types) => [...new Set(types)]).default(["*"]),
}).strict();
export type EndpointInput = z.infer<typeof EndpointCreate>;
