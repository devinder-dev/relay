// Stands in for the server's database until `src/api.ts` replaces it in phase 5.3.
//
// Why a module and not component state: a replay used to live in the detail
// screen's own Map, so the log still said dead/8 while the detail said pending/0,
// and a new endpoint was forgotten as soon as you navigated away. Both screens now
// read the same data, and it outlives them.
//
// One source of truth, like the real API: only the **detail** fixtures are stored,
// and the log's rows are derived from them. Keeping a second list of rows and
// updating both on replay is the same shape as the bug where a log row had no
// detail screen at all - so that shape is gone rather than guarded by a test.
//
// Not a state library on purpose. Mutable data behind plain functions, read when a
// screen mounts; React Router mounts a screen again on every navigation, which is
// all the freshness these four screens need. No context, no subscriptions.
import {
  deliveredDeliveryDetail,
  deliveries,
  deliveryDetail,
  endpointCreated,
  endpointDeletedDetail,
  endpoints,
  pendingDeliveryDetail,
  recoveredDeliveryDetail,
  replayResponse,
} from './mocks'
import type {
  Delivery,
  DeliveryDetail,
  Endpoint,
  EndpointCreated,
  Page,
} from './types'

const details = new Map<string, DeliveryDetail>(
  [
    pendingDeliveryDetail,
    deliveryDetail,
    deliveredDeliveryDetail,
    recoveredDeliveryDetail,
    endpointDeletedDetail,
  ].map((d) => [d.id, d]),
)

// A log row is a delivery without its attempt history, and with the short event and
// endpoint objects. Written out rather than spread, so adding a field to
// DeliveryDetail cannot leak the payload into the list by accident.
function toRow(d: DeliveryDetail): Delivery {
  return {
    id: d.id,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: d.next_attempt_at,
    last_status_code: d.last_status_code,
    last_error: d.last_error,
    delivered_at: d.delivered_at,
    created_at: d.created_at,
    event: { id: d.event.id, type: d.event.type },
    endpoint: { id: d.endpoint.id, name: d.endpoint.name },
  }
}

/**
 * Stands in for `GET /v1/deliveries`. Newest first, as docs/api.md specifies.
 *
 * The sort is a plain string compare: every timestamp is ISO 8601 in UTC, and those
 * sort lexicographically in the same order as they do in time. `next_cursor` comes
 * from the fixture, so the shape the screens read is the shape the API will send.
 */
export function listDeliveries(): Page<Delivery> {
  const data = [...details.values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .map(toRow)

  return { data, next_cursor: deliveries.next_cursor }
}

/** Stands in for `GET /v1/deliveries/:id`. */
export function getDelivery(id: string | undefined): DeliveryDetail | null {
  if (!id) return null
  return details.get(id) ?? null
}

/**
 * Stands in for `POST /v1/deliveries/:id/replay`.
 *
 * Takes only the four fields the answer changes. Replay answers with a `Delivery`,
 * not a `DeliveryDetail`, so spreading the whole answer would replace `event` with
 * the short version and lose the payload the detail screen shows.
 *
 * `attempts` goes back to 0: it is the retry budget for the current cycle, not the
 * history. The history stays in `attempt_log`, and the next try becomes number 9.
 */
export function replayDelivery(id: string): DeliveryDetail | null {
  const current = details.get(id)
  if (!current) return null

  const next: DeliveryDetail = {
    ...current,
    status: replayResponse.status,
    attempts: replayResponse.attempts,
    next_attempt_at: replayResponse.next_attempt_at,
    last_error: replayResponse.last_error,
  }

  details.set(id, next)
  return next
}

const endpointRows: Endpoint[] = [...endpoints.data]

/** Stands in for `GET /v1/endpoints`: at most 20 per owner, so no paging. */
export function listEndpoints(): Endpoint[] {
  return [...endpointRows]
}

/**
 * Stands in for `POST /v1/endpoints`, the one answer that carries the secret.
 *
 * The stored row is built without `signing_secret`, because the list the API later
 * returns never has one. The caller gets the secret to show once and nothing keeps
 * a copy, so it is gone for good when that box is dismissed.
 */
export function addEndpoint(name: string, url: string): EndpointCreated {
  const { signing_secret, ...template } = endpointCreated

  const row: Endpoint = { ...template, id: crypto.randomUUID(), name, url }
  endpointRows.push(row)

  return { ...row, signing_secret }
}
