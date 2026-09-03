export interface AuthOptions {
  token?: string;
  env?: NodeJS.ProcessEnv;
}

export function resolveToken(opts: AuthOptions): string | undefined {
  if (opts.token && opts.token.trim() !== "") return opts.token.trim();
  const env = opts.env ?? process.env;
  return (
    env.CENTRAID_TOKEN?.trim() ||
    env.CENTRAID_GATEWAY_TOKEN?.trim() ||
    undefined
  );
}
