// The ONE place where errors become HTTP answers. Routes, services and repositories
// never build error responses: they throw, and Fastify sends every thrown error here.
// Every answer has the same shape: {"error": {"code", "message", "request_id"}}.
import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
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

export function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {

  if (error instanceof ZodError) {
    const details = error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return send(reply, request, 422, "validation_failed", "Request validation failed", details);
  }

  if (error instanceof AppError) {
    return send(reply, request, error.status, error.code, error.message);
  }

  if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
    const code = CLIENT_ERROR_CODES[error.statusCode] || "bad_request";
    return send(reply, request, error.statusCode, code, error.message);
  }
  
  request.log.error(error);
 
  return send(reply, request, 500, "internal_error", "Something went wrong on our side");
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply) {
  return send(reply, request, 404, "not_found", `Route ${request.method} ${request.url} not found`);
}
