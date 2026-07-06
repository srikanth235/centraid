// The Import settings page (issue #290 phase 2) — the owner's file-drop
// surface over the staging spine. Drop a .ics / .vcf / .mbox / .csv / Takeout
// .zip; the gateway stages it into a draft batch with per-row dispositions
// (create / update / skip); the owner reviews the diff and publishes or
// discards. First contact with real data is always staged — publish is the
// deliberate second act.

import {
  vaultImportDiscard,
  vaultImportPublish,
  vaultImportRows,
  vaultImportStage,
  vaultImportsList,
  vaultStatus,
  type VaultImportBatch,
} from './gateway-client.js';
import { relativeTime } from './app-format.js';

export interface ImportPageInput {
  el: ElHelper;
  host: HTMLElement;
  showToast?: (message: string) => void;
}

const TEXT_KINDS = new Set(['ics', 'vcf', 'vcard', 'mbox', 'csv']);

function summaryLine(summary: Record<string, number>): string {
  const parts: string[] = [];
  for (const key of ['create', 'created', 'update', 'updated', 'skip', 'skipped'] as const) {
    const n = summary[key];
    if (typeof n === 'number' && n > 0) parts.push(`${n} ${key}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'empty';
}

/** Populate the Import pane. Re-renders itself after every act. */
export async function renderImportPage(input: ImportPageInput): Promise<void> {
  const { el, host } = input;
  const note = (text: string): HTMLElement => el('div', { class: 'cd-app-settings-note' }, text);
  const rerender = (): void => void renderImportPage(input);

  let status;
  try {
    status = await vaultStatus();
  } catch {
    status = undefined;
  }
  if (!host.isConnected) return;
  if (!status?.active) {
    host.replaceChildren(note('No vault is mounted on this gateway — nothing to import into.'));
    return;
  }

  // ── Drop zone ─────────────────────────────────────────────────────────
  const picker = el('input', {
    type: 'file',
    class: 'cd-import-file',
    accept: '.ics,.vcf,.vcard,.mbox,.csv,.zip',
  }) as HTMLInputElement;
  const pickBtn = el(
    'button',
    { class: 'cd-vault-grant-btn', type: 'button', onClick: () => picker.click() },
    'Choose a file…',
  );
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (!file) return;
    (pickBtn as HTMLButtonElement).disabled = true;
    const ext = file.name.split('.').at(-1)?.toLowerCase() ?? '';
    void (async () => {
      try {
        const payload = TEXT_KINDS.has(ext)
          ? { filename: file.name, text: await file.text() }
          : {
              filename: file.name,
              base64: btoa(
                Array.from(new Uint8Array(await file.arrayBuffer()), (b) =>
                  String.fromCharCode(b),
                ).join(''),
              ),
            };
        const staged = await vaultImportStage(payload);
        input.showToast?.(
          `Staged ${staged.total} row${staged.total === 1 ? '' : 's'} — review below`,
        );
        rerender();
      } catch (err) {
        (pickBtn as HTMLButtonElement).disabled = false;
        input.showToast?.(err instanceof Error ? err.message : 'Import failed');
      }
    })();
  });
  const dropSection = el('div', { class: 'cd-app-settings-section' }, [
    el('div', { class: 'cd-vault-label' }, `Import into · ${status.name}`),
    note(
      'Calendar (.ics), contacts (.vcf), mail (.mbox), bank statements (.csv) or a Google Takeout (.zip). Files stage as a reviewable draft — nothing lands until you publish.',
    ),
    el('div', { class: 'cd-vault-demo-actions' }, [pickBtn, picker]),
  ]);

  // ── Batches ───────────────────────────────────────────────────────────
  let batches: VaultImportBatch[] = [];
  try {
    batches = await vaultImportsList();
  } catch {
    host.replaceChildren(dropSection, note('Could not read the import surface.'));
    return;
  }
  if (!host.isConnected) return;

  const sections: HTMLElement[] = [dropSection];
  const drafts = batches.filter((b) => b.status === 'draft');
  const settled = batches.filter((b) => b.status !== 'draft').slice(0, 8);

  for (const batch of drafts) {
    sections.push(await renderDraft(input, batch, rerender));
  }
  if (settled.length > 0) {
    const history = el('div', { class: 'cd-app-settings-section' });
    history.append(el('div', { class: 'cd-vault-label' }, 'History'));
    for (const batch of settled) {
      history.append(
        el('div', { class: 'cd-import-history-row' }, [
          el('span', { class: 'cd-import-history-label' }, `${batch.label ?? batch.kind ?? '?'}`),
          el(
            'span',
            { class: 'cd-import-history-sub' },
            `${batch.status} · ${summaryLine(batch.summary)} · ${relativeTime(batch.createdAt)}`,
          ),
        ]),
      );
    }
    sections.push(history);
  }
  host.replaceChildren(...sections);
}

/** One draft batch: disposition summary, a bounded row preview, two acts. */
async function renderDraft(
  input: ImportPageInput,
  batch: VaultImportBatch,
  rerender: () => void,
): Promise<HTMLElement> {
  const { el } = input;
  const section = el('div', { class: 'cd-app-settings-section cd-import-draft' });
  section.append(
    el('div', { class: 'cd-vault-label' }, `Draft · ${batch.label ?? batch.kind ?? 'import'}`),
    el(
      'div',
      { class: 'cd-app-settings-note' },
      `${summaryLine(batch.summary)} · staged ${relativeTime(batch.createdAt)}`,
    ),
  );
  try {
    const rows = await vaultImportRows(batch.batchId);
    const preview = el('div', { class: 'cd-import-rows' });
    for (const row of rows.slice(0, 12)) {
      preview.append(
        el('div', { class: 'cd-import-row', 'data-disposition': row.disposition }, [
          el('span', { class: 'cd-import-row-disposition' }, row.disposition),
          el('span', { class: 'cd-import-row-id' }, `${row.entityType} · ${row.externalId}`),
          ...(row.note ? [el('span', { class: 'cd-import-row-note' }, row.note)] : []),
        ]),
      );
    }
    if (rows.length > 12) {
      preview.append(el('div', { class: 'cd-app-settings-note' }, `…and ${rows.length - 12} more`));
    }
    section.append(preview);
  } catch {
    section.append(el('div', { class: 'cd-app-settings-note' }, 'Could not load the rows.'));
  }

  const act = (label: string, run: () => Promise<unknown>, doneMsg: string): HTMLElement => {
    const btn = el(
      'button',
      { class: label === 'Publish' ? 'cd-vault-approve-btn' : 'cd-vault-deny-btn', type: 'button' },
      label,
    );
    btn.addEventListener('click', () => {
      (btn as HTMLButtonElement).disabled = true;
      run()
        .then(() => {
          input.showToast?.(doneMsg);
          rerender();
        })
        .catch((err: unknown) => {
          (btn as HTMLButtonElement).disabled = false;
          input.showToast?.(err instanceof Error ? err.message : `${label} failed`);
        });
    });
    return btn;
  };
  section.append(
    el('div', { class: 'cd-vault-parked-actions' }, [
      act('Publish', () => vaultImportPublish(batch.batchId), 'Import published'),
      act('Discard', () => vaultImportDiscard(batch.batchId), 'Draft discarded'),
    ]),
  );
  return section;
}
