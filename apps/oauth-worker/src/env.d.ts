/**
 * Secret bindings are deliberately absent from wrangler.jsonc, so Wrangler's
 * generated environment cannot infer them. Merge only their types here; values
 * are installed with `wrangler secret put` and never committed.
 */
interface Env {
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CALLBACK_RECEIPT_SECRET: string;
}
