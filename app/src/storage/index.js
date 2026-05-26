// src/storage/index.js
import config from "../app/config.js";
import { StorageError } from "../app/errors.js";
import * as fsStorage from "./forms.storage.fs.js";
import * as pgStorage from "./forms.storage.pg.js";

// List of all methods that every storage driver must implement.
// This acts as a simple runtime interface check for the selected driver.
const REQUIRED_METHODS = [
  "initStorage",
  "closeStorage",
  "listForms",
  "getFormById",
  "getPublicFormById",
  "createForm",
  "updateForm",
  "publishForm",
  "finishForm",
  "softDeleteForm",
  "getActiveFormVersion",
  "listFormVersions",
  "createDraftVersion",
  "createSubmission",
  "listSubmissions",
  "getSubmissionById"
];

// Select storage driver based on configuration.
// - "pg" -> PostgreSQL-backed implementation
// - anything else -> filesystem-based implementation (default)
const selectedStorage =
  config.storageDriver === "pg" ? pgStorage : fsStorage;

// Verify that the selected driver implements all required methods.
// Fail fast at startup if anything is missing, instead of at runtime.
for (const methodName of REQUIRED_METHODS) {
  if (typeof selectedStorage[methodName] !== "function") {
    throw new StorageError(
      `Selected storage driver is missing required method: ${methodName}`
    );
  }
}

// Export the selected driver as the default storage implementation
// so the rest of the app can use it without caring about the backend.
export default selectedStorage;