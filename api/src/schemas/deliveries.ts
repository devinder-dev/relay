// Checks delivery filters and cursor input without silently accepting numeric formats.
import { z } from "zod";

// Step 1: only digit text becomes a page size, with a bounded default.
export const DeliveryListQuery = z.object({
  status: z.enum(["pending", "delivered", "dead"]).optional(),
  endpoint_id: z.uuid().optional(),
  limit: z.string().regex(/^[0-9]{1,3}$/).transform(Number)
    .pipe(z.number().int().min(1).max(100)).default(50),
  cursor: z.uuid().optional(),
}).strict();
export const DeliveryId = z.uuid();
