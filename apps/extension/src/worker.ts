import { ROUTES } from "@centraid/core/protocol";

import { handleCompanionRequest } from "./companion-api.js";
import { pageCaptureFromTab } from "./content-core.js";
import { clearFillMaterial, clearSavedPassword } from "./credential-gesture.js";
import { isLocked, loadPairing } from "./storage.js";
import { companionJson } from "./transport.js";
import type { CompanionRequest, PageCapture } from "./types.js";
import {
  approvalBadgeForState,
  isLockerFillMessage,
  shouldCaptureContextMenu,
} from "./worker-core.js";

const APPROVAL_ALARM = "centraid-companion-approvals";

function request(
  message: unknown,
  sender: ChromeMessageSender
): Promise<unknown> {
  return handleCompanionRequest(message as CompanionRequest, sender);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void request(message, sender).then(
    (value) => {
      sendResponse({ ok: true, value });
      if (isLockerFillMessage(message)) {
        clearFillMaterial(value);
      }
      clearSavedPassword(message);
    },
    (error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      clearSavedPassword(message);
    }
  );
  return true;
});

async function warmTab(tabId: number): Promise<void> {
  if (!(await loadPairing())) return;
  await handleCompanionRequest({ type: "warm" }, {}).catch(() => undefined);
  await chrome.tabs
    .sendMessage(tabId, { type: "centraid:warm" })
    .catch(() => undefined);
}

chrome.tabs.onActivated.addListener(({ tabId }) => void warmTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "complete") void warmTab(tabId);
});

async function updateApprovalBadge(): Promise<void> {
  const paired = !!(await loadPairing());
  const locked = await isLocked();
  if (!paired || locked) {
    await chrome.action.setBadgeText({
      text: approvalBadgeForState({ paired, locked }),
    });
    return;
  }
  try {
    const { count } = await companionJson<{ count: number }>(
      ROUTES.vaultBlocking
    );
    await chrome.action.setBadgeBackgroundColor({ color: "#315cf5" });
    await chrome.action.setBadgeText({
      text: approvalBadgeForState({ paired: true, locked: false, count }),
    });
  } catch {
    await chrome.action.setBadgeText({
      text: approvalBadgeForState({
        paired: !!(await loadPairing()),
        locked: false,
        unreachable: true,
      }),
    });
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === APPROVAL_ALARM) void updateApprovalBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(APPROVAL_ALARM, { periodInMinutes: 1 });
  chrome.contextMenus.create({
    id: "centraid-quick-task",
    title: "Capture in Centraid Tasks",
    contexts: ["page", "selection", "link"],
  });
  void updateApprovalBadge();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    !shouldCaptureContextMenu({ menuItemId: info.menuItemId, tabUrl: tab?.url })
  )
    return;
  const capture: PageCapture = pageCaptureFromTab({
    title: tab?.title,
    url: tab!.url!,
    selectionText: info.selectionText,
  });
  void handleCompanionRequest({ type: "capture:task", capture }, {}).catch(
    () => undefined
  );
});
