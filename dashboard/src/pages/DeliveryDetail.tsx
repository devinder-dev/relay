import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import StatusPill from '../components/StatusPill'
import { getDelivery, replayDelivery, type ApiFailure } from '../api'
import { clock } from '../format'
import type { DeliveryDetail as Detail } from '../types'

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-[var(--ink-dim)]">{label}</dt>
      <dd className="m-0 text-sm">{children}</dd>
    </div>
  )
}

/**
 * Reads the id from the route and gives the screen below it that id as its React key.
 *
 * Without the key, going from one delivery to another is the same route pattern, so React
 * keeps the same component instance: `useState`'s initializer never runs again and the screen
 * keeps showing the previous delivery. The key makes the id the screen's identity, so a
 * different id is a different screen - which also restarts the 2 s poll from scratch.
 *
 * Latent today: nothing links one detail screen to another, so there is no way to reach it by
 * clicking, and typing a URL reloads the page and remounts anyway. It is here so that adding a
 * "next delivery" link later can't quietly bring the bug with it.
 */
export default function DeliveryDetail() {
  const { id } = useParams()
  return <Screen key={id} id={id} />
}

function Screen({ id }: { id: string | undefined }) {
  const [delivery, setDelivery] = useState<Detail | null>(null)
  const [failure, setFailure] = useState<ApiFailure | null>(null)
  const [replayFailure, setReplayFailure] = useState<string | null>(null)

  // First load. `ignore` stops a late answer landing on a screen that has moved on.
  useEffect(() => {
    let ignore = false
    if (!id) return

    getDelivery(id)
      .then((found) => {
        if (!ignore) setDelivery(found)
      })
      .catch((error: unknown) => {
        if (!ignore) setFailure(error as ApiFailure)
      })

    return () => {
      ignore = true
    }
  }, [id])

  // A pending delivery is waiting for its next try, so the screen reloads itself until it
  // is not pending any more. Nothing is started for a delivery that is already delivered
  // or dead, and the timer is cleared on the way out so it cannot outlive the screen.
  useEffect(() => {
    if (!id || delivery?.status !== 'pending') return

    const timer = setInterval(() => {
      // A failed reload is ignored on purpose: the screen keeps the last good answer and
      // tries again in two seconds. Blanking a working screen because one request out of
      // thirty hiccuped would be worse than showing data two seconds old.
      void getDelivery(id)
        .then(setDelivery)
        .catch(() => {})
    }, 2000)

    return () => clearInterval(timer)
  }, [delivery?.status, id])

  if (failure) {
    // 404 is its own sentence: the contract answers 404 for a missing id, another owner's
    // id and a malformed one alike, so this is all the screen can honestly say.
    return (
      <p className="text-sm text-[var(--ink-dim)]">
        {failure.code === 'not_found' ? 'Delivery not found.' : failure.message}{' '}
        <Link to="/deliveries" className="text-[var(--accent)] hover:underline">
          Back to the log
        </Link>
      </p>
    )
  }

  if (!delivery) return <p className="text-sm text-[var(--ink-dim)]">Loading…</p>

  // 202 answers with a Delivery, not a DeliveryDetail, so only the four fields the
  // contract changes are merged in. Spreading the whole answer would replace `event` with
  // the short version and lose the payload this screen shows.
  async function replay() {
    setReplayFailure(null)
    try {
      const replayed = await replayDelivery(delivery!.id)
      setDelivery({
        ...delivery!,
        status: replayed.status,
        attempts: replayed.attempts,
        next_attempt_at: replayed.next_attempt_at,
        last_error: replayed.last_error,
      })
    } catch (error: unknown) {
      // The three refusals the contract allows here (already delivered, endpoint deleted,
      // being sent right now) all arrive with a message written for a person.
      setReplayFailure((error as ApiFailure).message)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <Link to="/deliveries" className="mono text-xs text-[var(--accent)] hover:underline">
        ← Back to the log
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mono text-xl font-medium">{delivery.event.type}</h1>
        <StatusPill status={delivery.status} />
        {/* A delivered delivery has nothing to retry, and the contract refuses a
            replay whose endpoint was deleted with 409 endpoint_deleted. Showing a
            button that can only fail is worse than showing why it is gone. A
            pending delivery keeps its button: replaying it means "try now". */}
        {delivery.status === 'delivered' ? null : delivery.last_error === 'endpoint_deleted' ? (
          <p className="ml-auto text-xs text-[var(--ink-dim)]">
            Its endpoint was deleted, so this cannot be replayed.
          </p>
        ) : (
          <button
            onClick={replay}
            className="ml-auto rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Replay
          </button>
        )}
      </div>

      {replayFailure && <p className="text-sm text-[var(--bad)]">{replayFailure}</p>}

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
