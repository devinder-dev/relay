// Fake API responses for building the dashboard before the API exists.
//
// Shapes come from docs/api.md. Values are shaped like the real thing: UUIDv7 ids,
// ISO 8601 timestamps in UTC, example.com URLs and an obviously fake signing secret.
//
// The timelines add up. Each wait starts when the previous try ended, following the
// retry schedule in docs/CONTEXT.md: 5 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h.

import type {
  ApiError,
  Delivery,
  DeliveryDetail,
  Endpoint,
  EndpointCreated,
  Me,
  Page,
} from './types';

// GET /v1/me

export const me: Me = {
  owner: { id: '0199c4f8-7e3a-7c21-9f4e-2b1d8a6c0f55', name: 'Acme AB' },
  key: { prefix: 'relay_live_8f2k' },
};

// GET /v1/endpoints
//
// `status` is derived from each endpoint's latest delivery, so it matches the
// deliveries below: Slack's latest went through, n8n's is pending after a failed try.

const slack = {
  id: '0199c4f8-8a01-7d33-b2c7-5e9f1a4d7b20',
  name: 'Slack alerts',
  url: 'https://example.com/hooks/slack',
};

const n8n = {
  id: '0199c4f9-1c44-7a08-8e51-7f2a9b3c6d14',
  name: 'n8n order flow',
  url: 'https://example.com/webhook/orders',
};

const billing = {
  id: '0199c4f9-5d77-7e19-a3b6-9c1e4f8a2d03',
  name: 'Legacy billing',
  url: 'https://example.com/hooks/billing',
};

export const endpoints: { data: Endpoint[] } = {
  data: [
    {
      ...slack,
      event_types: ['payment.completed', 'payment.failed', 'invoice.paid'],
      status: 'active',
      created_at: '2026-10-20T09:12:04.000Z',
    },
    {
      ...n8n,
      event_types: ['*'],
      status: 'failing',
      created_at: '2026-10-21T14:38:51.000Z',
    },
    {
      ...billing,
      event_types: ['invoice.paid'],
      status: 'disabled',
      created_at: '2026-10-19T11:02:17.000Z',
    },
  ],
};

// POST /v1/endpoints — the one answer that carries the signing secret.

export const endpointCreated: EndpointCreated = {
  id: '0199c51f-2b90-7c55-9d18-4a7e3f1b8c62',
  name: 'Ops webhook',
  url: 'https://example.com/hooks/ops',
  event_types: ['*'],
  status: 'active',
  created_at: '2026-10-25T15:44:02.000Z',
  signing_secret: 'whsec_MOCK_not_a_real_secret',
};

// GET /v1/deliveries

/**
 * Mid-retry: three tries used, the fourth is due in five minutes.
 * This is the row the detail screen polls every 2 seconds.
 */
const pendingDelivery: Delivery = {
  id: '0199c5b2-3a41-7d66-b107-2e8f4a1c9d35',
  status: 'pending',
  attempts: 3,
  next_attempt_at: '2026-10-25T15:34:15.350Z',
  last_status_code: 503,
  last_error: null,
  delivered_at: null,
  created_at: '2026-10-25T15:28:00.000Z',
  event: { id: '0199c5b2-2f18-7c09-9e73-5a1b8d3f6e21', type: 'payment.completed' },
  endpoint: { id: n8n.id, name: n8n.name },
};

/** Went through on the first try. The common case. */
const deliveredDelivery: Delivery = {
  id: '0199c5a7-6e23-7a90-8c14-3f7b2d9e5a68',
  status: 'delivered',
  attempts: 1,
  next_attempt_at: null,
  last_status_code: 200,
  last_error: null,
  delivered_at: '2026-10-25T15:10:00.095Z',
  created_at: '2026-10-25T15:10:00.000Z',
  event: { id: '0199c5a7-6d11-7b82-a05f-8e2c1a4d7f39', type: 'invoice.paid' },
  endpoint: { id: slack.id, name: slack.name },
};

