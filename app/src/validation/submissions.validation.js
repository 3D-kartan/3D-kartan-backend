// src/validation/submissions.validation.js
import { ValidationError } from "../app/errors.js";
import { assertUuid } from "../utils/ids.js";

function clone(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  // Fallback: deep clone via JSON. This drops non‑JSON values
  // (functions, Dates, undefined, etc.)
  return JSON.parse(JSON.stringify(value));
}

function assertPlainObject(value, fieldName, { allowNull = false } = {}) {
  // Allow null/undefined only if explicitly requested.
  if (value === null || value === undefined) {
    if (allowNull) {
      return null;
    }
    throw new ValidationError(`${fieldName} is required`);
  }

  // Ensure we have a plain object (no arrays, no primitives).
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an object`);
  }

  return value;
}

function assertNoUnknownKeys(obj, allowedKeys, fieldName = "body") {
  // Compute keys that are not part of the allowed set.
  const unknownKeys = Object.keys(obj).filter((key) => !allowedKeys.has(key));

  // Reject any payload that includes unexpected/extra fields.
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      `${fieldName} contains unknown field(s): ${unknownKeys.join(", ")}`
    );
  }
}

function assertTrimmedString(value, fieldName, { max = 200 } = {}) {
  // Require the value to be a string at the type level.
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }

  // Trim whitespace from both ends to avoid accidental spaces.
  const trimmed = value.trim();

  // Empty or whitespace‑only strings are not allowed.
  if (!trimmed) {
    throw new ValidationError(`${fieldName} cannot be empty`);
  }

  // Enforce a maximum length to protect the database and logs.
  if (trimmed.length > max) {
    throw new ValidationError(`${fieldName} must be at most ${max} characters`);
  }

  return trimmed;
}

function normalizeOptionalString(value, fieldName, { max = 200 } = {}) {
  // Treat undefined, null and empty string as "no value".
  if (value === undefined || value === null || value === "") {
    return null;
  }

  // For any other value, validate and normalize it as a trimmed string.
  return assertTrimmedString(value, fieldName, { max });
}

function normalizeLocation(value) {
  // location is optional – missing or null means "no location".
  if (value === undefined || value === null) {
    return null;
  }

  // Ensure location is an object.
  const location = assertPlainObject(value, "location");

  // Only lon/lat are allowed inside location.
  assertNoUnknownKeys(location, new Set(["lon", "lat"]), "location");

  // Coerce lon/lat to Numbers (allows strings like "18.06").
  const lon = Number(location.lon);
  const lat = Number(location.lat);

  // Both must be finite numbers (no NaN, Infinity, etc.).
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    throw new ValidationError("location.lon and location.lat must be finite numbers");
  }

  // Basic geographic bounds for longitude and latitude (WGS84).
  if (lon < -180 || lon > 180) {
    throw new ValidationError("location.lon must be between -180 and 180");
  }

  if (lat < -90 || lat > 90) {
    throw new ValidationError("location.lat must be between -90 and 90");
  }

  // Return a normalized object with numeric lon/lat.
  return { lon, lat };
}

export function validateSubmissionIdParam(value, fieldName = "submissionId") {
  // Delegate UUID validation to shared helper to keep format consistent.
  return assertUuid(value, fieldName);
}

export function validateCreateSubmissionBody(body) {
  // Require the incoming request body to be a plain JSON object.
  const payload = assertPlainObject(body, "body");

  // Only allow a fixed set of top‑level keys to prevent accidental
  ///unexpected data from being stored.
  assertNoUnknownKeys(
    payload,
    new Set(["formVersionId", "data", "featureId", "layerId", "clientMeta", "location"])
  );

  return {
    // formVersionId must be a valid UUID referring to a specific form version.
    formVersionId: assertUuid(payload.formVersionId, "formVersionId"),

    // data holds the actual form submission content; deep‑clone to decouple
    // from the original object and protect against later mutations.
    data: clone(assertPlainObject(payload.data, "data")),

    // Optional identifiers that may be used to link submissions to features/layers
    // on the client or in external systems.
    featureId: normalizeOptionalString(payload.featureId, "featureId", { max: 200 }),
    layerId: normalizeOptionalString(payload.layerId, "layerId", { max: 200 }),

    // Optional client metadata (e.g. user agent, extra context). Must be an object
    // if provided, and is deep‑cloned to avoid mutations.
    clientMeta:
      payload.clientMeta === undefined || payload.clientMeta === null
        ? null
        : clone(assertPlainObject(payload.clientMeta, "clientMeta")),

    // Optional geographic location attached to the submission.
    location: normalizeLocation(payload.location)
  };
}