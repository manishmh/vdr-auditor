import { getConfig } from "../lib/config";

/**
 * Validate environment configuration without connecting anywhere.
 * Prints a non-secret summary; exits non-zero on invalid config.
 */
try {
  const config = getConfig();
  console.log("config: valid");
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
