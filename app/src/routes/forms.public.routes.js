// src/routes/forms.public.routes.js
//
// Public (unauthenticated) routes for reading forms and submitting responses.
// Mounted at /api/public by server.js.
import { Router } from "express";
import storage from "../storage/index.js";
import { NotFoundError } from "../app/errors.js";
import { validateFormIdParam } from "../validation/forms.validation.js";
import { validateCreateSubmissionBody } from "../validation/submissions.validation.js";

// Wraps an async route handler so that any rejected promise is forwarded to
// Express's next(err) error handler instead of causing an unhandled rejection.
function asyncHandler(fn) {
  return function wrapped(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export default function createPublicFormsRouter() {
  const router = Router({
    caseSensitive: true
  });

  // GET /api/public/forms/:formId
  // Returns a single published form (name, status, active version schema).
  // Responds 404 for drafts, finished forms, deleted forms, and unknown IDs.
  router.get(
    "/forms/:formId",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);

      const form = await storage.getPublicFormById(formId);

      if (!form) {
        throw new NotFoundError("Form not found");
      }

      res.status(200).json({
        data: form
      });
    })
  );

  // POST /api/public/forms/:formId/submissions
  // Records a new submission against an active published form.
  // The request body must include formVersionId, data, and optional location,
  // featureId, layerId, and clientMeta fields.
  // Responds 404 if the form is not published, 409 if the version is stale.
  router.post(
    "/forms/:formId/submissions",
    asyncHandler(async (req, res) => {
      const formId = validateFormIdParam(req.params.formId);
      const payload = validateCreateSubmissionBody(req.body);

      const publicForm = await storage.getPublicFormById(formId);

      if (!publicForm) {
        throw new NotFoundError("Form not found");
      }

      const created = await storage.createSubmission({
        formId,
        formVersionId: payload.formVersionId,
        data: payload.data,
        featureId: payload.featureId,
        layerId: payload.layerId,
        clientMeta: payload.clientMeta,
        location: payload.location
      });

      res.status(201).json({
        data: created
      });
    })
  );

  return router;
}