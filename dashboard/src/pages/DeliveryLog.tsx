import { useState } from 'react'
import { Link } from 'react-router'
import StatusPill from '../components/StatusPill'
import { clock } from '../format'
import { deliveries } from '../mocks'
import type { DeliveryStatus } from '../types'

type Filter = DeliveryStatus | 'all'

const filters: Filter[] = ['all', 'pending', 'delivered', 'dead']

export default function DeliveryLog() {
  const [filter, setFilter] = useState<Filter>('all')

  const rows =
    filter === 'all'
      ? deliveries.data
      : deliveries.data.filter((d) => d.status === filter)

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Delivery log</h1>

      <div className="flex gap-2">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={[
              'mono rounded-full border px-3 py-1 text-xs transition-colors',
              f === filter
                ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                : 'border-[var(--line-soft)] text-[var(--ink-dim)] hover:border-[var(--line)]',
            ].join(' ')}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-md border border-[var(--line-soft)] bg-[var(--card)]">
        <table className="w-full min-w-xl text-sm">
          <thead>
            <tr className="border-b border-[var(--line-soft)] text-left text-xs text-[var(--ink-dim)]">
              <th className="px-4 py-2 font-medium">Event</th>
              <th className="px-4 py-2 font-medium">Endpoint</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Attempts</th>
              <th className="px-4 py-2 text-right font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr
                key={d.id}
                className="border-b border-[var(--line-soft)] last:border-0 hover:bg-[var(--paper)]"
              >
                <td className="px-4 py-2.5">
                  <Link
                    to={`/deliveries/${d.id}`}
                    className="mono text-[var(--accent)] hover:underline"
                  >
                    {d.event.type}
                  </Link>
                </td>
                <td className="px-4 py-2.5 text-[var(--ink-dim)]">{d.endpoint.name}</td>
                <td className="px-4 py-2.5">
                  <StatusPill status={d.status} />
                  {d.next_attempt_at && (
                    <span className="mono ml-2 text-xs text-[var(--ink-faint)]">
                      next {clock(d.next_attempt_at)}
                    </span>
                  )}
                </td>
                <td className="mono px-4 py-2.5 text-right tabular-nums">{d.attempts}</td>
                <td className="mono px-4 py-2.5 text-right tabular-nums text-[var(--ink-dim)]">
                  {clock(d.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {rows.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-[var(--ink-dim)]">
            No deliveries with status {filter}.
          </p>
        )}
      </div>
    </div>
  )
}
