// Outcome narration + the vault write trampoline (shared pattern across
// apps). No domain (asset/album) state lives here — it's generic plumbing,
// which is exactly why every action module and every component that needs to
// fire a command imports it directly instead of threading it through props.
import { outcomeMessage } from './kit.ts';
import { $ } from './dom.ts';

export function notice(text: string): void {
  const el = $('noticeBanner');
  el.textContent = text;
  el.hidden = !text;
}

export function narrate(
  outcome: VaultOutcome | null | undefined,
  noteEl?: HTMLElement | null,
): boolean {
  if (outcome?.status === 'executed') {
    notice('');
    if (noteEl) noteEl.textContent = '';
    return true;
  }
  const msg = outcomeMessage(outcome);
  if (msg != null) {
    notice(msg);
    if (noteEl) noteEl.textContent = msg;
  }
  return false;
}

export async function act(
  action: string,
  input?: Record<string, unknown>,
): Promise<VaultOutcome | undefined> {
  try {
    return await window.centraid.write({ action, input });
  } catch (err) {
    const e = err as { message?: string };
    notice(String(e?.message ?? err));
    return undefined;
  }
}
