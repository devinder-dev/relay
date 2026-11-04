// Errors our own code throws on purpose ("this delivery doesn't exist", "already delivered").
// Code deep down only throws them; the error handler decides what the client sees.
export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, readonly details?: { path: string; message: string }[]) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

export const notFound = (what: string) => new AppError(404, "not_found", `${what} not found`);

export const conflict = (code: string, message: string) => new AppError(409, code, message);

// Step 1: every authentication failure has the same public answer.
export const unauthorized = () => new AppError(401, "unauthorized", "A valid API key is required");
