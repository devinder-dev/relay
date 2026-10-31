// Response types for Relay API v1.
//
// Copied from docs/api.md, which is the single source of truth for what the API
// accepts and returns. Changing a shape here without changing it there makes the
// dashboard lie about the API: change docs/api.md first, in its own PR.

export type DeliveryStatus = 'pending' | 'delivered' | 'dead';
export type EndpointStatus = 'active' | 'failing';
export type AttemptError =
  | 'timeout'
  | 'connect_failed'
  | 'blocked_address'
  | 'redirect'
  | 'tls';
// A delivery can also end for a reason no single try caused: its endpoint was
// deleted while it was still pending.
export type DeliveryError = AttemptError | 'endpoint_deleted';

export interface Owner {
  id: string;
  name: string;
}

// GET /v1/me
export interface Me {
  owner: Owner;
  key: { prefix: string }; // e.g. "relay_live_8f2k", safe to show
}

export interface Endpoint {
  id: string;
  name: string;
  url: string;
  event_types: string[]; // ["*"] means every event type
  status: EndpointStatus; // worked out when read: failing if the latest delivery is
  // dead, or pending after a failed try; otherwise active. Deleted ones aren't listed.
  created_at: string;
}

// Only in the answer to POST /v1/endpoints: the secret is shown once, never again.
export interface EndpointCreated extends Endpoint {
  signing_secret: string; // "whsec_…"
}

// One row in GET /v1/deliveries
export interface Delivery {
  id: string;
  status: DeliveryStatus;
  attempts: number; // tries in the current cycle (the retry budget); replay resets it to 0
  next_attempt_at: string | null; // when the next try is due; null unless status is "pending"
  last_status_code: number | null; // HTTP status of the last try; null if the receiver never answered
  last_error: DeliveryError | null; // why the last try failed without a status code; null otherwise
  delivered_at: string | null; // set only when status is "delivered"
  created_at: string;
  event: { id: string; type: string };
  endpoint: { id: string; name: string };
}

// One try at a delivery
export interface Attempt {
  id: string;
  number: number; // 1, 2, 3 … across the whole history, including after replays
  started_at: string;
  duration_ms: number;
  status_code: number | null; // null = no HTTP answer (see error)
  error: AttemptError | null; // null when the receiver answered (even with 500)
  response_excerpt: string | null; // first 1 KB of the receiver's answer
}

// GET /v1/deliveries/:id
export interface DeliveryDetail extends Omit<Delivery, 'event' | 'endpoint'> {
  event: {
    id: string;
    type: string;
    payload: Record<string, unknown>;
    created_at: string;
  };
  endpoint: { id: string; name: string; url: string };
  attempt_log: Attempt[]; // the full history, oldest first, never deleted
}

// POST /v1/events
export interface EventAccepted {
  id: string;
  type: string;
  created_at: string;
  deliveries: number; // how many endpoints will receive it
}

export interface Page<T> {
  data: T[];
  next_cursor: string | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    request_id: string;
    details?: { path: string; message: string }[];
  };
}
