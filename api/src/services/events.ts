// Saves an event and its deliveries atomically, or returns the original retry answer.
import type { Sql } from "../db.ts";
import { fanOut as repositoryFanOut } from "../repositories/deliveries.ts";
import { findEventByKey, insertEvent } from "../repositories/events.ts";
import type { EventInput } from "../schemas/events.ts";

// Step 1: an injected fan-out lets tests prove a failure rolls back the whole transaction.
export async function createEvent(
  sql: Sql, ownerId: string, input: EventInput, key?: string,
  { fanOut = repositoryFanOut }: { fanOut?: typeof repositoryFanOut } = {},
) {
  return sql.begin(async (tx) => {
    const event = await insertEvent(tx, ownerId, input, key);
    if (event) {
      const deliveries = await fanOut(tx, ownerId, event.id, event.type);
      return { event, deliveries, replayed: false };
    }
    // Step 2: the key wins, even with a different body; comparing bodies needs a new contract error code.
    const original = key === undefined ? null : await findEventByKey(tx, ownerId, key);
    if (!original) throw new Error("Conflicting event could not be found");
    return { event: original, deliveries: original.deliveries, replayed: true };
  });
}
