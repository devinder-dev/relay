// Checks owner names before they can reach a Postgres text column.
import { z } from "zod";

// Step 1: reject control characters, including NUL (Postgres refuses it with 22021).
// Zod 4.6.7 counts code points, exactly like Postgres length() (checked: "👍🏽" is 2 in both),
// so this limit and the table's CHECK agree. Otherwise a NUL could turn invalid input into a 500.
export const OwnerName = z.string().min(1).max(100).regex(/^[^\p{Cc}]+$/u);