/** Timed out, then went through five seconds later. `attempts > 1` can still end well. */
const recoveredDelivery: Delivery = {
  id: '0199c59c-4b17-7f28-9a36-1d8e5c2b7a44',
  status: 'delivered',
  attempts: 2,
  next_attempt_at: null,
  last_status_code: 200,
  last_error: null,
  delivered_at: '2026-10-25T14:45:15.120Z',
  created_at: '2026-10-25T14:45:00.000Z',
  event: { id: '0199c59c-3a05-7e14-b821-6f4a9d1c3e57', type: 'payment.completed' },
  endpoint: { id: n8n.id, name: n8n.name },
};

/** Gave up after eight tries. The only row where Replay does anything. */
const deadDelivery: Delivery = {
  id: '0199c51a-1f88-7b44-9c02-6d3e8f1a2b77',
  status: 'dead',
  attempts: 8,
  next_attempt_at: null,
  last_status_code: 500,
  last_error: null,
  delivered_at: null,
  created_at: '2026-10-24T18:00:00.000Z',
  event: { id: '0199c51a-1e02-7f31-8a45-1b9d2c7e4f08', type: 'payment.failed' },
  endpoint: { id: slack.id, name: slack.name },
};

/** Newest first, by `created_at`. */
export const deliveries: Page<Delivery> = {
  data: [pendingDelivery, deliveredDelivery, recoveredDelivery, deadDelivery],
  next_cursor: null,
};

// GET /v1/deliveries/:id

/**
 * The dead delivery with its payload and all eight tries.
 *
 * Every gap follows the schedule, measured from the end of the previous try:
 * 5 s, 1 min, 5 min, 30 min, 2 h, 6 h, 12 h. Tries that got no HTTP answer carry
 * an `error` and no `status_code`; tries the receiver answered carry the opposite.
 */
export const deliveryDetail: DeliveryDetail = {
  ...deadDelivery,
  event: {
    id: deadDelivery.event.id,
    type: 'payment.failed',
    payload: {
      order_id: 'A-1042',
      customer_id: 'cus_8Hq2Lm',
      amount: 249.0,
      currency: 'SEK',
      reason: 'card_declined',
    },
    created_at: '2026-10-24T18:00:00.000Z',
  },
  endpoint: slack,
  attempt_log: [
    {
      id: '0199c51a-2001-7a11-8b03-4c7d9e2f1a60',
      number: 1,
      started_at: '2026-10-24T18:00:00.000Z',
      duration_ms: 10000,
      status_code: null,
      error: 'timeout',
      response_excerpt: null,
    },
    {
      id: '0199c51a-2002-7b22-9c14-5d8e0f3a2b71',
      number: 2,
      started_at: '2026-10-24T18:00:15.000Z',
      duration_ms: 180,
      status_code: 500,
      error: null,
      response_excerpt: '{"ok":false,"error":"internal"}',
    },
    {
      id: '0199c51a-2003-7c33-a025-6e9f1a4b3c82',
      number: 3,
      started_at: '2026-10-24T18:01:15.180Z',
      duration_ms: 165,
      status_code: 500,
      error: null,
      response_excerpt: '{"ok":false,"error":"internal"}',
    },
    {
      id: '0199c51a-2004-7d44-b136-7f0a2b5c4d93',
      number: 4,
      started_at: '2026-10-24T18:06:15.345Z',
      duration_ms: 10000,
      status_code: null,
      error: 'timeout',
      response_excerpt: null,
    },
    {
      id: '0199c51a-2005-7e55-8247-801b3c6d5ea4',
      number: 5,
      started_at: '2026-10-24T18:36:25.345Z',
      duration_ms: 142,
      status_code: 502,
      error: null,
      response_excerpt: '<html><head><title>502 Bad Gateway</title>',
    },
    {
      id: '0199c51a-2006-7f66-9358-912c4d7e6fb5',
      number: 6,
      started_at: '2026-10-24T20:36:25.487Z',
      duration_ms: 1,
      status_code: null,
      error: 'connect_failed',
      response_excerpt: null,
    },
    {
      id: '0199c51a-2007-7a77-a469-a23d5e8f70c6',
      number: 7,
      started_at: '2026-10-25T02:36:25.488Z',
      duration_ms: 210,
      status_code: 500,
      error: null,
      response_excerpt: '{"ok":false,"error":"internal"}',
    },
    {
      id: '0199c51a-2008-7b88-b57a-b34e6f9a81d7',
      number: 8,
      started_at: '2026-10-25T14:36:25.698Z',
      duration_ms: 155,
      status_code: 500,
      error: null,
      response_excerpt: '{"ok":false,"error":"internal"}',
    },
  ],
};

