export interface PairingState {
  readonly endpointTicket: string;
  readonly endpointId: string;
  readonly enrollmentId: string;
  readonly gatewayId?: string;
  readonly gatewayName?: string;
  readonly vaultId: string;
  readonly vaultName?: string;
  readonly pairedAt: string;
  readonly relayUrls?: readonly string[];
  readonly grantProfile: readonly CompanionModule[];
}

export const COMPANION_MODULE_CATALOG = [
  { id: 'locker', name: 'Locker autofill' },
  { id: 'tasks', name: 'Tasks capture' },
  { id: 'notes', name: 'Notes clipper' },
  { id: 'docs', name: 'Docs screenshots' },
  { id: 'agenda', name: 'Agenda quick-add' },
  { id: 'people', name: 'People capture' },
] as const;

export type CompanionModule = (typeof COMPANION_MODULE_CATALOG)[number]['id'];

export interface ModuleStatus {
  readonly id: CompanionModule;
  readonly name: string;
  readonly state: 'granted' | 'parked' | 'revoked' | 'unavailable' | 'paused';
}

export interface LockerCandidate {
  readonly item_id: string;
  readonly title: string;
  readonly username?: string;
  readonly url: string;
  readonly url_match_policy: 'registrable-domain' | 'exact-host';
  readonly has_totp: boolean;
  readonly compromised?: boolean;
  readonly warning?: boolean;
}

export interface FillMaterial {
  readonly username?: string;
  readonly password?: string;
  readonly totp?: string;
  readonly receipt_id?: string;
}

export interface PageCapture {
  readonly title: string;
  readonly url: string;
  readonly selection?: string;
}

export type CompanionRequest =
  | { type: 'status' }
  | { type: 'pair'; ticket: string; deviceName?: string; grants: CompanionModule[] }
  | { type: 'unpair' }
  | { type: 'lock' }
  | { type: 'unlock' }
  | { type: 'warm' }
  | { type: 'modules' }
  | { type: 'blocking-count' }
  | { type: 'locker:candidates'; pageUrl: string }
  | { type: 'locker:fill'; itemId: string; pageUrl: string }
  | { type: 'locker:save'; pageUrl: string; title: string; username?: string; password: string }
  | { type: 'capture:task'; capture: PageCapture }
  | { type: 'capture:note'; capture: PageCapture }
  | { type: 'capture:document'; capture: PageCapture; screenshot: string }
  | { type: 'agenda:add'; summary: string; start: string; end: string; calendarId: string }
  | { type: 'people:add'; displayName: string; cadenceDays: number; role?: string }
  | { type: 'page:capture' };
