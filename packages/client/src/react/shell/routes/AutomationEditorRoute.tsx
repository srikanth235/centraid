import { type JSX, useRef } from 'react';
import {
  auth,
  compileAutomation,
  createAutomation,
  deleteAutomation,
  getBlocking,
  listAgents,
  listTemplates,
  listOutboxGrants,
  readAutomationSource,
  rotateAutomationWebhookSecret,
  runAutomationNow,
  setAutomationEnabled,
  listVaultEntityTypes,
  searchVaultEntities,
  updateAutomation,
} from '../../../gateway-client.js';
import type {
  AuEditorTriggerDTO,
  AuEditorTriggerInput,
  AutomationEditorData,
} from '../../screen-contracts.js';
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

/** The initial editor DTO for create mode (no existing row). Pure so the
 *  prefill contract — a `templateId` seeding a template trigger, or a
 *  `watchEntity` (an entity KIND, `schema.table`) seeding a data trigger that
 *  watches it — is unit-testable without a live gateway. A template's own
 *  trigger kind wins over `watchEntity` (a template is the more specific seed);
 *  with neither, the form opens trigger-less exactly as before. Mirrors how the
 *  screen already renders any data trigger in the DTO as a fully editable row,
 *  so a seeded `{ kind: 'data' }` needs zero screen changes (issue #446). */
export function buildCreateAutomationEditorData(opts: {
  template?: { name: string; desc: string; triggerKind?: 'cron' | 'webhook' };
  watchEntity?: string;
  instructions: string;
  name: string;
}): AutomationEditorData {
  const { template, watchEntity, instructions, name } = opts;
  const triggers: AuEditorTriggerDTO[] =
    template?.triggerKind === 'webhook'
      ? [{ id: null, kind: 'webhook', pending: true }]
      : template?.triggerKind === 'cron'
        ? [{ expr: '0 9 * * *', kind: 'cron' }]
        : watchEntity
          ? [{ entities: [watchEntity], kind: 'data' }]
          : [];
  return {
    automationId: null,
    connectors: null,
    consent: { grants: [], outbox: [], parked: [] },
    enabled: false,
    instructions: template?.desc ?? instructions,
    mode: 'create',
    model: null,
    name: template?.name ?? name,
    onFailure: null,
    rowId: null,
    triggers,
    webhook: null,
  };
}

export function vaultForTriggers(triggers: readonly (AuEditorTriggerDTO | AuEditorTriggerInput)[]) {
  const entities = triggers.flatMap((trigger) =>
    trigger.kind === 'condition'
      ? [trigger.entity]
      : trigger.kind === 'data'
        ? trigger.entities
        : [],
  );
  const scopes = Array.from(new Set(entities)).map((entity) => {
    const [schema, table] = entity.split('.', 2);
    return { schema: schema || entity, ...(table ? { table } : {}), verbs: 'read' };
  });
  return scopes.length > 0
    ? { purpose: 'dpv:ServiceProvision', why: 'Evaluate automation triggers.', scopes }
    : undefined;
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
// Canonical entity-type list is small and static per gateway — fetch once and
// reuse across every @-search keystroke.
let entityTypeCache: string[] | null = null;

export default function AutomationEditorRoute({
  automationId,
  templateId,
  watchEntity,
}: {
  automationId?: string;
  templateId?: string;
  watchEntity?: string;
}): JSX.Element {
  const { navigate, showToast, confirm } = useShellActions();
  // `refIdRef` is the automation's `ref` once it exists on the gateway —
  // `undefined` at mount for a brand-new create flow, set by `loadData` (edit
  // mode) or by `onSave`'s create-mode branch (first save mints the row).
  const refIdRef = useRef<string | null>(automationId ?? null);
  const rowRef = useRef<CentraidAutomationRow | null>(null);

  return (
    <PageScroll>
      <AutomationEditorScreen
        loadData={async (): Promise<AutomationEditorData> => {
          const loaded = await loadAutomationEditorData({ automationId });
          rowRef.current = loaded.row;
          refIdRef.current = loaded.row?.ref ?? automationId ?? null;
          if (!loaded.row) {
            const template = templateId
              ? (await listTemplates()).find((entry) => entry.id === templateId)
              : undefined;
            return buildCreateAutomationEditorData({
              ...(template ? { template } : {}),
              ...(watchEntity ? { watchEntity } : {}),
              instructions: loaded.instructions,
              name: loaded.name,
            });
          }
          const [{ baseUrl }, blocking, grants, agents] = await Promise.all([
            auth(),
            getBlocking(),
            listOutboxGrants(),
            listAgents(),
          ]);
          const hero = deriveAutomationHero(loaded.row, baseUrl);
          return {
            automationId: loaded.row.ref,
            connectors: loaded.connectors,
            consent: filterConsentForAutomation(
              agents.find((agent) => agent.hostKey === loaded.row?.ownerApp)?.agentId,
              blocking,
              grants,
            ),
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
                ...(vaultForTriggers(fields.triggers)
                  ? { vault: vaultForTriggers(fields.triggers) }
                  : {}),
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
              ...(vaultForTriggers(fields.triggers)
                ? { vault: vaultForTriggers(fields.triggers) }
                : {}),
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
        onCompile={async (enableOnSuccess) => {
          const ref = refIdRef.current;
          if (!ref) return false;
          try {
            await compileAutomation({ automationId: ref, enableOnSuccess });
            showToast('Compiling plan…');
            navigate({ automationId: ref, kind: 'automation-view' });
            return true;
          } catch (err) {
            showToast(`Could not compile: ${err instanceof Error ? err.message : String(err)}`);
            return false;
          }
        }}
        onSearchEntities={async (term) => {
          // Two kinds of tag: canonical entity TYPES (the domain model, e.g.
          // `core.event` — grant read scope on the kind) and specific
          // INSTANCES (a row found by full-text search). Types come first.
          if (entityTypeCache === null) {
            entityTypeCache = await listVaultEntityTypes().catch(() => []);
          }
          const q = term.toLowerCase();
          const typeHits = entityTypeCache
            .filter((name) => name.toLowerCase().includes(q))
            .slice(0, 6)
            .map((name) => ({ id: '*', subtitle: 'Domain model', title: name, type: name }));
          const instanceHits = await searchVaultEntities(term).catch(() => []);
          return [...typeHits, ...instanceHits];
        }}
        loadEntityTypes={async () => {
          // Same cached gateway read the @-mention type search uses — the
          // data/condition trigger editors' `<datalist>` autocomplete.
          if (entityTypeCache === null) {
            entityTypeCache = await listVaultEntityTypes().catch(() => []);
          }
          return entityTypeCache;
        }}
        onReadSource={async () => {
          const ref = refIdRef.current;
          if (!ref) return { manifest: null, handler: null };
          return readAutomationSource(ref);
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
