import { useEffect, useState, type FormEvent } from 'react'
import StatusPill from '../components/StatusPill'
import { createEndpoint, listEndpoints, type ApiFailure } from '../api'
import type { Endpoint, EndpointCreated } from '../types'

const field =
  'mono w-full rounded-md border border-[var(--line-soft)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none'

// The contract's length limits (docs/api.md, POST /v1/endpoints). The server stays
// the authority; these only let the form name the wrong field before a round trip.
const NAME_MAX = 100
const URL_MAX = 2048

// Addresses by number: loopback, 0.0.0.0, the three private IPv4 ranges, CGNAT,
// link-local, IPv6 loopback, IPv6 unique-local (fc00::/7) and IPv6 link-local
// (fe80::/10). The URL parser hands IPv6 hosts back bracketed, so the brackets are
// optional in the pattern rather than stripped beforehand.
const PRIVATE_ADDRESS =
  /^(localhost$|127\.|0\.0\.0\.0$|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?::1\]?$|\[?f[cd][0-9a-f]{2}:|\[?fe[89ab][0-9a-f]:)/i

// An IPv4 literal is four numbers; an IPv6 literal arrives bracketed. Neither is a
// host name, so the "looks like a name" rule must not be applied to them.
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

// Addresses by name. Inside the cluster nothing is reached by number: the API is
// kubernetes.default.svc.cluster.local and Postgres is postgres.relay.svc…, so a
// rule that only knows about digits lets both straight through. Cloud metadata
// answers to a name too (metadata.google.internal).
const INTERNAL_NAME = /(^|\.)(local|internal|localdomain)$|(^|\.)svc(\.|$)/i

// A helpful form check, not SSRF protection. Worth being exact about the difference:
// the real check is server-side (step 3.2), run after the name is resolved and again
// before every delivery attempt, and it also blocks our own VPS address, which this
// one does not. This check runs in the browser, so it can be skipped entirely by
// calling the API directly, and it only sees the host name — a public name whose DNS
// points at 127.0.0.1 passes here. What it buys is a clear message on the field
// instead of a bare 422, and one less round trip.
//
// The SSRF risk it mirrors: a worker runs inside the cluster, so an endpoint pointing
// at a private address would have us fetch something the customer could never reach
// from outside (the Kubernetes API, Postgres, /metrics). The firewall cannot stop
// that, because the call comes from within.
function checkUrl(raw: string): string | null {
  const trimmed = raw.trim()

  // Before parsing: a 4000-character string can still be a valid URL, and the
  // contract's limit is on the characters, not on what they parse to.
  if (trimmed.length > URL_MAX) return `The URL can be at most ${URL_MAX} characters`

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return 'Enter a full URL, for example https://example.com/hooks/relay'
  }

  if (parsed.protocol !== 'https:') return 'The URL must start with https://'

  const host = parsed.hostname
  if (PRIVATE_ADDRESS.test(host) || INTERNAL_NAME.test(host)) {
    return 'The URL must not point at a private or internal address'
  }

  // Only host names have to look like names. A public IP literal is a legitimate
  // endpoint, and an IPv6 one has no dots at all — [2001:db8::1] used to be refused
  // by the dot rule below.
  const isLiteral = (host.startsWith('[') && host.endsWith(']')) || IPV4_LITERAL.test(host)
  if (!isLiteral && (!host.includes('.') || host.endsWith('.'))) {
    return 'That host name does not look reachable'
  }

  return null
}

// A 422 names the fields that failed (docs/api.md). Join them into the form's one message
// line rather than adding paragraphs, so there is a single place a reader looks for why.
function describe(failure: ApiFailure): string {
  if (!failure.details.length) return failure.message
  return failure.details.map((d) => `${d.path}: ${d.message}`).join('; ')
}

export default function Endpoints() {
  // null means "still asking"; an empty array means this owner has no endpoints.
  const [rows, setRows] = useState<Endpoint[] | null>(null)
  const [loadFailure, setLoadFailure] = useState<ApiFailure | null>(null)
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  // The signing secret comes back once, in the answer to POST /v1/endpoints, and
  // is never returned again. Holding it here is what lets the screen show it; it
  // disappears for good as soon as this state is cleared.
  const [secret, setSecret] = useState<EndpointCreated | null>(null)

  useEffect(() => {
    let ignore = false

    listEndpoints()
      .then((found) => {
        if (!ignore) setRows(found)
      })
      .catch((failure: unknown) => {
        if (!ignore) setLoadFailure(failure as ApiFailure)
      })

    return () => {
      ignore = true
    }
  }, [])

  async function add(e: FormEvent) {
    e.preventDefault()

    // These two checks are the form being helpful, not the rules being enforced: the API
    // checks the same things and is the authority. They buy a message on the right field
    // instead of a bare 422, and one less round trip.
    const trimmedName = name.trim()
    if (!trimmedName) return setError('Give the endpoint a name.')
    if (trimmedName.length > NAME_MAX) {
      return setError(`The name can be at most ${NAME_MAX} characters`)
    }

    const urlError = checkUrl(url)
    if (urlError) return setError(urlError)

    setError(null)
    setSaving(true)

    try {
      // The answer carries the signing secret, and nothing else ever will.
      const created = await createEndpoint({ name: trimmedName, url: url.trim() })

      // The endpoint exists from here on, so the refresh gets its own try. Letting a failed
      // list read fall into the catch below would put "create failed" under the form while
      // the secret is still on screen, and the obvious response to that is to add the
      // endpoint a second time.
      setSecret(created)
      setName('')
      setUrl('')
      try {
        // Read the list back rather than appending, so what is on screen is what the API
        // would send on the next visit, including the status it worked out.
        setRows(await listEndpoints())
      } catch {
        // Show the row we were just given. Without its secret: the list the API returns
        // never carries one, and nothing should keep a copy longer than the box that shows it.
        // The underscore says the secret is being dropped on purpose, not forgotten.
        const { signing_secret: _dropped, ...row } = created
        setRows((current) => [...(current ?? []), row])
      }
    } catch (failure: unknown) {
      setError(describe(failure as ApiFailure))
    } finally {
      setSaving(false)
    }
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
            {(rows ?? []).map((e) => (
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

        {/* Outside the table: a "loading" row inside tbody would be counted as an endpoint. */}
        {rows === null && !loadFailure && (
          <p className="px-4 py-8 text-center text-sm text-[var(--ink-dim)]">Loading…</p>
        )}

        {loadFailure && (
          <p className="px-4 py-8 text-center text-sm text-[var(--bad)]">{loadFailure.message}</p>
        )}

        {rows?.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-[var(--ink-dim)]">
            No endpoints yet. Add one below.
          </p>
        )}
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
            disabled={saving}
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
            disabled={saving}
            className={field}
          />
        </label>

        {error && <p className="text-sm text-[var(--bad)]">{error}</p>}

        <button
          type="submit"
          disabled={saving}
          className="self-start rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          Add endpoint
        </button>
      </form>
    </div>
  )
}
