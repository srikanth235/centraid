import type { CompanionRequest, FillMaterial, LockerCandidate, PageCapture } from './types.js';
import {
  clearFillMaterial,
  isTrustedCredentialGesture,
  passwordForSave,
} from './credential-gesture.js';
import { applyFillToLiveFields, findFields, isLiveFillTarget } from './page-fields.js';

if (window.top === window.self && window.isSecureContext) installCompanion();

interface CompanionEnvelope<T> {
  readonly ok: boolean;
  readonly value?: T;
  readonly error?: string;
}

async function send<T>(message: CompanionRequest): Promise<T> {
  const envelope = (await chrome.runtime.sendMessage(message)) as CompanionEnvelope<T> | undefined;
  if (!envelope?.ok) throw new Error(envelope?.error ?? 'Centraid request failed.');
  return envelope.value as T;
}

function nativeSet(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Unbiased charset sampling (rejection sampling over crypto.getRandomValues). */
function randomPassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*';
  const out: string[] = [];
  // Largest multiple of alphabet.length that fits in a uint32 bucket.
  const bound = Math.floor(0x1_0000_0000 / alphabet.length) * alphabet.length;
  while (out.length < length) {
    const values = new Uint32Array(length - out.length);
    crypto.getRandomValues(values);
    for (const value of values) {
      if (value >= bound) continue;
      out.push(alphabet[value % alphabet.length]!);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

function installCompanion(): void {
  let mountedFor: HTMLInputElement | undefined;
  let host: HTMLElement | undefined;
  // Closed shadow keeps page script from inspecting titles/usernames.
  let shadow: ShadowRoot | undefined;

  const remove = (): void => {
    host?.remove();
    host = undefined;
    shadow = undefined;
    mountedFor = undefined;
  };

  const mount = async (): Promise<void> => {
    const fields = findFields();
    const anchor = fields.password ?? fields.totp ?? fields.newPassword;
    if (!anchor || anchor === mountedFor) return;
    const status = await send<{
      paired: boolean;
      locked: boolean;
      pairing?: { grantProfile?: readonly string[] };
    }>({ type: 'status' }).catch(() => undefined);
    if (
      !status?.paired ||
      status.locked ||
      (status.pairing?.grantProfile && !status.pairing.grantProfile.includes('locker'))
    ) {
      remove();
      return;
    }
    remove();
    mountedFor = anchor;
    host = document.createElement('div');
    host.dataset['centraidCompanion'] = 'true';
    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>
      :host{all:initial}.wrap{position:relative;font:13px/1.35 ui-sans-serif,system-ui;color:#172033}
      button{font:inherit;border:1px solid #d7dbe5;background:#fff;color:#172033;border-radius:8px;padding:6px 10px;cursor:pointer;box-shadow:0 4px 18px #18233c1a}
      button:hover{border-color:#315cf5}.menu{position:absolute;z-index:2147483647;right:0;top:34px;width:270px;background:#fff;border:1px solid #d7dbe5;border-radius:12px;padding:7px;box-shadow:0 16px 45px #18233c30}
      .item{display:block;width:100%;text-align:left;border:0;box-shadow:none;padding:9px}.title{font-weight:650}.meta{display:block;color:#667085;font-size:12px;margin-top:2px}.empty{padding:10px;color:#667085}
    </style><div class="wrap"><button class="trigger" type="button">Centraid</button></div>`;
    const wrap = shadow.querySelector<HTMLElement>('.wrap');
    const trigger = shadow.querySelector<HTMLButtonElement>('.trigger');
    anchor.after(host);
    trigger?.addEventListener('click', (event) => {
      if (!isTrustedCredentialGesture(event)) return;
      // Re-resolve fields at gesture time — SPA re-renders detach mount-time nodes.
      void showMenu(wrap);
    });
  };

  async function showMenu(wrap: HTMLElement | null): Promise<void> {
    if (!wrap) return;
    wrap.querySelector('.menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.innerHTML = '<div class="empty">Checking this origin…</div>';
    wrap.append(menu);
    try {
      const candidates = await send<LockerCandidate[]>({
        type: 'locker:candidates',
        pageUrl: location.href,
      });
      menu.replaceChildren();
      for (const candidate of candidates) {
        const button = document.createElement('button');
        button.className = 'item';
        button.type = 'button';
        button.innerHTML = `<span class="title"></span><span class="meta"></span>`;
        const title = button.querySelector<HTMLElement>('.title');
        const meta = button.querySelector<HTMLElement>('.meta');
        if (title) title.textContent = candidate.title;
        if (meta) {
          meta.textContent = `${candidate.username || 'Login'}${
            candidate.warning ? ' · Watchtower warning' : ''
          }`;
        }
        button.addEventListener('click', (event) => {
          if (!isTrustedCredentialGesture(event)) return;
          void fillCandidate(candidate, menu);
        });
        menu.append(button);
      }
      // Re-check live fields for save/generate affordances (SPA may have swapped inputs).
      const live = findFields();
      if (passwordForSave(live)) {
        const save = document.createElement('button');
        save.className = 'item';
        save.type = 'button';
        save.textContent = 'Save this login in Centraid';
        save.addEventListener('click', (event) => {
          if (!isTrustedCredentialGesture(event)) return;
          const gestureFields = findFields();
          let password = passwordForSave(gestureFields);
          const username = isLiveFillTarget(gestureFields.username)
            ? gestureFields.username.value
            : undefined;
          void send({
            type: 'locker:save',
            pageUrl: location.href,
            title: document.title || location.hostname,
            ...(username ? { username } : {}),
            password,
          })
            .then(() => menu.remove())
            .finally(() => {
              password = '';
            });
        });
        menu.append(save);
      }
      if (isLiveFillTarget(live.newPassword)) {
        const generate = document.createElement('button');
        generate.className = 'item';
        generate.type = 'button';
        generate.textContent = 'Generate a strong password';
        generate.addEventListener('click', (event) => {
          if (!isTrustedCredentialGesture(event)) return;
          const gestureFields = findFields();
          if (!isLiveFillTarget(gestureFields.newPassword)) return;
          let password = randomPassword();
          nativeSet(gestureFields.newPassword, password);
          const confirmation = [...document.querySelectorAll<HTMLInputElement>('input')].find(
            (input) =>
              input !== gestureFields.newPassword &&
              isLiveFillTarget(input) &&
              input.type === 'password' &&
              input.autocomplete === 'new-password',
          );
          if (confirmation) nativeSet(confirmation, password);
          password = '';
          void showMenu(wrap);
        });
        menu.append(generate);
      }
      if (!menu.childElementCount)
        menu.innerHTML = '<div class="empty">No login for this origin</div>';
    } catch (error) {
      menu.innerHTML = `<div class="empty"></div>`;
      const empty = menu.querySelector<HTMLElement>('.empty');
      if (empty) empty.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function fillCandidate(candidate: LockerCandidate, menu: HTMLElement): Promise<void> {
    const material = await send<FillMaterial>({
      type: 'locker:fill',
      itemId: candidate.item_id,
      pageUrl: location.href,
    });
    try {
      // Gesture-time re-resolution: never write into mount-time detached nodes.
      applyFillToLiveFields(findFields(), material, nativeSet);
      menu.remove();
    } finally {
      clearFillMaterial(material);
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    const type = (message as { type?: string } | undefined)?.type;
    if (type === 'centraid:warm') void mount();
    if (type === 'page:capture') {
      const capture: PageCapture = {
        title: document.title,
        url: location.href,
        ...(getSelection()?.toString().trim()
          ? { selection: getSelection()!.toString().trim() }
          : {}),
      };
      respond(capture);
    }
  });

  const observer = new MutationObserver(() => void mount());
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('focusin', () => void mount());
  void send({ type: 'warm' }).catch(() => undefined);
  void mount();
}
