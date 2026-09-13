/*
 * The Companion's service worker: one native port, no network (#1020 wave 4
 * lane extension).
 *
 * v0's worker starts a WASM iroh endpoint and dials the gateway
 * (`apps/extension/src/transport.ts`). This one does neither. It opens a
 * native-messaging port to `dev.centraid.host` — `centraid native-host`, the
 * same binary the desktop runs — and that host connects to the seat socket as
 * any other local client, passing the same peer check. The extension therefore
 * has **no** `host_permissions` and nothing to reach: if Centraid is not running
 * on this machine, the Companion says so and does nothing.
 *
 * Everything decidable is in `host-link.ts`, `worker-core.ts`, `page-origin.ts`
 * and `stage-core.ts`; this file is the `chrome.*` surface, kept as thin as the
 * desktop's `preload.ts` and for the same reason.
 */

import { clearSavedPassword } from "./credential-gesture.js";
import { HostLink, IDLE_CLOSE_MS, memberSentence } from "./host-link.js";
import type { HostFrame } from "./host-link.js";
import { stagesBytes } from "./methods.js";
import { lockerGestureRefusal } from "./page-origin.js";
import {
  chunkFrames,
  dataUriBytes,
  needsStaging,
  sha256Hex,
} from "./stage-core.js";
import {
  APPROVAL_ALARM,
  APPROVAL_ALARM_MINUTES,
  approvalBadgeColor,
  approvalBadgeForState,
  badgeCountOf,
  isLockerFillMessage,
  pageCaptureFromTab,
  shouldCaptureContextMenu,
} from "./worker-core.js";

declare const chrome: {
  runtime: {
    connectNative: (name: string) => never;
    lastError?: { message?: string };
    onMessage: {
      addListener: (
        fn: (
          message: unknown,
          sender: { frameId?: number; tab?: { id?: number; url?: string } },
          respond: (answer: unknown) => void
        ) => boolean | undefined
      ) => void;
    };
    onInstalled: { addListener: (fn: () => void) => void };
  };
  action: {
    setBadgeText: (details: { text: string; tabId?: number }) => Promise<void>;
    setBadgeBackgroundColor: (details: { color: string }) => Promise<void>;
  };
  alarms: {
    create: (name: string, options: { periodInMinutes: number }) => void;
    onAlarm: { addListener: (fn: (alarm: { name: string }) => void) => void };
  };
  contextMenus: {
    create: (options: {
      id: string;
      title: string;
      contexts: string[];
    }) => void;
    onClicked: {
      addListener: (
        fn: (
          info: { menuItemId: string | number; selectionText?: string },
          tab?: { url?: string; title?: string }
        ) => void
      ) => void;
    };
  };
};

/** The one link. Opened on first use, closed when idle. */
const link = new HostLink({
  connect: (name) => chrome.runtime.connectNative(name),
  now: () => Date.now(),
  onPush: (frame) => void drawBadge(frame),
});

/** Whether this browser has ever seen the app answer. */
let paired = false;

async function drawBadge(frame: HostFrame | undefined): Promise<void> {
  const count = badgeCountOf(frame);
  const text = approvalBadgeForState({
    paired,
    locked: false,
    count,
    unreachable: count === undefined,
  });
  await chrome.action.setBadgeBackgroundColor({
    color: approvalBadgeColor(text),
  });
  await chrome.action.setBadgeText({ text });
}

/** Poll the badge. The fallback half of the staleness contract (D-1020-X4). */
async function pollBadge(): Promise<void> {
  try {
    const value = await link.ask("blocking-count");
    paired = true;
    await drawBadge({ t: "ok", value });
  } catch {
    await drawBadge(undefined);
  } finally {
    // CLOSED WHEN IDLE: a poll that woke the worker must not leave a host
    // process holding a capability token until the browser quits.
    if (link.idleFor(IDLE_CLOSE_MS)) link.close();
  }
}

