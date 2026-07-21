/**
 * Pure field discovery helpers for the content script. Kept free of chrome.*
 * so unit tests can drive SPA re-render / detached-input behavior without a
 * full extension host.
 */

export interface PageFields {
  username?: HTMLInputElement;
  password?: HTMLInputElement;
  totp?: HTMLInputElement;
  newPassword?: HTMLInputElement;
}

/** True when the input is still in the live document and visibly painted. */
export function isLiveFillTarget(
  input: HTMLInputElement | null | undefined,
): input is HTMLInputElement {
  if (!input || !input.isConnected) return false;
  const rect = input.getBoundingClientRect();
  const style = getComputedStyle(input);
  return (
    rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  );
}

export function findFields(root: ParentNode = document): PageFields {
  const inputs = [...root.querySelectorAll<HTMLInputElement>('input')].filter(isLiveFillTarget);
  const password = inputs.find(
    (input) => input.type === 'password' && input.autocomplete !== 'new-password',
  );
  const newPassword = inputs.find(
    (input) => input.type === 'password' && input.autocomplete === 'new-password',
  );
  const totp = inputs.find(
    (input) =>
      input.autocomplete === 'one-time-code' ||
      /(?:otp|totp|one.?time|verification.?code)/i.test(`${input.name} ${input.id}`),
  );
  const username = inputs.find(
    (input) =>
      input.autocomplete === 'username' ||
      input.type === 'email' ||
      /(?:user|email|login)/i.test(`${input.name} ${input.id}`),
  );
  return { username, password, totp, newPassword };
}

/** Prefer a generated signup secret, falling back to the current-login field. */
export function passwordForSaveFromFields(fields: PageFields): string {
  return fields.newPassword?.value || fields.password?.value || '';
}

/**
 * Write only into still-connected, visible targets discovered at gesture time.
 * Returns which slots were actually written (detached SPA nodes are skipped).
 */
export function applyFillToLiveFields(
  fields: PageFields,
  material: {
    readonly username?: string;
    readonly password?: string;
    readonly totp?: string;
  },
  setValue: (input: HTMLInputElement, value: string) => void,
): { username: boolean; password: boolean; totp: boolean } {
  const wrote = { username: false, password: false, totp: false };
  if (isLiveFillTarget(fields.username) && material.username) {
    setValue(fields.username, material.username);
    wrote.username = true;
  }
  if (isLiveFillTarget(fields.password) && material.password) {
    setValue(fields.password, material.password);
    wrote.password = true;
  }
  if (isLiveFillTarget(fields.totp) && material.totp) {
    setValue(fields.totp, material.totp);
    wrote.totp = true;
  }
  return wrote;
}