/**
 * The pending delivery, three tries in. This is the one the detail screen reloads
 * every 2 seconds, so it is the fixture for the live-retry part of the demo.
 *
 * Try 3 ends at 15:29:15.350; the fourth wait is 5 min, which is where
 * `next_attempt_at` comes from.
 */
export const pendingDeliveryDetail: DeliveryDetail = {
  ...pendingDelivery,
  event: {
    id: pendingDelivery.event.id,
    type: 'payment.completed',
    payload: {
      order_id: 'A-1119',
      customer_id: 'cus_4Rt7Yp',
      amount: 1290.0,
      currency: 'SEK',
    },
    created_at: '2026-10-25T15:28:00.000Z',
  },
  endpoint: n8n,
  attempt_log: [
    {
      id: '0199c5b2-3001-7c11-8a02-2b4d6e8f0a13',
      number: 1,
      started_at: '2026-10-25T15:28:00.000Z',
      duration_ms: 10000,
      status_code: null,
      error: 'timeout',
      response_excerpt: null,
    },
    {
      id: '0199c5b2-3002-7d22-9b13-3c5e7f9a1b24',
      number: 2,
      started_at: '2026-10-25T15:28:15.000Z',
      duration_ms: 200,
      status_code: 503,
      error: null,
      response_excerpt: '{"error":"service unavailable"}',
    },
    {
      id: '0199c5b2-3003-7e33-ac24-4d6f8a0b2c35',
      number: 3,
      started_at: '2026-10-25T15:29:15.200Z',
      duration_ms: 150,
      status_code: 503,
      error: null,
      response_excerpt: '{"error":"service unavailable"}',
    },
  ],
};

// Errors
//
// Every failing request answers with this shape. These three are the ones the
// dashboard has to render: a bad key on Connect, and the two ways Replay can be
// refused.

export const errorUnauthorized: ApiError = {
  error: {
    code: 'unauthorized',
    message: 'Unknown or revoked API key',
    request_id: '0199c5b5-7a12-7f40-9c33-1e2d4a6b8c05',
  },
};

export const errorAlreadyDelivered: ApiError = {
  error: {
    code: 'already_delivered',
    message: 'Delivery has already been delivered',
    request_id: '0199c5b5-8b23-7a51-ad44-2f3e5b7c9d16',
  },
};

export const errorInFlight: ApiError = {
  error: {
    code: 'in_flight',
    message: 'A worker is sending this delivery right now',
    request_id: '0199c5b5-9c34-7b62-be55-3a4f6c8d0e27',
  },
};

// POST /v1/deliveries/:id/replay
//
// Replay starts a new cycle: `attempts` goes back to 0, so the delivery gets the
// full retry budget again. `attempt_log` keeps its eight rows, and the next try
// becomes number 9.

export const replayResponse: Delivery = {
  ...deadDelivery,
  status: 'pending',
  attempts: 0,
  next_attempt_at: '2026-10-25T15:45:00.000Z',
  last_error: null,
};
