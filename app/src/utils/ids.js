// src/utils/ids.js
import { randomUUID } from "node:crypto";
import { ValidationError } from "../app/errors.js";

// Regular expression for validating RFC4122 UUIDs (versions 1–5).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createId() {
  // Generate a cryptographically strong random UUID (v4 in Node's implementation).
  return randomUUID();
}

export function isUuid(value) {
  // Check that the value is a string and matches the UUID pattern.
  return typeof value === "string" && UUID_RE.test(value);
}

export function assertUuid(value, fieldName = "id") {
  // Validate that the given value is a UUID; if not, throw a user-facing validation error.
  if (!isUuid(value)) {
    throw new ValidationError(`${fieldName} must be a valid UUID`);
  }
  // Return the value unchanged so it can be used directly in calling code.
  return value;
}