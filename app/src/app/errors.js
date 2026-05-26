// src/app/errors.js
//
// Application error hierarchy. All custom errors extend AppError so that the
// global error handler in server.js can distinguish them from unexpected
// native errors and serialise them consistently.

// Base class for all application-level errors.
// statusCode  – HTTP status sent to the client.
// code        – Machine-readable error identifier included in the response body.
// details     – Optional structured context (e.g. validation field errors).
// expose      – When true the message is sent to the client; defaults to true
//               for 4xx errors and false for 5xx errors.
export class AppError extends Error {
  constructor(
    message,
    {
      statusCode = 500,
      code = "APP_ERROR",
      details = null,
      expose = statusCode < 500
    } = {}
  ) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.expose = expose;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

// 400 – The request body or parameters failed validation.
export class ValidationError extends AppError {
  constructor(message = "Validation failed", details = null) {
    super(message, {
      statusCode: 400,
      code: "VALIDATION_ERROR",
      details,
      expose: true
    });
  }
}

// 401 – The request lacks valid authentication credentials.
export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(message, {
      statusCode: 401,
      code: "UNAUTHORIZED",
      expose: true
    });
  }
}

// 403 – The authenticated user does not have permission to perform the action.
export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(message, {
      statusCode: 403,
      code: "FORBIDDEN",
      expose: true
    });
  }
}

// 404 – The requested resource does not exist.
export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(message, {
      statusCode: 404,
      code: "NOT_FOUND",
      expose: true
    });
  }
}

// 409 – The request conflicts with the current state of the resource
//        (e.g. trying to publish a form that is not in DRAFT status).
export class ConflictError extends AppError {
  constructor(message = "Conflict", details = null) {
    super(message, {
      statusCode: 409,
      code: "CONFLICT",
      details,
      expose: true
    });
  }
}

// 500 – An unexpected error occurred in the storage layer.
//        expose is false so the raw message is never sent to the client.
export class StorageError extends AppError {
  constructor(message = "Storage error", details = null) {
    super(message, {
      statusCode: 500,
      code: "STORAGE_ERROR",
      details,
      expose: false
    });
  }
}

// Returns true if error is an instance of AppError (i.e. a known application
// error), allowing the global error handler to distinguish it from unexpected
// native errors such as TypeError or SyntaxError.
export function isAppError(error) {
  return error instanceof AppError;
}