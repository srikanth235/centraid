import { isEligiblePageUrl, matchesOrigin } from './origin-matching.js';
import { closeTransport, appRead, appWrite, companionJson, pairOverIroh } from './transport.js';
import { decodePairingTicket } from './ticket.js';
import { isLocked, loadPairing, purgeCompanionState, savePairing, setLocked } from './storage.js';
import type {
  CompanionModule,
  CompanionRequest,
  FillMaterial,
  LockerCandidate,
  ModuleStatus,
  PairingState,
} from './types.js';
import { COMPANION_MODULE_CATALOG } from './types.js';
import { anchoredCaptureText, documentCaptureTitle } from './capture.js';

interface CompanionModulesResponse {
  modules?: Array<{ id: CompanionModule; state: ModuleStatus['state'] }>;
}

function asOrigin(raw: string): string | undefined {
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

export function assertTopFramePage(message: CompanionRequest, sender: ChromeMessageSender): void {
  if (!message.type.startsWith('locker:')) return;
  const pageUrl = 'pageUrl' in message ? message.pageUrl : undefined;
  if (sender.frameId !== 0 || !pageUrl || !sender.tab?.url) {
    throw new Error('Locker requests are accepted only from a top-level page.');
  }
  if (asOrigin(pageUrl) !== asOrigin(sender.tab.url)) {
    throw new Error('The requested Locker origin does not match the active page.');
  }
  if (!isEligiblePageUrl(pageUrl)) {
    throw new Error('Locker is available only on HTTPS pages and local development origins.');
  }
}

async function requireReady(): Promise<PairingState> {
  const pairing = await loadPairing();
  if (!pairing) throw new Error('Pair this browser with Centraid first.');
  if (await isLocked()) throw new Error('Centraid Companion is locked.');
  return pairing;
}

async function pair(
  ticketText: string,
  deviceName: string | undefined,
  grantProfile: readonly CompanionModule[],
): Promise<PairingState> {
  const ticket = decodePairingTicket(ticketText);
  if (!ticket) throw new Error('This is not a Centraid pairing code.');
  if (ticket.expiresAt && ticket.expiresAt <= Date.now())
    throw new Error('This pairing code expired.');
  await closeTransport();
  const { endpointId, response } = await pairOverIroh({
    endpointTicket: ticket.endpointTicket,
    ticketId: ticket.ticketId,
    secret: ticket.secret,
    deviceName: deviceName?.trim() || 'Centraid Companion',
    grantProfile,
  });
  if (
    response['ok'] !== true ||
    typeof response['vaultId'] !== 'string' ||
    typeof response['enrollmentId'] !== 'string'
  ) {
    throw new Error(
      typeof response['error'] === 'string' ? response['error'] : 'The gateway rejected pairing.',
    );
  }
  const state: PairingState = {
    endpointTicket: ticket.endpointTicket,
    endpointId,
    enrollmentId: response['enrollmentId'],
    vaultId: response['vaultId'],
    pairedAt: new Date().toISOString(),
    grantProfile,
    ...(typeof response['gatewayId'] === 'string' ? { gatewayId: response['gatewayId'] } : {}),
    ...(typeof response['gatewayName'] === 'string'
      ? { gatewayName: response['gatewayName'] }
      : {}),
    ...(typeof response['vaultName'] === 'string' ? { vaultName: response['vaultName'] } : {}),
    ...(ticket.relayUrls ? { relayUrls: ticket.relayUrls } : {}),
  };
  await Promise.all([savePairing(state), setLocked(false)]);
  return state;
}

export async function moduleStatuses(): Promise<ModuleStatus[]> {
  await requireReady();
  const response = await companionJson<CompanionModulesResponse>('/centraid/_vault/apps');
  const byId = new Map((response.modules ?? []).map((module) => [module.id, module.state]));
  return COMPANION_MODULE_CATALOG.map((module) => ({
    ...module,
    state: byId.get(module.id) ?? 'unavailable',
  }));
}

async function candidates(pageUrl: string): Promise<LockerCandidate[]> {
  await requireReady();
  const response = await appRead<{ candidates?: LockerCandidate[] }>(
    'locker',
    'autofill-candidates',
  );
  return (response.candidates ?? []).filter((candidate) => matchesOrigin(candidate, pageUrl));
}

async function fill(itemId: string, pageUrl: string): Promise<FillMaterial> {
  await requireReady();
  const allowed = await candidates(pageUrl);
  if (!allowed.some((candidate) => candidate.item_id === itemId)) {
    throw new Error('That login is not authorized for this origin.');
  }
  const response = await appRead<{ fill?: FillMaterial }>('locker', 'autofill-item', {
    item_id: itemId,
    page_origin: new URL(pageUrl).origin,
  });
  if (!response.fill) throw new Error('The login could not be revealed.');
  return response.fill;
}

function pngBytes(dataUri: string): ArrayBuffer {
  const prefix = 'data:image/png;base64,';
  if (!dataUri.startsWith(prefix)) throw new Error('The tab capture was not a PNG image.');
  const bytes = Uint8Array.from(atob(dataUri.slice(prefix.length)), (char) => char.charCodeAt(0));
  return bytes.buffer as ArrayBuffer;
}

export async function handleCompanionRequest(
  message: CompanionRequest,
  sender: ChromeMessageSender,
): Promise<unknown> {
  assertTopFramePage(message, sender);
  switch (message.type) {
    case 'status': {
      const pairing = await loadPairing();
      return { paired: Boolean(pairing), locked: await isLocked(), pairing };
    }
    case 'pair':
      return pair(message.ticket, message.deviceName, message.grants);
    case 'unpair': {
      const pairing = await loadPairing();
      if (!pairing) return { ok: true };
      try {
        await companionJson(
          `/centraid/_gateway/devices/${encodeURIComponent(pairing.enrollmentId)}`,
          { method: 'DELETE' },
        );
      } catch (error) {
        // A lost success response can surface as the server's subsequent 401;
        // companionJson already purged that now-revoked identity.
        if (!(await loadPairing())) return { ok: true };
        throw error;
      }
      await closeTransport();
      await purgeCompanionState();
      return { ok: true };
    }
    case 'lock':
      await closeTransport();
      await setLocked(true);
      return { ok: true };
    case 'unlock':
      await setLocked(false);
      await requireReady();
      return { ok: true };
    case 'warm':
      await requireReady();
      await companionJson('/centraid/_vault/status');
      return { ok: true };
    case 'modules':
      return moduleStatuses();
    case 'blocking-count':
      await requireReady();
      return companionJson<{ count: number }>('/centraid/_vault/blocking');
    case 'locker:candidates': {
      const result = await candidates(message.pageUrl);
      if (sender.tab?.id) {
        if (result.some((candidate) => candidate.warning)) {
          await chrome.action.setBadgeBackgroundColor({ color: '#b42318' });
          await chrome.action.setBadgeText({ text: 'W', tabId: sender.tab.id });
        } else {
          // Clear a prior Watchtower badge when this tab no longer has warnings.
          await chrome.action.setBadgeText({ text: '', tabId: sender.tab.id });
        }
      }
      return result;
    }
    case 'locker:fill':
      return fill(message.itemId, message.pageUrl);
    case 'locker:save':
      await requireReady();
      return appWrite('locker', 'add-item', {
        type: 'login',
        title: message.title,
        username: message.username ?? '',
        password: message.password,
        url: new URL(message.pageUrl).origin,
        url_match_policy: 'registrable-domain',
      });
    case 'capture:task':
      await requireReady();
      return appWrite('tasks', 'add', {
        title: message.capture.selection?.trim() || message.capture.title || message.capture.url,
        description: anchoredCaptureText(message.capture),
      });
    case 'capture:note':
      await requireReady();
      return appWrite('notes', 'create-note', {
        title: message.capture.title || message.capture.url,
        body_text: anchoredCaptureText(message.capture),
        format: 'markdown',
      });
    case 'capture:document': {
      await requireReady();
      const staged = await companionJson<{ sha256?: string }>(
        '/centraid/_vault/blobs?filename=web-capture.png&media_type=image%2Fpng',
        {
          method: 'POST',
          headers: { 'content-type': 'image/png' },
          body: pngBytes(message.screenshot),
        },
      );
      if (!staged.sha256) throw new Error('The screenshot could not be staged.');
      return appWrite('docs', 'upload', {
        title: documentCaptureTitle(message.capture),
        staged_sha: staged.sha256,
      });
    }
    case 'agenda:add':
      await requireReady();
      return appWrite('agenda', 'propose', {
        summary: message.summary,
        dtstart: message.start,
        dtend: message.end,
        calendar_id: message.calendarId,
      });
    case 'people:add':
      await requireReady();
      return appWrite('people', 'add-person', {
        display_name: message.displayName,
        cadence_days: message.cadenceDays,
        ...(message.role ? { role: message.role } : {}),
      });
    case 'page:capture':
      return undefined;
  }
}
