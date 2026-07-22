import { ROUTES } from '@centraid/protocol';
import { handleCompanionRequest } from './companion-api.js';
import { companionJson } from './transport.js';
import { isLocked, loadPairing } from './storage.js';
import type { CompanionRequest, PageCapture } from './types.js';
import { clearFillMaterial, clearSavedPassword } from './credential-gesture.js';

const APPROVAL_ALARM = 'centraid-companion-approvals';

function request(message: unknown, sender: ChromeMessageSender): Promise<unknown> {
  return handleCompanionRequest(message as CompanionRequest, sender);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void request(message, sender).then(
    (value) => {
      sendResponse({ ok: true, value });
      if ((message as { type?: string } | undefined)?.type === 'locker:fill') {
        clearFillMaterial(value);
      }
      clearSavedPassword(message);
    },
    (error) => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      clearSavedPassword(message);
    },
  );
  return true;
});

async function warmTab(tabId: number): Promise<void> {
  if (!(await loadPairing())) return;
  await handleCompanionRequest({ type: 'warm' }, {}).catch(() => undefined);
  await chrome.tabs.sendMessage(tabId, { type: 'centraid:warm' }).catch(() => undefined);
}

chrome.tabs.onActivated.addListener(({ tabId }) => void warmTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') void warmTab(tabId);
});

async function updateApprovalBadge(): Promise<void> {
  if (!(await loadPairing()) || (await isLocked())) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  try {
    const { count } = await companionJson<{ count: number }>(ROUTES.vaultBlocking);
    await chrome.action.setBadgeBackgroundColor({ color: '#315cf5' });
    await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : '' });
  } catch {
    await chrome.action.setBadgeText({ text: (await loadPairing()) ? '!' : '' });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === APPROVAL_ALARM) void updateApprovalBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(APPROVAL_ALARM, { periodInMinutes: 1 });
  chrome.contextMenus.create({
    id: 'centraid-quick-task',
    title: 'Capture in Centraid Tasks',
    contexts: ['page', 'selection', 'link'],
  });
  void updateApprovalBadge();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'centraid-quick-task' || !tab?.url) return;
  const capture: PageCapture = {
    title: tab.title ?? tab.url,
    url: tab.url,
    ...(info.selectionText ? { selection: info.selectionText } : {}),
  };
  void handleCompanionRequest({ type: 'capture:task', capture }, {}).catch(() => undefined);
});
