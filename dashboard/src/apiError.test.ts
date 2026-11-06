// What the dashboard does when the API says no. One case per kind of failure.
//
// toFailure takes a plain shape, not an axios error, so these tests need no network
// and no browser: `status` is the HTTP code (null when there was no answer at all),
// and `body` is whatever came back, which is not always the JSON we hoped for.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toFailure } from './apiError.ts'

// The error shape every Relay endpoint uses, from docs/api.md.
const apiError = (code: string, message: string, request_id: string | null = 'req_7') => ({
  error: request_id === null ? { code, message } : { code, message, request_id },
})

test('a rejected key signs the user out', () => {
  const f = toFailure({ status: 401, body: apiError('unauthorized', 'A valid API key is required') })
  assert.equal(f.signOut, true)
  assert.equal(f.code, 'unauthorized')
  assert.equal(f.message, 'A valid API key is required')
  assert.equal(f.requestId, 'req_7')
})

test('a missing delivery does not sign the user out', () => {
  const f = toFailure({ status: 404, body: apiError('not_found', 'Delivery not found') })
  assert.equal(f.signOut, false)
  assert.equal(f.code, 'not_found')
  assert.equal(f.message, 'Delivery not found')
})

test('a conflict keeps the API message, so the screen can explain itself', () => {
  const sent = 'This delivery is being sent right now, try again in a moment'
  const f = toFailure({ status: 409, body: apiError('in_flight', sent) })
  assert.equal(f.code, 'in_flight')
  assert.equal(f.message, sent)
  assert.equal(f.signOut, false)
})

test('a sick server does not throw the user out: the key is still good', () => {
  const f = toFailure({ status: 503, body: apiError('service_unavailable', 'Relay is temporarily unavailable') })
  assert.equal(f.signOut, false)
})

// Traefik and nginx answer with HTML, not our JSON, so the body cannot be trusted.
test('an error with no JSON body still gives the user something to read', () => {
  const f = toFailure({ status: 500, body: '<html>502 Bad Gateway</html>' })
  assert.equal(f.signOut, false)
  assert.equal(f.requestId, null)
  assert.ok(f.message.length > 0, 'needs a message a person can read')
  assert.ok(f.code.length > 0, 'needs some code to log')
})

test('no answer at all is reported as its own kind of failure', () => {
  const f = toFailure({ status: null, body: undefined })
  assert.equal(f.signOut, false)
  assert.equal(f.requestId, null)
  assert.ok(f.message.length > 0)
})

test('a body without request_id gives null, never undefined', () => {
  const f = toFailure({ status: 404, body: apiError('not_found', 'Delivery not found', null) })
  assert.equal(f.requestId, null)
})

// Anything can arrive over a network. None of it may crash a screen.
test('a malformed body never throws', () => {
  for (const body of [null, undefined, 'text', 42, [], {}, { error: null }, { error: {} }, { error: { code: 5 } }]) {
    const f = toFailure({ status: 500, body })
    assert.ok(f.message.length > 0, `no message for ${JSON.stringify(body)}`)
    assert.equal(f.requestId, null)
  }
})
