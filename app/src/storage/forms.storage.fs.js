// src/storage/forms.storage.fs.js
//
// Flat-file JSON storage driver for forms, form versions, and submissions.
// All data is kept in a single JSON file (default: data/forms-db.json).
// Concurrent writes are serialised through a write-queue (Promise chain) so
// only one mutation runs at a time. Atomic persistence is achieved by writing
// to a temp file and renaming it over the target path.

import path from "node:path";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile
} from "node:fs/promises";

import config from "../app/config.js";
import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError
} from "../app/errors.js";
import { normalizeLocation } from "../utils/geo.js";
import { createId, assertUuid } from "../utils/ids.js";
import { FORM_STATUS, FORM_STATUSES } from "./storage.types.js";

const dbFilePath = path.join(config.dataDir, config.fsDbFileName);

// Whether the storage layer has been initialised for this process lifetime.
let initialized = false;
// Serialises all write operations; each mutation is chained onto this promise.
let writeQueue = Promise.resolve();

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

// Returns the current UTC instant as an ISO-8601 string.
function nowIso() {
  return new Date().toISOString();
}

// Deep-clones a value using structuredClone when available, falling back to
// a JSON round-trip. Used to prevent in-memory mutations from leaking between
// the working copy and return values.
function clone(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

// Returns the skeleton object written to disk when the database file does
// not yet exist.
function getEmptyDb() {
  return {
    meta: {
      version: 1,
      initializedAt: nowIso()
    },
    forms: [],
    formVersions: [],
    submissions: []
  };
}

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

// Throws ValidationError if value is not a plain non-array object.
// Returns the value as-is (or null when allowNull is true and value is nullish).
function assertPlainObject(value, fieldName, { allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new ValidationError(`${fieldName} is required`);
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError(`${fieldName} must be an object`);
  }

  return value;
}

// Throws ValidationError if value is not a non-empty string within max length.
// Returns the trimmed string (or null when allowNull is true and value is nullish).
function assertTrimmedString(value, fieldName, { max = 200, allowNull = false } = {}) {
  if (value === null || value === undefined) {
    if (allowNull) return null;
    throw new ValidationError(`${fieldName} is required`);
  }

  if (typeof value !== "string") {
    throw new ValidationError(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new ValidationError(`${fieldName} cannot be empty`);
  }

  if (trimmed.length > max) {
    throw new ValidationError(`${fieldName} must be at most ${max} characters`);
  }

  return trimmed;
}

// Returns null for empty/nullish values, otherwise delegates to assertTrimmedString.
function normalizeOptionalString(value, fieldName, { max = 200 } = {}) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return assertTrimmedString(value, fieldName, { max });
}

// Validates that the form schema is a plain object and returns a deep clone.
function assertSchemaObject(schema) {
  return clone(assertPlainObject(schema, "schema"));
}

// Validates that a submission data payload is a plain object and returns a deep clone.
function assertDataObject(data) {
  return clone(assertPlainObject(data, "data"));
}

// Validates clientMeta if provided and returns a deep clone, or null when omitted.
function assertClientMeta(clientMeta) {
  if (clientMeta === null || clientMeta === undefined) {
    return null;
  }
  return clone(assertPlainObject(clientMeta, "clientMeta"));
}

// Parses and validates pagination parameters { limit, offset }.
// Defaults: limit = 50, offset = 0. Allowed limit range: 1–100.
function normalizePaging(paging = {}) {
  const rawLimit = paging.limit ?? 50;
  const rawOffset = paging.offset ?? 0;

  const limit = Number(rawLimit);
  const offset = Number(rawOffset);

  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ValidationError("limit must be an integer between 1 and 100");
  }

  if (!Number.isInteger(offset) || offset < 0) {
    throw new ValidationError("offset must be an integer >= 0");
  }

  return { limit, offset };
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

// Throws StorageError if the parsed database JSON is structurally invalid
// (missing top-level arrays). Called after every file read.
function validateDbShape(db) {
  if (typeof db !== "object" || db === null || Array.isArray(db)) {
    throw new StorageError("FS storage file is malformed");
  }

  if (!Array.isArray(db.forms)) {
    throw new StorageError("FS storage file is missing forms array");
  }

  if (!Array.isArray(db.formVersions)) {
    throw new StorageError("FS storage file is missing formVersions array");
  }

  if (!Array.isArray(db.submissions)) {
    throw new StorageError("FS storage file is missing submissions array");
  }

  return db;
}

// Creates the data directory and the empty database file if they do not exist.
async function ensureDbFile() {
  await mkdir(config.dataDir, { recursive: true });

  try {
    await access(dbFilePath);
  } catch {
    await writeDb(getEmptyDb());
  }
}

// Reads and parses the database file from disk. Calls ensureDbFile first so
// the file is guaranteed to exist before the read.
async function readDb() {
  await ensureDbFile();

  try {
    const raw = await readFile(dbFilePath, "utf8");
    const parsed = JSON.parse(raw);
    return validateDbShape(parsed);
  } catch (error) {
    throw new StorageError("Failed to read FS storage", {
      cause: error.message
    });
  }
}

// Persists the database object to disk atomically:
//   1. Serialise to a temp file (PID + timestamp in the name to avoid collisions).
//   2. Rename the temp file over the target path.
//   3. On Windows EPERM/EEXIST, delete the target first then rename.
// The temp file is cleaned up on any error path.
async function writeDb(db) {
  const tempPath = `${dbFilePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(db, null, 2);

  try {
    await writeFile(tempPath, payload, { encoding: "utf8", mode: 0o600 });

    try {
      await rename(tempPath, dbFilePath);
    } catch (renameError) {
      if (renameError && (renameError.code === "EEXIST" || renameError.code === "EPERM")) {
        await rm(dbFilePath, { force: true });
        await rename(tempPath, dbFilePath);
      } else {
        throw renameError;
      }
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw new StorageError("Failed to write FS storage", {
      cause: error.message
    });
  }
}

// Queues a mutation on the write-queue to prevent concurrent file writes.
// The mutator receives a deep-cloned working copy of the database, mutates it
// in-place, and the result is persisted by writeDb before the promise resolves.
async function withWriteLock(mutator) {
  const run = writeQueue.then(async () => {
    const db = await readDb();
    const workingCopy = clone(db);
    const result = await mutator(workingCopy);
    await writeDb(workingCopy);
    return clone(result);
  });

  writeQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// In-memory query helpers
// ---------------------------------------------------------------------------

// Returns the first form in db.forms whose id matches, or null.
function findForm(db, formId) {
  return db.forms.find((item) => item.id === formId) ?? null;
}

// Asserts that a form exists and (by default) is not soft-deleted.
// Throws NotFoundError otherwise.
function requireForm(db, formId, { includeDeleted = false } = {}) {
  assertUuid(formId, "formId");

  const form = findForm(db, formId);
  if (!form) {
    throw new NotFoundError("Form not found");
  }

  if (!includeDeleted && form.deletedAt) {
    throw new NotFoundError("Form not found");
  }

  return form;
}

// Like requireForm but accepts forms in any state, including soft-deleted.
// Used by read paths that need to look up submissions for deleted forms.
function requireFormAnyState(db, formId) {
  assertUuid(formId, "formId");
  const form = findForm(db, formId);
  if (!form) {
    throw new NotFoundError("Form not found");
  }
  return form;
}

// Returns the form_versions entry that matches form.currentVersion, or null.
function getCurrentVersionRecord(db, form) {
  return (
    db.formVersions.find(
      (item) => item.formId === form.id && item.version === form.currentVersion
    ) ?? null
  );
}

// Returns a new array of versions sorted by version number ascending.
function sortVersions(versions) {
  return [...versions].sort((a, b) => a.version - b.version);
}

// Shapes a form + version into the public-facing response object.
function mapPublicForm(form, version) {
  return {
    id: form.id,
    name: form.name,
    status: form.status,
    currentVersion: form.currentVersion,
    activeVersion: version
      ? {
          id: version.id,
          version: version.version,
          schema: clone(version.schema),
          createdAt: version.createdAt,
          publishedAt: version.publishedAt
        }
      : null
  };
}

// Returns true if status is one of the known FORM_STATUS values.
function isValidStatus(status) {
  return FORM_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Exported storage interface
// ---------------------------------------------------------------------------

// Ensures the database file exists and marks the driver as initialised.
// Safe to call multiple times; subsequent calls are no-ops.
export async function initStorage() {
  if (initialized) return;
  await ensureDbFile();
  initialized = true;
}

// No-op for the file-based driver (no connection pool to close).
export async function closeStorage() {
  // no-op för filbaserad storage
}

// Returns an array of forms. Supports optional filters:
//   options.includeDeleted  – include soft-deleted forms (default: false)
//   options.includeSchema   – embed the active form_version (default: false)
//   options.status          – filter by a specific FORM_STATUS value (default: null = all)
export async function listForms(options = {}) {
  await initStorage();

  const includeDeleted = options.includeDeleted === true;
  const includeSchema = options.includeSchema === true;
  const status = options.status ?? null;

  if (status !== null && !isValidStatus(status)) {
    throw new ValidationError("Invalid form status filter");
  }

  const db = await readDb();

  let forms = db.forms.filter((form) => includeDeleted || !form.deletedAt);

  if (status !== null) {
    forms = forms.filter((form) => form.status === status);
  }

  forms.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  return forms.map((form) => {
    const result = {
      id: form.id,
      name: form.name,
      status: form.status,
      currentVersion: form.currentVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      deletedAt: form.deletedAt
    };

    if (includeSchema) {
      const version = getCurrentVersionRecord(db, form);
      result.activeVersion = version
        ? {
            id: version.id,
            version: version.version,
            schema: clone(version.schema),
            createdAt: version.createdAt,
            publishedAt: version.publishedAt
          }
        : null;
    }

    return result;
  });
}

// Returns a single form by ID, or null if not found.
//   options.includeVersions  – attach the full versions array (default: false)
//   options.includeDeleted   – allow returning soft-deleted forms (default: false)
export async function getFormById(formId, options = {}) {
  await initStorage();

  const includeVersions = options.includeVersions === true;
  const includeDeleted = options.includeDeleted === true;

  const db = await readDb();
  const form = db.forms.find(
    (item) => item.id === formId && (includeDeleted || !item.deletedAt)
  );

  if (!form) {
    return null;
  }

  const result = {
    id: form.id,
    name: form.name,
    status: form.status,
    currentVersion: form.currentVersion,
    createdAt: form.createdAt,
    updatedAt: form.updatedAt,
    deletedAt: form.deletedAt
  };

  if (includeVersions) {
    result.versions = sortVersions(
      db.formVersions.filter((item) => item.formId === form.id)
    ).map((item) => ({
      id: item.id,
      formId: item.formId,
      version: item.version,
      schema: clone(item.schema),
      createdAt: item.createdAt,
      publishedAt: item.publishedAt
    }));
  }

  return result;
}

// Returns a form for public (unauthenticated) consumption.
// Only returns forms with status PUBLISHED that have an active published version.
// Returns null for drafts, finished forms, and deleted forms.
export async function getPublicFormById(formId) {
  await initStorage();

  assertUuid(formId, "formId");

  const db = await readDb();
  const form = db.forms.find(
    (item) =>
      item.id === formId &&
      !item.deletedAt &&
      item.status === FORM_STATUS.PUBLISHED
  );

  if (!form) {
    return null;
  }

  const version = getCurrentVersionRecord(db, form);
  if (!version || !version.publishedAt) {
    return null;
  }

  return mapPublicForm(form, version);
}

// Creates a new form in DRAFT status with version 1.
// Pushes one entry into db.forms and one into db.formVersions.
export async function createForm(input) {
  await initStorage();

  const name = assertTrimmedString(input?.name, "name", { max: 200 });
  const schema = assertSchemaObject(input?.schema);

  return withWriteLock(async (db) => {
    const formId = createId();
    const versionId = createId();
    const timestamp = nowIso();

    const version = {
      id: versionId,
      formId,
      version: 1,
      schema,
      createdAt: timestamp,
      publishedAt: null
    };

    const form = {
      id: formId,
      name,
      status: FORM_STATUS.DRAFT,
      currentVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null
    };

    db.formVersions.push(version);
    db.forms.push(form);

    return {
      id: form.id,
      name: form.name,
      status: form.status,
      currentVersion: form.currentVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      deletedAt: form.deletedAt
    };
  });
}

// Applies a partial update (name and/or schema) to a DRAFT form.
// The schema update replaces the schema field on the current version record.
// Throws ConflictError if the form is not in DRAFT status.
export async function updateForm(formId, patch) {
  await initStorage();

  assertUuid(formId, "formId");

  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new ValidationError("patch must be an object");
  }

  const hasName = Object.prototype.hasOwnProperty.call(patch, "name");
  const hasSchema = Object.prototype.hasOwnProperty.call(patch, "schema");

  if (!hasName && !hasSchema) {
    throw new ValidationError("patch must include at least one of: name, schema");
  }

  const name = hasName
    ? assertTrimmedString(patch.name, "name", { max: 200 })
    : undefined;

  const schema = hasSchema ? assertSchemaObject(patch.schema) : undefined;

  return withWriteLock(async (db) => {
    const form = requireForm(db, formId);

    if (form.status !== FORM_STATUS.DRAFT) {
      throw new ConflictError("Only draft forms can be updated");
    }

    if (hasName) {
      form.name = name;
    }

    if (hasSchema) {
      const version = getCurrentVersionRecord(db, form);
      if (!version) {
        throw new StorageError("Current form version not found");
      }
      version.schema = schema;
    }

    form.updatedAt = nowIso();

    return {
      id: form.id,
      name: form.name,
      status: form.status,
      currentVersion: form.currentVersion,
      createdAt: form.createdAt,
      updatedAt: form.updatedAt,
      deletedAt: form.deletedAt
    };
  });
}

// Transitions a DRAFT form to PUBLISHED status and stamps the current version
// with publishedAt (idempotent – existing publishedAt is preserved).
// Throws ConflictError if the form is not in DRAFT status.
export async function publishForm(formId) {
  await initStorage();
  assertUuid(formId, "formId");

  return withWriteLock(async (db) => {
    const form = requireForm(db, formId);

    if (form.status !== FORM_STATUS.DRAFT) {
      throw new ConflictError("Only draft forms can be published");
    }

    const version = getCurrentVersionRecord(db, form);
    if (!version) {
      throw new StorageError("Current form version not found");
    }

    const timestamp = nowIso();

    if (!version.publishedAt) {
      version.publishedAt = timestamp;
    }

    form.status = FORM_STATUS.PUBLISHED;
    form.updatedAt = timestamp;

    return {
      id: form.id,
      status: form.status,
      currentVersion: form.currentVersion,
      publishedAt: version.publishedAt,
      updatedAt: form.updatedAt
    };
  });
}

// Transitions a PUBLISHED form to FINISHED (archived) status.
// Finished forms no longer accept new submissions.
// Throws ConflictError if the form is not in PUBLISHED status.
export async function finishForm(formId) {
  await initStorage();
  assertUuid(formId, "formId");

  return withWriteLock(async (db) => {
    const form = requireForm(db, formId);

    if (form.status !== FORM_STATUS.PUBLISHED) {
      throw new ConflictError("Only published forms can be finished");
    }

    form.status = FORM_STATUS.FINISHED;
    form.updatedAt = nowIso();

    return {
      id: form.id,
      status: form.status,
      updatedAt: form.updatedAt
    };
  });
}

// Soft-deletes a form by setting deletedAt to the current timestamp.
// The entry is kept in the file but filtered from all normal queries.
// Idempotent: calling it again on an already-deleted form is a no-op.
export async function softDeleteForm(formId) {
  await initStorage();
  assertUuid(formId, "formId");

  return withWriteLock(async (db) => {
    const form = requireFormAnyState(db, formId);

    if (!form.deletedAt) {
      const timestamp = nowIso();
      form.deletedAt = timestamp;
      form.updatedAt = timestamp;
    }

    return {
      id: form.id,
      deletedAt: form.deletedAt,
      updatedAt: form.updatedAt
    };
  });
}

// Returns the active (currentVersion) form_version record for a given form,
// or null if the form does not exist or is soft-deleted.
export async function getActiveFormVersion(formId) {
  await initStorage();
  assertUuid(formId, "formId");

  const db = await readDb();
  const form = db.forms.find((item) => item.id === formId && !item.deletedAt);

  if (!form) {
    return null;
  }

  const version = getCurrentVersionRecord(db, form);
  if (!version) {
    return null;
  }

  return {
    id: version.id,
    formId: version.formId,
    version: version.version,
    schema: clone(version.schema),
    createdAt: version.createdAt,
    publishedAt: version.publishedAt
  };
}

// Returns all version records for a given form in ascending version order.
// Works for forms in any state (including deleted and finished).
export async function listFormVersions(formId) {
  await initStorage();
  assertUuid(formId, "formId");

  const db = await readDb();
  requireFormAnyState(db, formId);

  return sortVersions(
    db.formVersions.filter((item) => item.formId === formId)
  ).map((item) => ({
    id: item.id,
    formId: item.formId,
    version: item.version,
    schema: clone(item.schema),
    createdAt: item.createdAt,
    publishedAt: item.publishedAt
  }));
}

// Creates a new draft version for a FINISHED form, incrementing the version
// number and setting the form status back to DRAFT.
// Throws ConflictError if the form is not in FINISHED status.
export async function createDraftVersion(formId, schemaInput) {
  await initStorage();
  assertUuid(formId, "formId");

  const schema = assertSchemaObject(schemaInput);

  return withWriteLock(async (db) => {
    const form = requireForm(db, formId);

    if (form.status !== FORM_STATUS.FINISHED) {
      throw new ConflictError("Only finished forms can create a new draft version");
    }

    const timestamp = nowIso();
    const nextVersionNumber = form.currentVersion + 1;

    const version = {
      id: createId(),
      formId: form.id,
      version: nextVersionNumber,
      schema,
      createdAt: timestamp,
      publishedAt: null
    };

    db.formVersions.push(version);

    form.currentVersion = nextVersionNumber;
    form.status = FORM_STATUS.DRAFT;
    form.updatedAt = timestamp;

    return {
      id: version.id,
      formId: version.formId,
      version: version.version,
      schema: clone(version.schema),
      createdAt: version.createdAt,
      publishedAt: version.publishedAt
    };
  });
}

// Records a new submission against a PUBLISHED form.
// Validates that the provided formVersionId matches the current active version.
// Throws ConflictError if the form is not published or the version is stale.
export async function createSubmission(input) {
  await initStorage();

  const formId = assertUuid(input?.formId, "formId");
  const formVersionId = assertUuid(input?.formVersionId, "formVersionId");
  const data = assertDataObject(input?.data);
  const featureId = normalizeOptionalString(input?.featureId, "featureId", { max: 200 });
  const layerId = normalizeOptionalString(input?.layerId, "layerId", { max: 200 });
  const clientMeta = assertClientMeta(input?.clientMeta);
  const location = normalizeLocation(input?.location, { allowNull: true });

  return withWriteLock(async (db) => {
    const form = requireForm(db, formId);

    if (form.status !== FORM_STATUS.PUBLISHED) {
      throw new ConflictError("Form is not open for submissions");
    }

    const version = db.formVersions.find(
      (item) => item.id === formVersionId && item.formId === formId
    );

    if (!version) {
      throw new ValidationError("formVersionId does not belong to the provided form");
    }

    if (version.version !== form.currentVersion || !version.publishedAt) {
      throw new ConflictError("Submissions are only allowed for the active published form version");
    }

    const timestamp = nowIso();
    const submission = {
      id: createId(),
      formId,
      formVersionId,
      data,
      featureId,
      layerId,
      clientMeta,
      location,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    db.submissions.push(submission);

    return {
      id: submission.id,
      formId: submission.formId,
      formVersionId: submission.formVersionId,
      createdAt: submission.createdAt
    };
  });
}

// Returns a paginated list of submissions for a form, sorted by createdAt DESC.
// { items, page: { limit, offset, total } }
export async function listSubmissions(formId, paging = {}) {
  await initStorage();
  assertUuid(formId, "formId");

  const { limit, offset } = normalizePaging(paging);

  const db = await readDb();
  requireFormAnyState(db, formId);

  const allItems = db.submissions
    .filter((item) => item.formId === formId)
    .sort((a, b) => {
      if (a.createdAt === b.createdAt) {
        return a.id.localeCompare(b.id);
      }
      return b.createdAt.localeCompare(a.createdAt);
    });

  const items = allItems.slice(offset, offset + limit).map((item) => ({
    id: item.id,
    formId: item.formId,
    formVersionId: item.formVersionId,
    data: clone(item.data),
    featureId: item.featureId,
    layerId: item.layerId,
    clientMeta: item.clientMeta ? clone(item.clientMeta) : null,
    location: item.location ? clone(item.location) : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  }));

  return {
    items,
    page: {
      limit,
      offset,
      total: allItems.length
    }
  };
}

// Returns a single submission by its ID, scoped to the given form.
// Returns null if not found.
export async function getSubmissionById(formId, submissionId) {
  await initStorage();

  assertUuid(formId, "formId");
  assertUuid(submissionId, "submissionId");

  const db = await readDb();
  requireFormAnyState(db, formId);

  const item = db.submissions.find(
    (submission) =>
      submission.formId === formId && submission.id === submissionId
  );

  if (!item) {
    return null;
  }

  return {
    id: item.id,
    formId: item.formId,
    formVersionId: item.formVersionId,
    data: clone(item.data),
    featureId: item.featureId,
    layerId: item.layerId,
    clientMeta: item.clientMeta ? clone(item.clientMeta) : null,
    location: item.location ? clone(item.location) : null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}