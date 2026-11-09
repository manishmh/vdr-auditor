import { getConfig } from "../lib/config";

/**
 * Validate environment configuration without connecting anywhere.
 * Confirms MongoDB-only mode is selected (the only valid application
 * storage); prints a non-secret summary; exits non-zero on invalid config.
 * Never prints URIs, usernames, passwords, or tokens.
 */
try {
  // getConfig enforces STORAGE_BACKEND=mongodb for real environments, so
  // reaching this line confirms MongoDB-only mode is selected.
  const config = getConfig();
  console.log("config: valid (mongodb-only mode)");
  console.log(`  storage=${config.STORAGE_BACKEND} database=${config.MONGODB_DB}`);
  console.log(`  inference=${config.INFERENCE_PROVIDER} model=${config.BASETEN_MODEL_ID ?? "(mock)"}`);
  console.log(`  upload cap=${config.MAX_UPLOAD_BYTES} bytes pages=${config.MAX_PDF_PAGES}`);
  console.log(`  pilot gate=${config.PILOT_ACCESS_TOKEN ? "enabled" : "disabled"}`);
  console.log(`  frontend origin=${config.FRONTEND_ORIGIN ?? "http://localhost:3000 (dev default)"}`);
  console.log(`  api port=${config.PORT}`);
} catch (err) {
  console.error(`config: invalid: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