/**
 * `capture:document` and `page:capture` with bytes: stage, then send the handle.
 *
 * The decision is by SIZE, not by method: a small capture rides one frame and a
 * large one is staged, and neither side has to guess which (`stage-core.ts`).
 */
async function stagedCapture(
  method: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const screenshot = input["screenshot"];
  if (typeof screenshot !== "string") return await link.ask(method, input);
  const read = dataUriBytes(screenshot, "image/png");
  if (!read) throw new Error("The tab capture was not a PNG image.");
  if (!needsStaging(read.bytes.length)) return await link.ask(method, input);
  const sha256 = await sha256Hex(read.bytes);
  const begun = (await link.send({
    t: "stage:begin",
    media_type: read.mediaType,
    byte_size: read.bytes.length,
    sha256,
  })) as { value?: { staging_id?: string } };
  const stagingId = begun.value?.staging_id;
  if (typeof stagingId !== "string")
    throw new Error("The capture could not be staged.");
  for (const frame of chunkFrames(stagingId, read.bytes)) {
    // Chunks are ordered by contract: the host checks `seq` against the next it
    // expects, so they go one at a time.
    // oxlint-disable-next-line no-await-in-loop
    await link.send(frame as unknown as Record<string, unknown>);
  }
  await link.send({ t: "stage:end", staging_id: stagingId });
  const { screenshot: _dropped, ...rest } = input;
  return await link.ask(method, { ...rest, staged_sha: sha256 });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const shape = (message ?? {}) as {
    type?: unknown;
    input?: unknown;
    pageUrl?: unknown;
  };
  const method = typeof shape.type === "string" ? shape.type : undefined;
  if (!method) {
    respond({ ok: false, error: memberSentence("unknown") });
    return false;
  }
  // THE GESTURE'S THREE REFUSALS, before anything is asked of the app: a
  // subframe may not ask, the claimed page must be the active tab's own origin,
  // and the page must be eligible (`page-origin.ts`, v0's `assertTopFramePage`).
  const refusal = lockerGestureRefusal({
    method,
    frameId: sender.frameId,
    pageUrl: typeof shape.pageUrl === "string" ? shape.pageUrl : undefined,
    tabUrl: sender.tab?.url,
  });
  if (refusal) {
    respond({ ok: false, error: refusal });
    return false;
  }
  const input = { ...(message as Record<string, unknown>) };
  delete input["type"];

  const settle = (async () => {
    if (isLockerFillMessage(message)) {
      // THE FILL AND ITS CLEARING, in the order that makes the clearing mean
      // something: ask, hand on (which structured-clones), then drop this
      // process's copy (`HostLink.fillInto`).
      await link.fillInto(input, (value) => respond({ ok: true, value }));
      return;
    }
    const value = stagesBytes(method)
      ? await stagedCapture(method, input)
      : await link.ask(method, input);
    paired = true;
    respond({ ok: true, value });
  })();

  void settle.catch((error: unknown) => {
    respond({
      ok: false,
      error: error instanceof Error ? error.message : memberSentence("unknown"),
    });
  });
  void settle.finally(() => clearSavedPassword(input));
  // `true` keeps the response channel open for the async answer.
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === APPROVAL_ALARM) void pollBadge();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(APPROVAL_ALARM, {
    periodInMinutes: APPROVAL_ALARM_MINUTES,
  });
  chrome.contextMenus.create({
    id: "centraid-quick-task",
    title: "Capture in Centraid Tasks",
    contexts: ["page", "selection", "link"],
  });
  void pollBadge();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (
    !shouldCaptureContextMenu({ menuItemId: info.menuItemId, tabUrl: tab?.url })
  ) {
    return;
  }
  const capture = pageCaptureFromTab({
    title: tab?.title,
    url: tab?.url ?? "",
    selectionText: info.selectionText,
  });
  void link.ask("capture:task", { capture }).catch(() => undefined);
});
