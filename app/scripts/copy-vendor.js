// scripts/copy-vendor.js
// Copies the minified dist files from node_modules into public-admin/vendor/
// so that the admin pages can load them without any CDN dependency.
// Run with:  node scripts/copy-vendor.js
// Also runs automatically via the "postinstall" npm hook.

import { cpSync, mkdirSync } from "node:fs";

const VENDOR_DIR = "public-admin/vendor";

mkdirSync(VENDOR_DIR, { recursive: true });

const FILES = [
  ["bootstrap/dist/css/bootstrap.min.css",        "bootstrap.min.css"],
  ["formiojs/dist/formio.full.min.css",            "formio.full.min.css"],
  ["formiojs/dist/formio.full.min.js",             "formio.full.min.js"],
];

for (const [src, dest] of FILES) {
  cpSync(`node_modules/${src}`, `${VENDOR_DIR}/${dest}`);
  console.log(`Copied  ${dest}`);
}

// Font Awesome fonts are referenced by relative path from formio.full.min.css,
// so they must live in vendor/fonts/ to resolve correctly.
cpSync("node_modules/formiojs/dist/fonts", `${VENDOR_DIR}/fonts`, { recursive: true });
console.log("Copied  fonts/");

console.log("Vendor assets ready.");
