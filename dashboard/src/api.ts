// The one place the dashboard talks to the API (decision 0002).
//
// Every screen calls a function from this file and gets back exactly the shape in
// docs/api.md. Nothing else in the app knows about axios, headers or URLs, so the
// contract lives in one file instead of in four screens.
//
// Failures all arrive the same way: the response interceptor turns anything that went
// wrong into an ApiFailure (see apiError.ts) and rejects with it. So a screen can do
//   catch (error) { setError(error as ApiFailure) }
// and never has to look at a status code itself.
import axios from 'axios'
import { toFailure, type ApiFailure } from './apiError'
import type {
  Delivery,
  DeliveryDetail,
  DeliveryStatus,
  Endpoint,
  EndpointCreated,
  Me,
  Page,
} from './types'

export type { ApiFailure }

// In development the browser calls /v1 on the Vite server, which forwards it (see
// vite.config.ts): same origin, so CORS never applies and there is nothing to configure.
// In production the dashboard is served from cdn.myrelay.tech and calls api.myrelay.tech
// directly, which docs/api.md already allows.
//
// Not a build-time variable: that would need a Docker build argument and a pipeline change
// for a value that has exactly one production setting and never varies.
const baseURL = import.meta.env.DEV ? '/v1' : 'https://api.myrelay.tech/v1'

const client = axios.create({
  baseURL,
  // The API's own deadline for a delivery is 10 s; a read should never take longer.
  timeout: 10_000,
})

// Step 1: send the stored key, unless the caller passed its own (checkKey does, because at
// that moment the key is not stored yet and may turn out to be wrong).
client.interceptors.request.use((config) => {
  const key = sessionStorage.getItem('relay_key')
  if (key && !config.headers.Authorization) config.headers.Authorization = `Bearer ${key}`
  return config
})

// Step 2: one place decides what a failure means, and a refused key is forgotten here
// rather than in each screen. RequireKey in App.tsx then sends the user to Connect.
client.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    const response = axios.isAxiosError(error) ? error.response : undefined
    const failure = toFailure({ status: response?.status ?? null, body: response?.data })
    if (failure.signOut) sessionStorage.removeItem('relay_key')
    return Promise.reject(failure)
  },
)

/** `GET /v1/me`. Used by Connect to check a key before storing it, so the key is passed in. */
export const checkKey = (key: string) =>
  client.get<Me>('/me', { headers: { Authorization: `Bearer ${key}` } }).then((r) => r.data)

/** `GET /v1/deliveries`. The API filters and pages; the browser does neither. */
export const listDeliveries = (query: { status?: DeliveryStatus; endpoint_id?: string; cursor?: string } = {}) =>
  client.get<Page<Delivery>>('/deliveries', { params: query }).then((r) => r.data)

/** `GET /v1/deliveries/:id`, including the full attempt history. */
export const getDelivery = (id: string) =>
  client.get<DeliveryDetail>(`/deliveries/${id}`).then((r) => r.data)

/**
 * `POST /v1/deliveries/:id/replay`. Answers 202 with the delivery as it is after the replay.
 *
 * The empty object is deliberate: the contract takes no body, and an empty body sent with a
 * JSON content type makes Fastify answer 400 instead of 202.
 */
export const replayDelivery = (id: string) =>
  client.post<Delivery>(`/deliveries/${id}/replay`, {}).then((r) => r.data)

/** `GET /v1/endpoints`. At most 20 per owner, so there is no paging. */
export const listEndpoints = () =>
  client.get<{ data: Endpoint[] }>('/endpoints').then((r) => r.data.data)

/** `POST /v1/endpoints`. The only answer that carries the signing secret, shown once. */
export const createEndpoint = (body: { name: string; url: string; event_types?: string[] }) =>
  client.post<EndpointCreated>('/endpoints', body).then((r) => r.data)
