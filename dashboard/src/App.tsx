import { NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router'
import { me } from './mocks'
import Connect from './pages/Connect'
import DeliveryDetail from './pages/DeliveryDetail'
import DeliveryLog from './pages/DeliveryLog'
import Endpoints from './pages/Endpoints'

const linkClass = ({ isActive }: { isActive: boolean }) =>
  [
    'pb-3 text-sm border-b-2 -mb-px transition-colors',
    isActive
      ? 'border-[var(--accent)] text-[var(--ink)] font-medium'
      : 'border-transparent text-[var(--ink-dim)] hover:text-[var(--ink)]',
  ].join(' ')

// Every screen except Connect needs a key. Without this the log renders fine on
// mock data but will be an empty page full of 401s once it calls the real API.
function RequireKey({ children }: { children: React.ReactNode }) {
  if (!sessionStorage.getItem('relay_key')) return <Navigate to="/" replace />
  return <>{children}</>
}

export default function App() {
  const navigate = useNavigate()

  // Re-read the key on every navigation rather than keeping a copy in state. Connect
  // and Disconnect both navigate, so useLocation is what makes the header update;
  // depending on that is why this is written as a read rather than a useState.
  useLocation()
  const connected = Boolean(sessionStorage.getItem('relay_key'))

  function disconnect() {
    sessionStorage.removeItem('relay_key')
    navigate('/')
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line-soft)] bg-[var(--card)]">
        <div className="mx-auto flex max-w-5xl items-center gap-8 px-6 pt-4">
          <NavLink to="/" className="mono pb-3 text-sm font-medium">
            Relay
          </NavLink>

          {connected && (
            <>
              <nav className="flex gap-6">
                <NavLink to="/deliveries" className={linkClass}>
                  Delivery log
                </NavLink>
                <NavLink to="/endpoints" className={linkClass}>
                  Endpoints
                </NavLink>
              </nav>

              <div className="ml-auto flex items-center gap-3 pb-3">
                {/* The prefix comes from GET /v1/me, not from what was typed: the API
                    is what knows which key this is. Only the prefix is ever shown. */}
                <span className="mono text-xs text-[var(--ink-faint)]">
                  {me.key.prefix}
                </span>
                <button
                  onClick={disconnect}
                  className="text-xs text-[var(--ink-dim)] hover:text-[var(--ink)]"
                >
                  Disconnect
                </button>
              </div>
            </>
          )}
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Connect />} />
          <Route
            path="/deliveries"
            element={
              <RequireKey>
                <DeliveryLog />
              </RequireKey>
            }
          />
          <Route
            path="/deliveries/:id"
            element={
              <RequireKey>
                <DeliveryDetail />
              </RequireKey>
            }
          />
          <Route
            path="/endpoints"
            element={
              <RequireKey>
                <Endpoints />
              </RequireKey>
            }
          />

          {/* nginx hands every unknown path to index.html, so the app owns 404s.
              Without this, a typo in the URL renders a header above nothing. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  )
}
