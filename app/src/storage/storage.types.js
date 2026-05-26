// src/storage/storage.types.js

// Enumeration of all possible lifecycle states for a form.
// - draft:     form is being worked on and not yet visible to end users
// - published: form is active and can receive submissions
// - finished:  form is closed and no longer accepts new submissions
export const FORM_STATUS = Object.freeze({
  DRAFT: "draft",
  PUBLISHED: "published",
  FINISHED: "finished"
});

// Convenience array of all status string values, used for validation and checks.
// Object.freeze prevents accidental modification at runtime.
export const FORM_STATUSES = Object.freeze(Object.values(FORM_STATUS));