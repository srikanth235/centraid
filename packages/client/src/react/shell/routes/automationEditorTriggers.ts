import type { AuEditorTriggerDTO, AuEditorTriggerInput } from '../../screen-contracts.js';

/** Convert persisted automation triggers into the editor's display shape. */
export function triggerToDto(
  trigger: CentraidAutomationRow['triggers'][number],
): AuEditorTriggerDTO {
  switch (trigger.kind) {
    case 'webhook':
      return { id: trigger.id ?? null, kind: 'webhook', pending: !!trigger.pending };
    case 'cron':
      return { expr: trigger.expr, kind: 'cron', ...(trigger.tz ? { tz: trigger.tz } : {}) };
    case 'data':
      return {
        entities: [...trigger.entities],
        kind: 'data',
        ...(trigger.every ? { every: trigger.every } : {}),
      };
    case 'condition':
      return {
        entity: trigger.entity,
        kind: 'condition',
        ...(trigger.where === undefined ? {} : { where: trigger.where }),
        ...(trigger.every ? { every: trigger.every } : {}),
      };
    case 'event':
      return {
        connectorKind: trigger.connectorKind,
        event: trigger.event,
        filter: trigger.filter ? { ...trigger.filter } : undefined,
        kind: 'event',
        ...(trigger.every ? { every: trigger.every } : {}),
      };
  }
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
    return {
      schema: schema || entity,
      ...(table ? { table } : {}),
      verbs: 'read',
    };
  });
  return scopes.length > 0
    ? {
        purpose: 'dpv:ServiceProvision',
        why: 'Evaluate automation triggers.',
        scopes,
      }
    : undefined;
}
