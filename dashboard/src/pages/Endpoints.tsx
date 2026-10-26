import { useState, type FormEvent } from 'react'
import StatusPill from '../components/StatusPill'
import { endpointCreated, endpoints } from '../mocks'
import type { Endpoint, EndpointCreated } from '../types'

const field =
  'mono w-full rounded-md border border-[var(--line-soft)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none'

export default function Endpoints() {
  const [rows, setRows] = useState<Endpoint[]>(endpoints.data)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)

  // The signing secret comes back once, in the answer to POST /v1/endpoints, and
  // is never returned again. Holding it here is what lets the screen show it; it
  // disappears for good as soon as this state is cleared.
  const [secret, setSecret] = useState<EndpointCreated | null>(null)

  function add(e: FormEvent) {
    e.preventDefault()

    if (!name.trim()) return setError('Give the endpoint a name.')
    if (!url.startsWith('https://')) return setError('The URL must start with https://')

    const created = { ...endpointCreated, name, url }
    setRows([...rows, created])
    setSecret(created)
    setName('')
    setUrl('')
    setError(null)
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-xl font-medium">Endpoints</h1>

      <div className="overflow-x-auto rounded-md border border-[var(--line-soft)] bg-[var(--card)]">
        <table className="w-full min-w-xl text-sm">
          <thead>
            <tr className="border-b border-[var(--line-soft)] text-left text-xs text-[var(--ink-dim)]">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">URL</th>
              <th className="px-4 py-2 font-medium">Event types</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr
                key={e.id}
                className="border-b border-[var(--line-soft)] last:border-0 hover:bg-[var(--paper)]"
              >
                <td className="px-4 py-2.5">{e.name}</td>
                <td className="mono px-4 py-2.5 text-[var(--ink-dim)]">{e.url}</td>
                <td className="mono px-4 py-2.5 text-xs text-[var(--ink-dim)]">
                  {e.event_types.join(', ')}
                </td>
                <td className="px-4 py-2.5">
                  <StatusPill status={e.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {secret && (
        <div className="rounded-md border border-[var(--warn)] bg-[var(--warn-bg)] p-4">
          <h2 className="text-sm font-medium">Signing secret for {secret.name}</h2>
          <p className="mt-1 text-sm text-[var(--ink-dim)]">
            Copy it now. It is shown once and cannot be retrieved later.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-md border border-[var(--line-soft)] bg-[var(--card)] px-3 py-2 text-xs">
            {secret.signing_secret}
          </pre>
          <button
            onClick={() => setSecret(null)}
            className="mt-3 rounded-md border border-[var(--line)] px-3 py-1.5 text-sm hover:bg-[var(--card)]"
          >
            I have copied it
          </button>
        </div>
      )}

      <form
        onSubmit={add}
        className="flex max-w-md flex-col gap-3 rounded-md border border-[var(--line-soft)] bg-[var(--card)] p-4"
      >
        <h2 className="text-sm font-medium">Add endpoint</h2>

        <label htmlFor="name" className="flex flex-col gap-1 text-xs text-[var(--ink-dim)]">
          Name
          <input
            id="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Slack alerts"
            className={field}
          />
        </label>

        <label htmlFor="url" className="flex flex-col gap-1 text-xs text-[var(--ink-dim)]">
          URL
          <input
            id="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/hooks/relay"
            className={field}
          />
        </label>

        {error && <p className="text-sm text-[var(--bad)]">{error}</p>}

        <button
          type="submit"
          className="self-start rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
        >
          Add endpoint
        </button>
      </form>
    </div>
  )
}
