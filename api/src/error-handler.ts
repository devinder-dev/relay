// The ONE place where errors become HTTP answers. Routes, services and repositories
// never build error responses: they throw, and Fastify sends every thrown error here.
// Every answer has the same shape: {"error": {"code", "message", "request_id"}}.
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { isDatabaseUnavailable } from "./db.ts";
import { AppError } from "./errors.ts";

// Fastify's own client errors, by status, with our names for them.
const CLIENT_ERROR_CODES: Record<number, string> = {
  400: "bad_request", // for example broken JSON
  413: "payload_too_large", // body over our 256 KiB limit
  415: "unsupported_media_type", // body that isn't JSON
};

function send(
  reply: FastifyReply,
  request: FastifyRequest,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) {
  const error = { code, message, request_id: request.id, ...(details ? { details } : {}) };
  return reply.code(status).send({ error });
}

// Step 1: allow only safe database metadata into logs. On Postgres 18.6 a CHECK
// failure's detail holds the whole row, including signing secrets; JSON errors can
// put the payload in where. Never log detail, where, hint or internal_query.
function logSafe(error: FastifyError) {
  if (error.name !== "PostgresError") return error;
  const dbError = error as FastifyError & Record<string, unknown>;
  return {
    type: "PostgresError", code: dbError.code, message: dbError.message,
    severity: dbError.severity, table: dbError.table_name,
    constraint: dbError.constraint_name, routine: dbError.routine,
  };
}

// Step 2: translate errors once, without exposing internal database details.
export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {

  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return send(reply, request, 422, "validation_failed", "Request validation failed", details);
  }

  if (error instanceof AppError) {
    return send(reply, request, error.status, error.code, error.message, error.details);
  }

  // The database can't be reached right now (a restart, a short blip). The pod stays up and
  // ready; only this request fails, with a clear "try again in 5 s" instead of a vague 500.
  if (isDatabaseUnavailable(error)) {
    request.log.warn({ err: logSafe(error) }, "⚠️ database unavailable, answered 503");
    reply.header("retry-after", "5");
    return send(reply, request, 503, "service_unavailable", "The service is briefly unavailable, try again shortly");
  }

  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    const code = CLIENT_ERROR_CODES[error.statusCode] || "bad_request";
    return send(reply, request, error.statusCode, code, error.message);
  }
  
  request.log.error(logSafe(error), "❌ unexpected error, answered 500");
 
  return send(reply, request, 500, "internal_error", "Something went wrong on our side");
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return send(reply, request, 404, "not_found", `Route ${request.method} ${request.url} not found`);
}
