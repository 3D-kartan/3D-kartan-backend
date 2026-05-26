// src/storage/forms.storage.pg.js
//
// PostgreSQL storage driver for forms, form versions, and submissions.
// All data operations use parameterized queries routed through the shared
// connection pool in src/db/pool.js. Mutations that touch multiple tables
// are wrapped in withTransaction() to guarantee atomicity.

import {
  ConflictError,
  NotFoundError,
  StorageError,
  ValidationError
} from "../app/errors.js";
import { initDb, closeDb, getPool, withTransaction } from "../db/pool.js";
import { normalizeLocation } from "../utils/geo.js";
import { createId, assertUuid } from "../utils/ids.js";
import { FORM_STATUS, FORM_STATUSES } from "./storage.types.js";

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

// Validates that the form schema is a plain object.
function assertSchemaObject(schema) {
  return assertPlainObject(schema, "schema");
}

// Validates that a submission data payload is a plain object.
function assertDataObject(data) {
  return assertPlainObject(data, "data");
}

// Validates clientMeta if provided; returns null when omitted.
function assertClientMeta(clientMeta) {
  if (clientMeta === null || clientMeta === undefined) {
    return null;
  }
  return assertPlainObject(clientMeta, "clientMeta");
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

// Returns true if status is one of the known FORM_STATUS values.
function isValidStatus(status) {
  return FORM_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// Row mappers  –  convert raw pg result rows to plain JS objects
// ---------------------------------------------------------------------------

// Maps a forms table row to the standard form shape returned by the API.
function mapFormRow(row) {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    currentVersion: row.current_version,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
    deletedAt: row.deleted_at?.toISOString?.() ?? row.deleted_at ?? null
  };
}

// Like mapFormRow but also includes the joined active form_version columns
// (prefixed active_version_*) that are produced by listForms with includeSchema.
function mapFormRowWithActiveVersion(row) {
  const base = mapFormRow(row);

  if (!row.active_version_id) {
    return {
      ...base,
      activeVersion: null
    };
  }

  return {
    ...base,
    activeVersion: {
      id: row.active_version_id,
      version: row.active_version_number,
      schema: row.active_version_schema,
      createdAt:
        row.active_version_created_at?.toISOString?.() ?? row.active_version_created_at,
      publishedAt:
        row.active_version_published_at?.toISOString?.() ?? row.active_version_published_at
    }
  };
}

// Maps a form_versions table row to the standard version shape.
function mapVersionRow(row) {
  return {
    id: row.id,
    formId: row.form_id,
    version: row.version,
    schema: row.schema_json,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    publishedAt: row.published_at?.toISOString?.() ?? row.published_at ?? null
  };
}

// Maps a submissions table row to the standard submission shape.
// ST_X/ST_Y values arrive as the lon/lat columns from the SELECT.
function mapSubmissionRow(row) {
  const lon = row.lon === null || row.lon === undefined ? null : Number(row.lon);
  const lat = row.lat === null || row.lat === undefined ? null : Number(row.lat);

  return {
    id: row.id,
    formId: row.form_id,
    formVersionId: row.form_version_id,
    data: row.data,
    featureId: row.feature_id,
    layerId: row.layer_id,
    clientMeta: row.client_meta,
    location: lon === null || lat === null ? null : { lon, lat },
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
  };
}

// ---------------------------------------------------------------------------
// Internal query helpers  –  reusable queries used inside transactions
// ---------------------------------------------------------------------------

// Fetches a form row with a row-level lock (FOR UPDATE) inside an open
// transaction. Throws NotFoundError if the form does not exist or is
// soft-deleted. Used by all mutation paths that modify form state.
async function requireFormForUpdate(client, formId) {
  const result = await client.query(
    `
      SELECT id, name, status, current_version, created_at, updated_at, deleted_at
      FROM forms
      WHERE id = $1
      FOR UPDATE
    `,
    [formId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError("Form not found");
  }

  const row = result.rows[0];
  if (row.deleted_at) {
    throw new NotFoundError("Form not found");
  }

  return row;
}

// Verifies that a form row exists (any state, including deleted).
// Used before read-only sub-queries that need the form to exist.
async function requireFormExistsAnyState(client, formId) {
  const result = await client.query(
    `
      SELECT id
      FROM forms
      WHERE id = $1
    `,
    [formId]
  );

  if (result.rowCount === 0) {
    throw new NotFoundError("Form not found");
  }
}

// Fetches the form_versions row matching the form's current_version number
// with a row-level lock. Throws StorageError if the version row is missing.
async function getCurrentVersionForUpdate(client, formId, currentVersionNumber) {
  const result = await client.query(
    `
      SELECT id, form_id, version, schema_json, created_at, published_at
      FROM form_versions
      WHERE form_id = $1
        AND version = $2
      FOR UPDATE
    `,
    [formId, currentVersionNumber]
  );

  if (result.rowCount === 0) {
    throw new StorageError("Current form version not found");
  }

  return result.rows[0];
}

// ---------------------------------------------------------------------------
// Exported storage interface
// ---------------------------------------------------------------------------

// Initialises the database connection pool and verifies that the PostGIS
// extension and all required tables (forms, form_versions, submissions) exist.
export async function initStorage() {
  await initDb();

  const pool = getPool();

  try {
    await pool.query("SELECT PostGIS_version()");
    await pool.query("SELECT 1 FROM forms LIMIT 1");
    await pool.query("SELECT 1 FROM form_versions LIMIT 1");
    await pool.query("SELECT 1 FROM submissions LIMIT 1");
  } catch (error) {
    throw new StorageError("Database schema or PostGIS check failed", {
      cause: error.message
    });
  }
}

// Closes the database connection pool. Called on graceful server shutdown.
export async function closeStorage() {
  await closeDb();
}

// Returns an array of forms. Supports optional filters:
//   options.includeDeleted  – include soft-deleted forms (default: false)
//   options.includeSchema   – join and embed the active form_version (default: false)
//   options.status          – filter by a specific FORM_STATUS value (default: null = all)
export async function listForms(options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const includeSchema = options.includeSchema === true;
  const status = options.status ?? null;

  if (status !== null && !isValidStatus(status)) {
    throw new ValidationError("Invalid form status filter");
  }

  const params = [];
  const conditions = [];

  if (!includeDeleted) {
    conditions.push("f.deleted_at IS NULL");
  }

  if (status !== null) {
    params.push(status);
    conditions.push(`f.status = $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = includeSchema
    ? `
        SELECT
          f.id,
          f.name,
          f.status,
          f.current_version,
          f.created_at,
          f.updated_at,
          f.deleted_at,
          v.id AS active_version_id,
          v.version AS active_version_number,
          v.schema_json AS active_version_schema,
          v.created_at AS active_version_created_at,
          v.published_at AS active_version_published_at
        FROM forms f
        LEFT JOIN form_versions v
          ON v.form_id = f.id
         AND v.version = f.current_version
        ${whereClause}
        ORDER BY f.created_at DESC, f.id DESC
      `
    : `
        SELECT
          f.id,
          f.name,
          f.status,
          f.current_version,
          f.created_at,
          f.updated_at,
          f.deleted_at
        FROM forms f
        ${whereClause}
        ORDER BY f.created_at DESC, f.id DESC
      `;

  const result = await getPool().query(sql, params);

  return result.rows.map((row) =>
    includeSchema ? mapFormRowWithActiveVersion(row) : mapFormRow(row)
  );
}

// Returns a single form by ID, or null if not found.
//   options.includeVersions  – attach the full versions array (default: false)
//   options.includeDeleted   – allow returning soft-deleted forms (default: false)
export async function getFormById(formId, options = {}) {
  assertUuid(formId, "formId");

  const includeVersions = options.includeVersions === true;
  const includeDeleted = options.includeDeleted === true;

  const formResult = await getPool().query(
    `
      SELECT
        id,
        name,
        status,
        current_version,
        created_at,
        updated_at,
        deleted_at
      FROM forms
      WHERE id = $1
        AND ($2::boolean = true OR deleted_at IS NULL)
      LIMIT 1
    `,
    [formId, includeDeleted]
  );

  if (formResult.rowCount === 0) {
    return null;
  }

  const form = mapFormRow(formResult.rows[0]);

  if (!includeVersions) {
    return form;
  }

  const versionsResult = await getPool().query(
    `
      SELECT
        id,
        form_id,
        version,
        schema_json,
        created_at,
        published_at
      FROM form_versions
      WHERE form_id = $1
      ORDER BY version ASC
    `,
    [formId]
  );

  return {
    ...form,
    versions: versionsResult.rows.map(mapVersionRow)
  };
}

// Returns a form for public (unauthenticated) consumption.
// Only returns forms with status PUBLISHED that have an active published version.
// Returns null for drafts, finished forms, and deleted forms.
export async function getPublicFormById(formId) {
  assertUuid(formId, "formId");

  const result = await getPool().query(
    `
      SELECT
        f.id,
        f.name,
        f.status,
        f.current_version,
        f.created_at,
        f.updated_at,
        f.deleted_at,
        v.id AS active_version_id,
        v.version AS active_version_number,
        v.schema_json AS active_version_schema,
        v.created_at AS active_version_created_at,
        v.published_at AS active_version_published_at
      FROM forms f
      INNER JOIN form_versions v
        ON v.form_id = f.id
       AND v.version = f.current_version
      WHERE f.id = $1
        AND f.deleted_at IS NULL
        AND f.status = $2
        AND v.published_at IS NOT NULL
      LIMIT 1
    `,
    [formId, FORM_STATUS.PUBLISHED]
  );

  if (result.rowCount === 0) {
    return null;
  }

  const row = result.rows[0];

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    currentVersion: row.current_version,
    activeVersion: {
      id: row.active_version_id,
      version: row.active_version_number,
      schema: row.active_version_schema,
      createdAt:
        row.active_version_created_at?.toISOString?.() ?? row.active_version_created_at,
      publishedAt:
        row.active_version_published_at?.toISOString?.() ?? row.active_version_published_at
    }
  };
}

// Creates a new form in DRAFT status with version 1.
// Inserts one row in forms and one row in form_versions within a transaction.
export async function createForm(input) {
  const name = assertTrimmedString(input?.name, "name", { max: 200 });
  const schema = assertSchemaObject(input?.schema);

  return withTransaction(async (client) => {
    const formId = createId();
    const versionId = createId();

    await client.query(
      `
        INSERT INTO forms (
          id,
          name,
          status,
          current_version,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES ($1, $2, $3, $4, NOW(), NOW(), NULL)
      `,
      [formId, name, FORM_STATUS.DRAFT, 1]
    );

    await client.query(
      `
        INSERT INTO form_versions (
          id,
          form_id,
          version,
          schema_json,
          created_at,
          published_at
        )
        VALUES ($1, $2, $3, $4::jsonb, NOW(), NULL)
      `,
      [versionId, formId, 1, schema]
    );

    const result = await client.query(
      `
        SELECT
          id,
          name,
          status,
          current_version,
          created_at,
          updated_at,
          deleted_at
        FROM forms
        WHERE id = $1
      `,
      [formId]
    );

    return mapFormRow(result.rows[0]);
  });
}

// Applies a partial update (name and/or schema) to a DRAFT form.
// The schema update replaces the schema_json of the current version row.
// Throws ConflictError if the form is not in DRAFT status.
export async function updateForm(formId, patch) {
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

  return withTransaction(async (client) => {
    const form = await requireFormForUpdate(client, formId);

    if (form.status !== FORM_STATUS.DRAFT) {
      throw new ConflictError("Only draft forms can be updated");
    }

    if (hasSchema) {
      const currentVersion = await getCurrentVersionForUpdate(
        client,
        formId,
        form.current_version
      );

      await client.query(
        `
          UPDATE form_versions
          SET schema_json = $2::jsonb
          WHERE id = $1
        `,
        [currentVersion.id, schema]
      );
    }

    await client.query(
      `
        UPDATE forms
        SET
          name = CASE WHEN $2::text IS NULL THEN name ELSE $2 END,
          updated_at = NOW()
        WHERE id = $1
      `,
      [formId, hasName ? name : null]
    );

    const updatedResult = await client.query(
      `
        SELECT
          id,
          name,
          status,
          current_version,
          created_at,
          updated_at,
          deleted_at
        FROM forms
        WHERE id = $1
      `,
      [formId]
    );

    return mapFormRow(updatedResult.rows[0]);
  });
}

// Transitions a DRAFT form to PUBLISHED status and stamps the current
// version with published_at (idempotent – existing published_at is preserved).
// Throws ConflictError if the form is not in DRAFT status.
export async function publishForm(formId) {
  assertUuid(formId, "formId");

  return withTransaction(async (client) => {
    const form = await requireFormForUpdate(client, formId);

    if (form.status !== FORM_STATUS.DRAFT) {
      throw new ConflictError("Only draft forms can be published");
    }

    const version = await getCurrentVersionForUpdate(
      client,
      formId,
      form.current_version
    );

    const versionResult = await client.query(
      `
        UPDATE form_versions
        SET published_at = COALESCE(published_at, NOW())
        WHERE id = $1
        RETURNING published_at
      `,
      [version.id]
    );

    await client.query(
      `
        UPDATE forms
        SET
          status = $2,
          updated_at = NOW()
        WHERE id = $1
      `,
      [formId, FORM_STATUS.PUBLISHED]
    );

    const publishedAt =
      versionResult.rows[0].published_at?.toISOString?.() ??
      versionResult.rows[0].published_at;

    return {
      id: formId,
      status: FORM_STATUS.PUBLISHED,
      currentVersion: form.current_version,
      publishedAt
    };
  });
}

// Transitions a PUBLISHED form to FINISHED (archived) status.
// Finished forms no longer accept new submissions.
// Throws ConflictError if the form is not in PUBLISHED status.
export async function finishForm(formId) {
  assertUuid(formId, "formId");

  return withTransaction(async (client) => {
    const form = await requireFormForUpdate(client, formId);

    if (form.status !== FORM_STATUS.PUBLISHED) {
      throw new ConflictError("Only published forms can be finished");
    }

    const result = await client.query(
      `
        UPDATE forms
        SET
          status = $2,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, status, updated_at
      `,
      [formId, FORM_STATUS.FINISHED]
    );

    const row = result.rows[0];

    return {
      id: row.id,
      status: row.status,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
    };
  });
}

// Soft-deletes a form by setting deleted_at to the current timestamp.
// The row is kept in the database but filtered from all normal queries.
// Idempotent: calling it again on an already-deleted form returns the
// existing timestamps without modifying anything.
export async function softDeleteForm(formId) {
  assertUuid(formId, "formId");

  return withTransaction(async (client) => {
    const existingResult = await client.query(
      `
        SELECT id, deleted_at, updated_at
        FROM forms
        WHERE id = $1
        FOR UPDATE
      `,
      [formId]
    );

    if (existingResult.rowCount === 0) {
      throw new NotFoundError("Form not found");
    }

    const existing = existingResult.rows[0];

    if (existing.deleted_at) {
      return {
        id: existing.id,
        deletedAt: existing.deleted_at?.toISOString?.() ?? existing.deleted_at,
        updatedAt: existing.updated_at?.toISOString?.() ?? existing.updated_at
      };
    }

    const result = await client.query(
      `
        UPDATE forms
        SET
          deleted_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, deleted_at, updated_at
      `,
      [formId]
    );

    const row = result.rows[0];

    return {
      id: row.id,
      deletedAt: row.deleted_at?.toISOString?.() ?? row.deleted_at,
      updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at
    };
  });
}

// Returns the active (current_version) form_version for a given form,
// or null if the form doesn’t exist or is soft-deleted.
export async function getActiveFormVersion(formId) {
  assertUuid(formId, "formId");

  const result = await getPool().query(
    `
      SELECT
        v.id,
        v.form_id,
        v.version,
        v.schema_json,
        v.created_at,
        v.published_at
      FROM forms f
      INNER JOIN form_versions v
        ON v.form_id = f.id
       AND v.version = f.current_version
      WHERE f.id = $1
        AND f.deleted_at IS NULL
      LIMIT 1
    `,
    [formId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapVersionRow(result.rows[0]);
}

// Returns all version rows for a given form in ascending version order.
// Works for forms in any state (including deleted and finished).
export async function listFormVersions(formId) {
  assertUuid(formId, "formId");

  await requireFormExistsAnyState(getPool(), formId);

  const result = await getPool().query(
    `
      SELECT
        id,
        form_id,
        version,
        schema_json,
        created_at,
        published_at
      FROM form_versions
      WHERE form_id = $1
      ORDER BY version ASC
    `,
    [formId]
  );

  return result.rows.map(mapVersionRow);
}

// Creates a new draft version for a FINISHED form, incrementing the version
// number and setting the form status back to DRAFT.
// Throws ConflictError if the form is not in FINISHED status.
export async function createDraftVersion(formId, schemaInput) {
  assertUuid(formId, "formId");
  const schema = assertSchemaObject(schemaInput);

  return withTransaction(async (client) => {
    const form = await requireFormForUpdate(client, formId);

    if (form.status !== FORM_STATUS.FINISHED) {
      throw new ConflictError("Only finished forms can create a new draft version");
    }

    const nextVersion = form.current_version + 1;
    const versionId = createId();

    await client.query(
      `
        INSERT INTO form_versions (
          id,
          form_id,
          version,
          schema_json,
          created_at,
          published_at
        )
        VALUES ($1, $2, $3, $4::jsonb, NOW(), NULL)
      `,
      [versionId, formId, nextVersion, schema]
    );

    await client.query(
      `
        UPDATE forms
        SET
          status = $2,
          current_version = $3,
          updated_at = NOW()
        WHERE id = $1
      `,
      [formId, FORM_STATUS.DRAFT, nextVersion]
    );

    const result = await client.query(
      `
        SELECT
          id,
          form_id,
          version,
          schema_json,
          created_at,
          published_at
        FROM form_versions
        WHERE id = $1
      `,
      [versionId]
    );

    return mapVersionRow(result.rows[0]);
  });
}

// Records a new submission against a PUBLISHED form.
// Validates that the provided formVersionId matches the current active version.
// Stores optional GeoJSON point geometry via ST_SetSRID / ST_MakePoint.
// Throws ConflictError if the form is not published or the version is stale.
export async function createSubmission(input) {
  const formId = assertUuid(input?.formId, "formId");
  const formVersionId = assertUuid(input?.formVersionId, "formVersionId");
  const data = assertDataObject(input?.data);
  const featureId = normalizeOptionalString(input?.featureId, "featureId", { max: 200 });
  const layerId = normalizeOptionalString(input?.layerId, "layerId", { max: 200 });
  const clientMeta = assertClientMeta(input?.clientMeta);
  const location = normalizeLocation(input?.location, { allowNull: true });

  return withTransaction(async (client) => {
    const formResult = await client.query(
      `
        SELECT id, status, current_version, deleted_at
        FROM forms
        WHERE id = $1
        FOR UPDATE
      `,
      [formId]
    );

    if (formResult.rowCount === 0) {
      throw new NotFoundError("Form not found");
    }

    const form = formResult.rows[0];

    if (form.deleted_at) {
      throw new NotFoundError("Form not found");
    }

    if (form.status !== FORM_STATUS.PUBLISHED) {
      throw new ConflictError("Form is not open for submissions");
    }

    const versionResult = await client.query(
      `
        SELECT
          id,
          form_id,
          version,
          published_at
        FROM form_versions
        WHERE id = $1
          AND form_id = $2
        LIMIT 1
      `,
      [formVersionId, formId]
    );

    if (versionResult.rowCount === 0) {
      throw new ValidationError("formVersionId does not belong to the provided form");
    }

    const version = versionResult.rows[0];

    if (version.version !== form.current_version || !version.published_at) {
      throw new ConflictError("Submissions are only allowed for the active published form version");
    }

    const submissionId = createId();

    const insertResult = await client.query(
      `
        INSERT INTO submissions (
          id,
          form_id,
          form_version_id,
          data,
          feature_id,
          layer_id,
          client_meta,
          geom,
          created_at,
          updated_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4::jsonb,
          $5,
          $6,
          $7::jsonb,
          CASE
            WHEN $8::double precision IS NULL OR $9::double precision IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint($8, $9), 4326)
          END,
          NOW(),
          NOW()
        )
        RETURNING id, form_id, form_version_id, created_at
      `,
      [
        submissionId,
        formId,
        formVersionId,
        data,
        featureId,
        layerId,
        clientMeta,
        location?.lon ?? null,
        location?.lat ?? null
      ]
    );

    const row = insertResult.rows[0];

    return {
      id: row.id,
      formId: row.form_id,
      formVersionId: row.form_version_id,
      createdAt: row.created_at?.toISOString?.() ?? row.created_at
    };
  });
}

// Returns a paginated list of submissions for a form.
// { items, page: { limit, offset, total } }
export async function listSubmissions(formId, paging = {}) {
  assertUuid(formId, "formId");
  const { limit, offset } = normalizePaging(paging);

  await requireFormExistsAnyState(getPool(), formId);

  const countResult = await getPool().query(
    `
      SELECT COUNT(*)::int AS total
      FROM submissions
      WHERE form_id = $1
    `,
    [formId]
  );

  const itemsResult = await getPool().query(
    `
      SELECT
        id,
        form_id,
        form_version_id,
        data,
        feature_id,
        layer_id,
        client_meta,
        created_at,
        updated_at,
        CASE WHEN geom IS NULL THEN NULL ELSE ST_X(geom) END AS lon,
        CASE WHEN geom IS NULL THEN NULL ELSE ST_Y(geom) END AS lat
      FROM submissions
      WHERE form_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      OFFSET $3
    `,
    [formId, limit, offset]
  );

  return {
    items: itemsResult.rows.map(mapSubmissionRow),
    page: {
      limit,
      offset,
      total: countResult.rows[0].total
    }
  };
}

// Returns a single submission by its ID, scoped to the given form.
// Returns null if not found.
export async function getSubmissionById(formId, submissionId) {
  assertUuid(formId, "formId");
  assertUuid(submissionId, "submissionId");

  await requireFormExistsAnyState(getPool(), formId);

  const result = await getPool().query(
    `
      SELECT
        id,
        form_id,
        form_version_id,
        data,
        feature_id,
        layer_id,
        client_meta,
        created_at,
        updated_at,
        CASE WHEN geom IS NULL THEN NULL ELSE ST_X(geom) END AS lon,
        CASE WHEN geom IS NULL THEN NULL ELSE ST_Y(geom) END AS lat
      FROM submissions
      WHERE form_id = $1
        AND id = $2
      LIMIT 1
    `,
    [formId, submissionId]
  );

  if (result.rowCount === 0) {
    return null;
  }

  return mapSubmissionRow(result.rows[0]);
}