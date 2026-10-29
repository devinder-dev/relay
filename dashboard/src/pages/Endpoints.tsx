import { useState, type FormEvent } from 'react'
import StatusPill from '../components/StatusPill'
import { endpointCreated, endpoints } from '../mocks'
import type { Endpoint, EndpointCreated } from '../types'

const field =
  'mono w-full rounded-md border border-[var(--line-soft)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none'

// Loopback, the three private IPv4 ranges, link-local, and IPv6 loopback. The API
// does the real check: it resolves the name first, because a public name can still
// point at 127.0.0.1.
const PRIVATE_HOST =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

// What counts as an endpoint URL we are willing to POST to.
//
// This is a security rule, not a tidiness one. A worker runs inside the cluster,
// so an endpoint pointing at a private address would have us fetch something the
// customer could never reach from outside: the Kubernetes API, Postgres, /metrics.
// That is SSRF, and the firewall cannot stop it, because the call comes from within.
// The API rejects the same URLs with 422 invalid_endpoint_url; this check only
// saves a round trip and gives a clearer message.
function checkUrl(raw: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  } catch {
    return 'Enter a full URL, for example https://example.com/hooks/relay'
  }

  if (parsed.protocol !== 'https:') return 'The URL must start with https://'

  const host = parsed.hostname
  if (PRIVATE_HOST.test(host)) return 'The URL must not point at a private or internal address'
  if (!host.includes('.') || host.endsWith('.')) return 'That host name does not look reachable'

  return null
}

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
    const urlError = checkUrl(url)
    if (urlError) return setError(urlError)

    // The row and the secret are split on purpose. The API answers POST /v1/endpoints
    // with the secret included, but the list it later returns never has one, so the
    // row we add must look like a list row. Keeping `signing_secret` in `rows` would
    // leave it in memory for the whole session, long after the box is dismissed.
    const { signing_secret: _secret, ...row } = endpointCreated
    const created = { ...row, id: crypto.randomUUID(), name: name.trim(), url: url.trim() }

    setRows([...rows, created])
    setSecret({ ...created, signing_secret: endpointCreated.signing_secret })
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
