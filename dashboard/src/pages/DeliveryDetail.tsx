import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import StatusPill from '../components/StatusPill'
import { clock } from '../format'
import {
  deliveredDeliveryDetail,
  deliveryDetail,
  pendingDeliveryDetail,
  recoveredDeliveryDetail,
  replayResponse,
} from '../mocks'
import type { DeliveryDetail as Detail } from '../types'

// Stands in for the server's memory. A real API writes the replay to the database
// and hands back the new state on the next GET; these fixtures are frozen, so this
// holds what replay changed. Keyed by id, because replaying one delivery must not
// make the screen forget another. It goes away in phase 5.3, when src/api.ts takes
// over and the server remembers instead.
const replayed = new Map<string, Detail>()

// One fixture per row in the log, so every row in the log opens.
const fixtures = [
  pendingDeliveryDetail,
  deliveryDetail,
  deliveredDeliveryDetail,
  recoveredDeliveryDetail,
]

// Stands in for GET /v1/deliveries/:id until the API exists. A replayed delivery
// wins over the fixture it came from, or the 2 s reload would hand back the old row.
function load(id: string | undefined): Detail | null {
  if (!id) return null
  return replayed.get(id) ?? fixtures.find((d) => d.id === id) ?? null
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-[var(--ink-dim)]">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  )
}

export default function DeliveryDetail() {
  const { id } = useParams()
  const [delivery, setDelivery] = useState(() => load(id))

  // A pending delivery is waiting for its next try, so the screen reloads itself
  // until it is not pending any more. Nothing is started for a delivery that is
  // already delivered or dead, and the timer is cleared on the way out so it
  // cannot outlive the screen.
  useEffect(() => {
    if (delivery?.status !== 'pending') return

    const timer = setInterval(() => setDelivery(load(id)), 2000)

    return () => clearInterval(timer)
  }, [delivery?.status, id])

  if (!delivery) {
    return (
      <p className="text-sm text-[var(--ink-dim)]">
        Delivery not found.{' '}
        <Link to="/deliveries" className="text-[var(--accent)] hover:underline">
          Back to the log
        </Link>
      </p>
    )
  }

  // Replay answers with a Delivery, not a DeliveryDetail, so take only the four
  // fields it changes. Spreading the whole answer would replace `event` with the
  // short version and lose the payload.
  //
  // The result is written twice on purpose: to `replayed` so the reload finds it,
  // and to state so the screen updates now. ADR 0002: "Replay triggers one reload."
  function replay() {
    const next: Detail = {
      ...delivery!,
      status: replayResponse.status,
      attempts: replayResponse.attempts,
      next_attempt_at: replayResponse.next_attempt_at,
      last_error: replayResponse.last_error,
    }
    replayed.set(next.id, next)
    setDelivery(next)
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/deliveries" className="mono text-xs text-[var(--accent)] hover:underline">
        ← Back to the log
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mono text-xl font-medium">{delivery.event.type}</h1>
        <StatusPill status={delivery.status} />
        {delivery.status !== 'delivered' && (
          <button
            onClick={replay}
            className="ml-auto rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Replay
          </button>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-4 rounded-md border border-[var(--line-soft)] bg-[var(--card)] p-4 sm:grid-cols-4">
        <Row label="Attempts">
          <span className="mono tabular-nums">{delivery.attempts}</span>
        </Row>
        <Row label="Endpoint">{delivery.endpoint.name}</Row>
        <Row label="Next attempt">
          <span className="mono">
            {delivery.next_attempt_at ? clock(delivery.next_attempt_at, true) : '—'}
          </span>
        </Row>
        <Row label="Delivered">
          <span className="mono">
            {delivery.delivered_at ? clock(delivery.delivered_at, true) : '—'}
          </span>
        </Row>
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Payload</h2>
        <pre className="overflow-x-auto rounded-md border border-[var(--line-soft)] bg-[var(--card)] px-4 py-3 text-xs">
          {JSON.stringify(delivery.event.payload, null, 2)}
        </pre>
        <p className="mono text-xs text-[var(--ink-faint)]">
          sent to {delivery.endpoint.url}
        </p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">Attempts</h2>
        <div className="overflow-x-auto rounded-md border border-[var(--line-soft)] bg-[var(--card)]">
          <table className="w-full min-w-xl text-sm">
            <thead>
              <tr className="border-b border-[var(--line-soft)] text-left text-xs text-[var(--ink-dim)]">
                <th className="px-4 py-2 font-medium">#</th>
                <th className="px-4 py-2 font-medium">Started</th>
                <th className="px-4 py-2 text-right font-medium">Took</th>
                <th className="px-4 py-2 text-right font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {delivery.attempt_log.map((a) => (
                <tr key={a.id} className="border-b border-[var(--line-soft)] last:border-0">
                  <td className="mono px-4 py-2 tabular-nums text-[var(--ink-dim)]">
                    {a.number}
                  </td>
                  <td className="mono px-4 py-2 tabular-nums">{clock(a.started_at, true)}</td>
                  <td className="mono px-4 py-2 text-right tabular-nums text-[var(--ink-dim)]">
                    {a.duration_ms} ms
                  </td>
                  <td
                    className={`mono px-4 py-2 text-right tabular-nums ${
                      a.status_code && a.status_code >= 400 ? 'text-[var(--bad)]' : ''
                    }`}
                  >
                    {a.status_code ?? '—'}
                  </td>
                  <td className="mono px-4 py-2 text-xs text-[var(--bad)]">{a.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
