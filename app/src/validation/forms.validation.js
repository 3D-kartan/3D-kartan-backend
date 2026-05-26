// src/validation/forms.validation.js
import { ValidationError } from "../app/errors.js";
import { assertUuid } from "../utils/ids.js";
import { FORM_STATUSES } from "../storage/storage.types.js";

function clone(value) {
  // Prefer the native structuredClone when available for deep cloning.
  // Falls back to JSON serialization for simple JSON-serializable payloads.
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function assertPlainObject(value, fieldName) {
  // Require the value to be present.
  if (value === null || value === undefined) {
    throw new ValidationError(`${fieldName} is required`);
  }

  // Ensure we have a plain object (no arrays, primitives, etc.).
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an object`);
  }

  return value;
}

function assertNoUnknownKeys(obj, allowedKeys, fieldName = "body") {
  // List all keys that are not part of the allowed set.
  const unknownKeys = Object.keys(obj).filter((key) => !allowedKeys.has(key));

  // Reject payloads that contain unexpected/extra fields.
  if (unknownKeys.length > 0) {
    throw new ValidationError(
      `${fieldName} contains unknown field(s): ${unknownKeys.join(", ")}`
    );
  }
}

function assertTrimmedString(value, fieldName, { max = 200 } = {}) {
  // Require a string type.
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }

  // Trim whitespace from both ends.
  const trimmed = value.trim();

  // Reject empty or whitespace-only strings.
  if (!trimmed) {
    throw new ValidationError(`${fieldName} cannot be empty`);
  }

  // Enforce a maximum length to protect the DB and avoid excessive payloads.
  if (trimmed.length > max) {
    throw new ValidationError(`${fieldName} must be at most ${max} characters`);
  }

  return trimmed;
}

function assertSchemaObject(schema) {
  // Ensure the schema is a plain object and return a deep-cloned copy
  // so we cannot accidentally mutate the original reference later.
  return clone(assertPlainObject(schema, "schema"));
}

function getSingleQueryValue(value, fieldName) {
  // If the query parameter is not present at all, return undefined.
  if (value === undefined) {
    return undefined;
  }

  // Arrays indicate that the same query parameter was provided multiple times.
  if (Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must only be provided once`);
  }

  // Query parameters must be strings at this point.
  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }

  return value;
}

function parseBooleanQuery(value, fieldName, fallback = false) {
  // Normalize a query param that should be interpreted as boolean.
  const raw = getSingleQueryValue(value, fieldName);

  // If not provided, use the fallback value.
  if (raw === undefined) {
    return fallback;
  }

  const normalized = raw.trim().toLowerCase();

  // Accept several common truthy string representations.
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  // And several common falsy representations.
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  throw new ValidationError(`${fieldName} must be a boolean`);
}

function parseIntegerQuery(
  value,
  fieldName,
  { fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}
) {
  // Normalize a query param that should be interpreted as integer.
  const raw = getSingleQueryValue(value, fieldName);

  // If not provided, use the fallback value.
  if (raw === undefined) {
    return fallback;
  }

  // Ensure the string looks like a plain integer (optional minus sign).
  if (!/^-?\d+$/.test(raw.trim())) {
    throw new ValidationError(`${fieldName} must be an integer`);
  }

  const parsed = Number.parseInt(raw, 10);

  // Validate the range and that it is a proper integer.
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ValidationError(
      `${fieldName} must be an integer between ${min} and ${max}`
    );
  }

  return parsed;
}

function parseOptionalStatusQuery(value, fieldName = "status") {
  // Parse an optional status query parameter.
  const raw = getSingleQueryValue(value, fieldName);

  // Missing or empty = no status filter.
  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  const status = raw.trim().toLowerCase();

  // Status must be one of the allowed form lifecyle statuses.
  if (!FORM_STATUSES.includes(status)) {
    throw new ValidationError(
      `${fieldName} must be one of: ${FORM_STATUSES.join(", ")}`
    );
  }

  return status;
}

export function validateFormIdParam(value, fieldName = "formId") {
  // Validate that the formId path parameter is a proper UUID.
  return assertUuid(value, fieldName);
}

export function validateListFormsQuery(query = {}) {
  // Normalize and validate query parameters used for listing forms.
  return {
    // Whether to include soft-deleted forms in the result.
    includeDeleted: parseBooleanQuery(query.includeDeleted, "includeDeleted", false),
    // Whether to include the full schema payload for each form.
    includeSchema: parseBooleanQuery(query.includeSchema, "includeSchema", false),
    // Optional filter on form status.
    status: parseOptionalStatusQuery(query.status, "status")
  };
}

export function validateGetFormQuery(query = {}) {
  // Normalize and validate query parameters used when fetching a single form.
  return {
    // Whether to allow fetching soft-deleted forms.
    includeDeleted: parseBooleanQuery(query.includeDeleted, "includeDeleted", false),
    // Whether to include all versions of this form in the response.
    includeVersions: parseBooleanQuery(query.includeVersions, "includeVersions", false)
  };
}

export function validateCreateFormBody(body) {
  // Validate and normalize the request body used when creating a new form.
  const payload = assertPlainObject(body, "body");

  // Only "name" and "schema" are allowed during creation.
  assertNoUnknownKeys(payload, new Set(["name", "schema"]));

  return {
    // Human-readable name for the form.
    name: assertTrimmedString(payload.name, "name", { max: 200 }),
    // JSON schema (or similar structure) that defines the form.
    schema: assertSchemaObject(payload.schema)
  };
}

export function validateUpdateFormBody(body) {
  // Validate and normalize the request body used when updating a form.
  const payload = assertPlainObject(body, "body");

  // Only "name" and "schema" are allowed fields in an update.
  assertNoUnknownKeys(payload, new Set(["name", "schema"]));

  const hasName = Object.prototype.hasOwnProperty.call(payload, "name");
  const hasSchema = Object.prototype.hasOwnProperty.call(payload, "schema");

  // Require at least one of the updatable fields to be present.
  if (!hasName && !hasSchema) {
    throw new ValidationError("body must include at least one of: name, schema");
  }

  const patch = {};

  // If name is provided, validate and include it in the patch.
  if (hasName) {
    patch.name = assertTrimmedString(payload.name, "name", { max: 200 });
  }

  // If schema is provided, validate and include a cloned version in the patch.
  if (hasSchema) {
    patch.schema = assertSchemaObject(payload.schema);
  }

  return patch;
}

export function validateCreateDraftVersionBody(body) {
  // Validate and normalize body used to create a new draft version of a form.
  const payload = assertPlainObject(body, "body");

  // Only the "schema" field is allowed for draft creation.
  assertNoUnknownKeys(payload, new Set(["schema"]));

  return {
    schema: assertSchemaObject(payload.schema)
  };
}

export function validateListSubmissionsQuery(query = {}) {
  // Normalize and validate query parameters when listing submissions
  // for a given form (version).
  return {
    // Pagination limit (how many submissions to return).
    limit: parseIntegerQuery(query.limit, "limit", {
      fallback: 50,
      min: 1,
      max: 100
    }),
    // Pagination offset (how many submissions to skip).
    offset: parseIntegerQuery(query.offset, "offset", {
      fallback: 0,
      min: 0,
      max: 1_000_000
    })
  };
}