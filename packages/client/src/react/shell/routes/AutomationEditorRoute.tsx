import { type JSX, useRef } from 'react';
import {
  auth,
  createAutomation,
  deleteAutomation,
  getBlocking,
  listOutboxGrants,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
  updateAutomation,
} from '../../../gateway-client.js';
import type { AuEditorTriggerDTO, AutomationEditorData } from '../../screen-contracts.js';
import AutomationEditorScreen from '../../screens/AutomationEditorScreen.js';
import { useShellActions } from '../actions.js';
import PageScroll from '../PageScroll.js';
import { openWebhookReveal } from '../webhookReveal.js';
import { loadAutomationEditorData } from './automationEditorData.js';
import { deriveAutomationHero } from './automationsData.js';
import { decideConsentItem, filterConsentForAutomation } from './automationThreadData.js';

/** Load-side trigger shape → the editor DTO's display shape (webhook needs
 *  its minted id + pending flag so the Connectors tab can render the URL). */
function triggerToDto(t: CentraidAutomationRow['triggers'][number]): AuEditorTriggerDTO {
  switch (t.kind) {
    case 'webhook':
      return { id: t.id ?? null, kind: 'webhook', pending: !!t.pending };
    case 'cron':
      return { expr: t.expr, kind: 'cron' };
    case 'data':
      return {
        entities: [...t.entities],
        kind: 'data',
        ...(t.every ? { every: t.every } : {}),
      };
    case 'condition':
      return {
        entity: t.entity,
        kind: 'condition',
        ...(t.where !== undefined ? { where: t.where } : {}),
        ...(t.every ? { every: t.every } : {}),
      };
  }
}

