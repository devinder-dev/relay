import type { DeliveryStatus, EndpointStatus } from '../types'

// One colour per state, from the wireframe palette: green for the happy path,
// amber for work still in progress, red for something that needs a person.
const colours: Record<DeliveryStatus | EndpointStatus, string> = {
  delivered: 'bg-[var(--ok-bg)] text-[var(--ok)]',
  active: 'bg-[var(--ok-bg)] text-[var(--ok)]',
  pending: 'bg-[var(--warn-bg)] text-[var(--warn)]',
  failing: 'bg-[var(--warn-bg)] text-[var(--warn)]',
  dead: 'bg-[var(--bad-bg)] text-[var(--bad)]',
}

export default function StatusPill({ status }: { status: DeliveryStatus | EndpointStatus }) {
  return (
    <span className={`mono rounded-full px-2 py-0.5 text-xs ${colours[status]}`}>
      {status}
    </span>
  )
}
