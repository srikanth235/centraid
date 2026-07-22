interface ChromeMessageSender {
  tab?: { id?: number; url?: string; windowId?: number };
  frameId?: number;
}

interface ChromeTab {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
}

interface ChromeEvent<T extends (...args: never[]) => unknown> {
  addListener(listener: T): void;
}

declare const chrome: {
  runtime: {
    id: string;
    lastError?: { message?: string };
    getURL(path: string): string;
    sendMessage(message: unknown, callback?: (response: unknown) => void): Promise<unknown> | void;
    onMessage: ChromeEvent<
      (
        message: unknown,
        sender: ChromeMessageSender,
        sendResponse: (response: unknown) => void,
      ) => boolean | void
    >;
    onInstalled: ChromeEvent<() => void>;
  };
  storage: {
    local: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    session: {
      get(keys?: string | string[] | null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
  };
  action: {
    setBadgeText(details: { text: string; tabId?: number }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
  alarms: {
    create(name: string, info: { periodInMinutes: number }): void;
    onAlarm: ChromeEvent<(alarm: { name: string }) => void>;
  };
  tabs: {
    create(createProperties: { url: string }): Promise<ChromeTab>;
    query(queryInfo: Record<string, unknown>): Promise<ChromeTab[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    captureVisibleTab(windowId?: number, options?: { format?: 'png' | 'jpeg' }): Promise<string>;
    onActivated: ChromeEvent<(activeInfo: { tabId: number; windowId: number }) => void>;
    onUpdated: ChromeEvent<
      (tabId: number, changeInfo: { status?: string }, tab: ChromeTab) => void
    >;
  };
  scripting: {
    executeScript(details: { target: { tabId: number }; files: string[] }): Promise<unknown>;
  };
  contextMenus: {
    create(properties: { id: string; title: string; contexts: string[] }): void;
    onClicked: ChromeEvent<
      (
        info: { menuItemId: string | number; selectionText?: string; pageUrl?: string },
        tab?: ChromeTab,
      ) => void
    >;
  };
};
