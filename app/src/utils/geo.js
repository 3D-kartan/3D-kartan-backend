// src/utils/geo.js
import { ValidationError } from "../app/errors.js";

function isFiniteNumber(value) {
  // Check that the value is a number and not NaN or Infinity.
  return typeof value === "number" && Number.isFinite(value);
}

export function normalizeLocation(input, { allowNull = true } = {}) {
  // Handle nullable location: either return null or require a value.
  if (input === null || input === undefined) {
    if (allowNull) return null;
    throw new ValidationError("location is required");
  }

  // Location must be a plain object (no arrays or primitives).
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("location must be an object");
  }

  // Coerce lon/lat to numbers so string inputs like "18.06" also work.
  const lon = Number(input.lon);
  const lat = Number(input.lat);

  // Both lon and lat must be finite numeric values.
  if (!isFiniteNumber(lon) || !isFiniteNumber(lat)) {
    throw new ValidationError("location.lon and location.lat must be finite numbers");
  }

  // Basic longitude bounds for WGS84 coordinates.
  if (lon < -180 || lon > 180) {
    throw new ValidationError("location.lon must be between -180 and 180");
  }

  // Basic latitude bounds for WGS84 coordinates.
  if (lat < -90 || lat > 90) {
    throw new ValidationError("location.lat must be between -90 and 90");
  }

  // Return a normalized object with numeric lon/lat.
  return { lon, lat };
}