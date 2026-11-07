// A stand-in for the API, inside the browser.
//
// The screens call the real axios client in src/api.ts; Playwright catches the request before
// it leaves the page and answers from the fixtures in src/mocks.ts. So the tests exercise the
// code we ship - URLs, headers, error handling, loading states - without needing a server, a
// database or a worker, and the row counts stay fixed so assertions can be exact.
//
// The messages below are the API's OWN wording, taken from api/src/errors.ts and the services.
// The fixtures in src/mocks.ts guessed at them, which is why a test once expected "Unknown or
// revoked API key" for an answer the API writes as "A valid API key is required". Screens must
// decide on `code` (the contract) and only ever display `message`.
import type { Page, Route } from '@playwright/test'
import {
  deliveredDeliveryDetail,
  deliveries,
  deliveryDetail,
  endpointCreated,
  endpointDeletedDetail,
  endpoints,
  me,
  pendingDeliveryDetail,
  recoveredDeliveryDetail,
  replayResponse,
} from '../src/mocks'
import type { Delivery, DeliveryDetail, Endpoint } from '../src/types'

const DETAILS = [
  pendingDeliveryDetail,
  deliveryDetail,
  deliveredDeliveryDetail,
  recoveredDeliveryDetail,
  endpointDeletedDetail,
]

const MAX_ENDPOINTS = 20

// A log row is a delivery without its history and with the short event and endpoint objects.
// Written out rather than spread, so adding a field to DeliveryDetail cannot leak the payload
// into the list by accident.
function toRow(d: DeliveryDetail): Delivery {
  return {
    id: d.id,
    status: d.status,
    attempts: d.attempts,
    next_attempt_at: d.next_attempt_at,
    last_status_code: d.last_status_code,
    last_error: d.last_error,
    delivered_at: d.delivered_at,
    created_at: d.created_at,
    event: { id: d.event.id, type: d.event.type },
    endpoint: { id: d.endpoint.id, name: d.endpoint.name },
  }
}

export async function installApiMock(page: Page) {
  // Fresh state per test: a replay or an added endpoint in one test must not be visible in
  // the next. In the browser a reload did this for free; here it has to be deliberate.
  const details = new Map(DETAILS.map((d) => [d.id, structuredClone(d)]))
  const endpointRows: Endpoint[] = structuredClone(endpoints.data)

  const send = (route: Route, status: number, body: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'x-request-id': crypto.randomUUID() },
      body: JSON.stringify(body),
    })

  const fail = (route: Route, status: number, code: string, message: string, extra?: object) =>
    send(route, status, { error: { code, message, request_id: crypto.randomUUID(), ...extra } })

  await page.route('**/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^\/v1/, '')
    const method = request.method()

    // The API answers every unauthenticated request the same way, whatever was asked for.
    const auth = request.headers()['authorization'] ?? ''
    if (!auth.startsWith('Bearer relay_live_')) {
      return fail(route, 401, 'unauthorized', 'A valid API key is required')
    }

    if (method === 'GET' && path === '/me') return send(route, 200, me)

    if (method === 'GET' && path === '/deliveries') {
      // The API filters, not the browser: ?status= is part of the contract.
      const status = url.searchParams.get('status')
      const data = [...details.values()]
        .map(toRow)
        .filter((d) => !status || d.status === status)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
      return send(route, 200, { data, next_cursor: deliveries.next_cursor })
    }

    const detailMatch = /^\/deliveries\/([^/]+)$/.exec(path)
    if (method === 'GET' && detailMatch) {
      const found = details.get(detailMatch[1]!)
      return found ? send(route, 200, found) : fail(route, 404, 'not_found', 'Delivery not found')
    }

    const replayMatch = /^\/deliveries\/([^/]+)\/replay$/.exec(path)
    if (method === 'POST' && replayMatch) {
      const current = details.get(replayMatch[1]!)
      if (!current) return fail(route, 404, 'not_found', 'Delivery not found')
      // The contract's order when more than one applies: delivered, then deleted, then in flight.
      if (current.status === 'delivered') {
        return fail(route, 409, 'already_delivered', 'This delivery was already delivered')
      }
      if (current.last_error === 'endpoint_deleted') {
        return fail(route, 409, 'endpoint_deleted', "This delivery's endpoint was deleted")
      }
      // 202 answers with a Delivery, not a DeliveryDetail: only these four fields change.
      const next: DeliveryDetail = {
        ...current,
        status: replayResponse.status,
        attempts: replayResponse.attempts,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
      }
      details.set(next.id, next)
      return send(route, 202, toRow(next))
    }

    if (method === 'GET' && path === '/endpoints') return send(route, 200, { data: endpointRows })

    if (method === 'POST' && path === '/endpoints') {
      const body = request.postDataJSON() as { name?: unknown; url?: unknown }
      const problems: { path: string; message: string }[] = []
      if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 100) {
        problems.push({ path: 'name', message: 'Too big: expected string to have <=100 characters' })
      }
      if (typeof body.url !== 'string' || body.url.length > 2048) {
        problems.push({ path: 'url', message: 'Too big: expected string to have <=2048 characters' })
      }
      if (problems.length) {
        return fail(route, 422, 'validation_failed', 'Request validation failed', { details: problems })
      }
      if (!String(body.url).startsWith('https://')) {
        return fail(route, 422, 'invalid_endpoint_url', 'Endpoint URL must use https')
      }
      if (endpointRows.length >= MAX_ENDPOINTS) {
        return fail(route, 409, 'endpoint_limit_reached', 'An owner can have at most 20 endpoints')
      }
      // The stored row carries no secret: the list the API returns never has one.
      const { signing_secret, ...template } = endpointCreated
      const row: Endpoint = {
        ...template,
        id: crypto.randomUUID(),
        name: String(body.name),
        url: String(body.url),
      }
      endpointRows.push(row)
      return send(route, 201, { ...row, signing_secret })
    }

    return fail(route, 404, 'not_found', 'Not found')
  })
}
