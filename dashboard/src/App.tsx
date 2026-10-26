import { NavLink, Route, Routes } from 'react-router'
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

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b border-[var(--line-soft)] bg-[var(--card)]">
        <div className="mx-auto flex max-w-5xl items-center gap-8 px-6 pt-4">
          <NavLink to="/" className="mono pb-3 text-sm font-medium">
            Relay
          </NavLink>
          <nav className="flex gap-6">
            <NavLink to="/deliveries" className={linkClass}>
              Delivery log
            </NavLink>
            <NavLink to="/endpoints" className={linkClass}>
              Endpoints
            </NavLink>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Connect />} />
          <Route path="/deliveries" element={<DeliveryLog />} />
          <Route path="/deliveries/:id" element={<DeliveryDetail />} />
          <Route path="/endpoints" element={<Endpoints />} />
        </Routes>
      </main>
    </div>
  )
}
