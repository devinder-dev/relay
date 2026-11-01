import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { errorUnauthorized, me } from '../mocks'
import type { Me } from '../types'

// Stands in for GET /v1/me until the API exists. The real check is the same:
// send the key, and let the API say whether it knows it.
function check(key: string): Me | null {
  return key.startsWith('relay_live_') ? me : null
}

export default function Connect() {
  const navigate = useNavigate()
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)

  function connect(e: FormEvent) {
    e.preventDefault()

    const owner = check(key.trim())
    if (!owner) return setError(errorUnauthorized.error.message)

    // The key stays in sessionStorage, not localStorage: it is gone when the tab
    // closes, so a shared machine does not keep someone signed in.
    sessionStorage.setItem('relay_key', key.trim())
    navigate('/deliveries')
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-5 pt-12">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-medium">Connect to Relay</h1>
        <p className="text-sm text-[var(--ink-dim)]">
          Paste the API key for your account. It is the same key your apps use to send
          events.
        </p>
      </div>

      <form
        onSubmit={connect}
        className="flex flex-col gap-3 rounded-md border border-[var(--line-soft)] bg-[var(--card)] p-4"
      >
        <label htmlFor="key" className="flex flex-col gap-1 text-xs text-[var(--ink-dim)]">
          API key
          <input
            id="key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="relay_live_..."
            autoComplete="off"
            className="mono w-full rounded-md border border-[var(--line-soft)] bg-[var(--paper)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>

        {error && <p className="text-sm text-[var(--bad)]">{error}</p>}

        <button
          type="submit"
          className="rounded-md bg-[var(--accent)] px-3 py-2 text-sm font-medium text-white hover:opacity-90"
        >
          Connect
        </button>
      </form>

      <p className="text-xs text-[var(--ink-faint)]">
        The key is kept for this tab only and is forgotten when you close it.
      </p>
    </div>
  )
}
