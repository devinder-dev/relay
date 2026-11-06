// What the dashboard does when the API says no.
//
// A plain function with no imports: it takes the status and the body, and returns what the
// screens should do about it. That keeps it testable without a browser or a network, and it
// keeps the decision in one place instead of spread across four screens.
//
// Relay's error body is always the same shape (docs/api.md):
//   { "error": { "code": "...", "message": "...", "request_id": "..." } }
// but we cannot count on it. Traefik and nginx sit in front of the API and answer with HTML,
// and a dropped connection has no body at all.

export type ApiFailure = {
  /** Relay's `code` when there is one, otherwise one of ours. For logs, not for users. */
  code: string
  /** Safe to put on screen. Relay's messages are written for people; ours must be too. */
  message: string
  /** Relay's `request_id`, to quote when asking why something failed. */
  requestId: string | null
  /** true = forget the stored key and send the user back to the Connect screen. */
  signOut: boolean
  /**
   * 422 only: one entry per field that failed, so a form can put each message next to its
   * own input instead of in one lump (docs/api.md). Empty for every other failure, so
   * callers can map over it without checking first.
   */
  details: { path: string; message: string }[]
}

// Only entries that are actually {path, message} strings reach a form. A half-built entry
// would render as "undefined" next to an input, which is worse than saying nothing.
function toDetails(raw: unknown): { path: string; message: string }[] {
  if (!Array.isArray(raw)) return []
  const kept = raw.filter(
    (entry): entry is { path: string; message: string } =>
      typeof (entry as { path?: unknown })?.path === 'string' &&
      typeof (entry as { message?: unknown })?.message === 'string',
  )
  return kept.length === raw.length ? kept.map((e) => ({ path: e.path, message: e.message })) : []
}

export function toFailure(input: { status: number | null; body: unknown }): ApiFailure {
  // Read the three fields one at a time, checking each really is a string. A body that
  // isn't our shape - HTML from Traefik, a bare string, nothing at all - leaves all three
  // null, and the defaults below take over. Nothing here can throw on a strange body.
  const body = input.body as
    | { error?: { code?: unknown; message?: unknown; request_id?: unknown; details?: unknown } }
    | null
  const code = typeof body?.error?.code === 'string' ? body.error.code : null
  const message = typeof body?.error?.message === 'string' ? body.error.message : null
  const requestId = typeof body?.error?.request_id === 'string' ? body.error.request_id : null

  // No status at all means the request never got an answer: offline, DNS, a dropped
  // connection. There is no body to read, and signing in again would not help.
  if (input.status === null) {
    return {
      code: 'no_response',
      message: 'Could not reach Relay. Check your connection and try again.',
      requestId: null,
      signOut: false,
      details: [],
    }
  }

  // Only 401 means the key itself was refused. A 503 is the API being unwell, and a 500 is
  // a bug of ours; in both cases the key is still good, so making the user paste it again
  // would lose their place for nothing.
  return {
    code: code ?? 'unexpected_error',
    message: message ?? `Relay answered ${input.status}. Please try again.`,
    requestId,
    signOut: input.status === 401,
    details: toDetails(body?.error?.details),
  }
}