// React-owned automation editor — the instructions-first create/edit form
// (Automations UI revamp, see receipts/issue-387-automations-ui-revamp.md). This is a real
// wrapper, not a stub: it wires `AutomationEditorScreen`'s full bridge-prop
// surface against `loadAutomationEditorData` + the existing
// create/update/enable/run/delete/webhook client fns, reusing
// `deriveAutomationHero`/`filterConsentForAutomation` so the webhook URL and
// standing-consent list are derived exactly once, the same way the thread
// does. Lane B (editor) owns this file going forward — the screen it renders
// is still the AutomationEditorScreen placeholder until Lane B lands the
// real form.
export default function AutomationEditorRoute({
  automationId,
  templateId,
}: {
  automationId?: string;
  templateId?: string;
}): JSX.Element {
  const { navigate, showToast, confirm } = useShellActions();
  // `refIdRef` is the automation's `ref` once it exists on the gateway —
  // `undefined` at mount for a brand-new create flow, set by `loadData` (edit
  // mode) or by `onSave`'s create-mode branch (first save mints the row).
  const refIdRef = useRef<string | null>(automationId ?? null);
  const rowRef = useRef<CentraidAutomationRow | null>(null);

  // `templateId` is accepted on the route but not consumed yet —
  // template-seeded creates still go through the clone path
  // (TemplatesRoute/DiscoverRoute adopt → thread). Pre-filling the editor
  // from a gallery template is out of scope for wave 1 (see
  // receipts/issue-387-automations-ui-revamp.md, Out of scope).
  void templateId;

  return (
    <PageScroll>
      <AutomationEditorScreen
        loadData={async (): Promise<AutomationEditorData> => {
          const loaded = await loadAutomationEditorData({ automationId });
          rowRef.current = loaded.row;
          refIdRef.current = loaded.row?.ref ?? automationId ?? null;
          if (!loaded.row) {
            return {
              automationId: null,
              connectors: null,
              consent: { grants: [], outbox: [], parked: [] },
              enabled: false,
              instructions: loaded.instructions,
              mode: 'create',
              model: null,
              name: loaded.name,
              onFailure: null,
              rowId: null,
              triggers: [],
              webhook: null,
            };
          }
          const [{ baseUrl }, blocking, grants] = await Promise.all([
            auth(),
            getBlocking(),
            listOutboxGrants(),
          ]);
          const hero = deriveAutomationHero(loaded.row, baseUrl);
          return {
            automationId: loaded.row.ref,
            connectors: loaded.connectors,
            consent: filterConsentForAutomation(loaded.row.name, blocking, grants),
            enabled: loaded.row.enabled,
            instructions: loaded.instructions,
            mode: 'edit',
            model: loaded.model,
            name: loaded.name,
            onFailure: loaded.onFailure,
            rowId: loaded.rowId,
            triggers: loaded.triggers.map(triggerToDto),
            webhook: hero.webhook,
          };
        }}
        onSave={async (fields) => {
          try {
            if (refIdRef.current) {
              const { row, webhook } = await updateAutomation({
                automationId: refIdRef.current,
                name: fields.name,
                prompt: fields.instructions,
                triggers: fields.triggers,
              });
              if (row) rowRef.current = row;
              // A `{kind:'webhook'}` trigger that didn't exist before mints a
              // fresh secret server-side, returned once — same one-time
              // reveal `onRotateWebhook` uses below (webhookReveal.ts).
              if (webhook) {
                await openWebhookReveal(webhook, {
                  note: "This secret is shown once. Copy it now — you won't see it again.",
                  title: 'Webhook minted',
                });
              }
              showToast(`Saved · ${fields.name}`);
              return true;
            }
            const id = `automation-${Math.random().toString(36).slice(2, 8)}`;
            const { row, webhook } = await createAutomation({
              enabled: false,
              id,
              name: fields.name,
              prompt: fields.instructions,
              triggers: fields.triggers,
            });
            if (row) {
              rowRef.current = row;
              refIdRef.current = row.ref;
            }
            if (webhook) {
              await openWebhookReveal(webhook, {
                note: "This secret is shown once. Copy it now — you won't see it again.",
                title: 'Webhook minted',
              });
            }
            showToast(`Created · ${fields.name}`);
            return true;
          } catch (err) {
            showToast(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onOpenBuilder={(seedMessage) => {
          // The builder route keys on the BARE app id (`row.id`), not the
          // compound `ref` — useBuilder compares it against `row.ownerApp`
          // and URL-encodes it as one path segment, so a ref's `/` 500s the
          // session route.
          const id = rowRef.current?.id;
          if (!id) return;
          navigate({
            automationId: id,
            kind: 'automation-builder',
            ...(seedMessage ? { seedMessage } : {}),
          });
        }}
        onRunNow={async () => {
          const ref = refIdRef.current;
          if (!ref) return false;
          try {
            const { runId } = await runAutomationNow({ automationId: ref });
            navigate({ automationId: ref, kind: 'run-view', runId });
            return true;
          } catch (err) {
            showToast(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onToggleEnabled={async (next) => {
          const ref = refIdRef.current;
          if (!ref) return false;
          try {
            await setAutomationEnabled({ automationId: ref, enabled: next });
            return true;
          } catch (err) {
            showToast(
              `Could not ${next ? 'enable' : 'disable'}: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        }}
        onDecideConsent={async (kind, id, decision, alwaysAllow) => {
          try {
            return await decideConsentItem({
              decision,
              id,
              kind,
              ...(alwaysAllow !== undefined ? { alwaysAllow } : {}),
            });
          } catch (err) {
            showToast(`Could not update: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onOpenRun={(runId) => {
          const ref = refIdRef.current;
          if (ref) navigate({ automationId: ref, kind: 'run-view', runId });
        }}
        onCopyWebhook={(url) =>
          void navigator.clipboard
            .writeText(url)
            .then(() => showToast('Webhook URL copied'))
            .catch(() => showToast('Could not copy to clipboard'))
        }
        onRotateWebhook={async () => {
          const ref = refIdRef.current;
          if (!ref) return false;
          const ok = await confirm({
            confirmLabel: 'Regenerate',
            danger: true,
            message:
              'This invalidates the current secret — any caller using it starts failing until updated. The webhook URL stays the same.',
            title: 'Regenerate webhook secret?',
          });
          if (!ok) return false;
          try {
            const { webhook } = await rotateAutomationWebhookSecret({ automationId: ref });
            await openWebhookReveal(webhook, {
              note: "This secret is shown once. Update your caller now — you won't see it again.",
              title: 'New webhook secret',
            });
            showToast('Webhook secret regenerated');
            return true;
          } catch (err) {
            showToast(
              `Could not regenerate secret: ${err instanceof Error ? err.message : String(err)}`,
            );
            return false;
          }
        }}
        onDelete={async () => {
          const ref = refIdRef.current;
          const row = rowRef.current;
          if (!ref || !row) return false;
          const ok = await confirm({
            confirmLabel: 'Delete',
            danger: true,
            message: `Delete "${row.name}"? This removes it from the gateway and deletes its run history. This can't be undone.`,
            title: 'Delete automation?',
          });
          if (!ok) return false;
          try {
            await deleteAutomation({ automationId: ref });
            showToast(`Deleted "${row.name}"`);
            navigate({ kind: 'automations' });
            return true;
          } catch (err) {
            showToast(`Could not delete: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onCancel={() =>
          navigate(
            refIdRef.current
              ? { automationId: refIdRef.current, kind: 'automation-view' }
              : { kind: 'automations' },
          )
        }
      />
    </PageScroll>
  );
}
