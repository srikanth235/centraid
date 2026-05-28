/*
 * `SecretsProvider` — the pluggable seam for reading secrets the gateway
 * runtime needs at request time.
 *
 * Today the only secret is the API key for the user's configured
 * OpenAI-compatible provider. The Electron host plugs in a safeStorage-
 * backed reader (OS keychain); the CLI daemon plugs in a filesystem-
 * backed one. The runtime never sees plaintext keys at construction
 * time — it asks the provider per turn, so a key rotation is picked up
 * without a restart.
 *
 * Returning `undefined` means "no key configured" — the runtime still
 * proceeds and the provider's first call surfaces the natural 401.
 */

export interface SecretsProvider {
  /**
   * Resolve the API key for the OpenAI-compatible provider currently
   * configured in user_prefs. Called per chat turn; implementations
   * should be cheap (an OS keychain read or a file decrypt).
   */
  getProviderApiKey(): Promise<string | undefined>;
}
