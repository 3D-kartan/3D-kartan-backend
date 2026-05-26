// hash-admin-password.js
import bcrypt from "bcrypt";

async function main() {
  // Read the plaintext password from the command line arguments.
  // Usage example:
  //   node scripts/hash-admin-password.js mySecretPassword
  const password = process.argv[2];

  // If no password is provided, print usage instructions and exit with error code.
  if (!password) {
    console.error('Usage: node scripts/hash-admin-password.js <password>');
    process.exit(1);
  }

  // Number of salt rounds for bcrypt. Higher = more secure but slower.
  const saltRounds = 12;

  // Generate a bcrypt hash of the provided password.
  const hash = await bcrypt.hash(password, saltRounds);

  // Output the resulting hash to stdout so it can be copied into configuration, DB, etc.
  console.log('Hash:', hash);
}

// Run the main function and catch any unexpected errors,
// ensuring the process exits with a non-zero code on failure.
main().catch(err => {
  console.error(err);
  process.exit(1);
});