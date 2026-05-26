// src/routes/forms.admin.routes.js
//
// Authenticated admin routes for managing forms, versions, and submissions.
// Mounted at /api/admin by server.js, behind the requireSession middleware.
import { Router } from "express";
import storage from "../storage/index.js";
import { NotFoundError } from "../app/errors.js";
import {
  validateCreateDraftVersionBody,
  validateCreateFormBody,
  validateFormIdParam,
  validateGetFormQuery,
  validateListFormsQuery,
  validateListSubmissionsQuery,
  validateUpdateFormBody
} from "../validation/forms.validation.js";
import {
  validateSubmissionIdParam
} from "../validation/submissions.validation.js";

// Wraps an async route handler so that any rejected promise is forwarded to
// Express's next(err) error handler instead of causing an unhandled rejection.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default function createAdminFormsRouter() {
  const router = Router({
    caseSensitive: true
  });

  // GET /api/admin/forms
  // Returns all non-deleted forms. Supports query params:
  //   ?status=draft|published|finished  – filter by status
  //   ?includeDeleted=true              – include soft-deleted forms
  //   ?includeSchema=true               – embed the active version schema
  router.get(
    "/forms",
    asyncHandler(async (req, res) => {
      const query = validateListFormsQuery(req.query);

      const forms = await storage.listForms(query);

      res.status(200).json({
        data: forms
      });
    })
  );

  // POST /api/admin/forms
  // Creates a new form in DRAFT status with version 1.
  // Body: { name: string, schema: object }
  router.post(
    "/forms",
    asyncHandler(async (req, res) => {
      const payload = validateCreateFormBody(req.body);

      const created = await storage.createForm(payload);

      res.status(201).json({
        data: created
      });
    })
  );

  // GET /api/admin/forms/:formId
  // Returns a single form. Supports query params:
  //   ?includeVersions=true  – attach the full version history
  //   ?includeDeleted=true   – allow returning soft-deleted forms
  router.get(
    "/forms/:formId",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);
      const query = validateGetFormQuery(req.query);

      const form = await storage.getFormById(formId, query);

      if (!form) {
        throw new NotFoundError("Form not found");
      }

      res.status(200).json({
        data: form
      });
    })
  );

  // PATCH /api/admin/forms/:formId
  // Partially updates a DRAFT form. At least one of name or schema must be provided.
  // Body: { name?: string, schema?: object }
  // Responds 409 if the form is not in DRAFT status.
  router.patch(
    "/forms/:formId",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);
      const patch = validateUpdateFormBody(req.body);

      const updated = await storage.updateForm(formId, patch);

      res.status(200).json({
        data: updated
      });
    })
  );

  // POST /api/admin/forms/:formId/publish
  // Transitions a DRAFT form to PUBLISHED status and stamps the current
  // version with publishedAt. Responds 409 if not in DRAFT status.
  router.post(
    "/forms/:formId/publish",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);

      const result = await storage.publishForm(formId);

      res.status(200).json({
        data: result
      });
    })
  );

  // POST /api/admin/forms/:formId/finish
  // Transitions a PUBLISHED form to FINISHED (archived) status.
  // Finished forms no longer accept new submissions.
  // Responds 409 if the form is not in PUBLISHED status.
  router.post(
    "/forms/:formId/finish",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);

      const result = await storage.finishForm(formId);

      res.status(200).json({
        data: result
      });
    })
  );

  // DELETE /api/admin/forms/:formId
  // Soft-deletes a form by setting its deletedAt timestamp.
  // The row is retained in storage but excluded from all normal queries.
  router.delete(
    "/forms/:formId",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);

      const result = await storage.softDeleteForm(formId);

      res.status(200).json({
        data: result
      });
    })
  );

  // GET /api/admin/forms/:formId/active-version
  // Returns the active (current) version record for a form, including its schema.
  // Responds 404 if the form does not exist or has no active version.
  router.get(
    "/forms/:formId/active-version",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);

      const version = await storage.getActiveFormVersion(formId);

      if (!version) {
        throw new NotFoundError("Form or active version not found");
      }

      res.status(200).json({
        data: version
      });
    })
  );

  // GET /api/admin/forms/:formId/versions
  // Returns all version records for a form in ascending version order.
  // Works for forms in any state, including deleted and finished.
  router.get(
    "/forms/:formId/versions",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);

      const versions = await storage.listFormVersions(formId);

      res.status(200).json({
        data: versions
      });
    })
  );

  // POST /api/admin/forms/:formId/versions
  // Creates a new draft version for a FINISHED form, incrementing the version
  // number and setting the form status back to DRAFT.
  // Body: { schema: object }
  // Responds 409 if the form is not in FINISHED status.
  router.post(
    "/forms/:formId/versions",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);
      const payload = validateCreateDraftVersionBody(req.body);

      const created = await storage.createDraftVersion(formId, payload.schema);

      res.status(201).json({
        data: created
      });
    })
  );

  // GET /api/admin/forms/:formId/submissions
  // Returns a paginated list of submissions for a form.
  // Supports query params: ?limit=50&offset=0 (limit range: 1–100)
  // Response: { data: [...], page: { limit, offset, total } }
  router.get(
    "/forms/:formId/submissions",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);
      const paging = validateListSubmissionsQuery(req.query);

      const result = await storage.listSubmissions(formId, paging);

      res.status(200).json({
        data: result.items,
        page: result.page
      });
    })
  );

  // GET /api/admin/forms/:formId/submissions/:submissionId
  // Returns a single submission by ID, scoped to the given form.
  // Responds 404 if the submission does not exist.
  router.get(
    "/forms/:formId/submissions/:submissionId",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);
      const submissionId = validateSubmissionIdParam(req.params.submissionId);

      const submission = await storage.getSubmissionById(formId, submissionId);

      if (!submission) {
        throw new NotFoundError("Submission not found");
      }

      res.status(200).json({
        data: submission
      });
    })
  );

  return router;
}