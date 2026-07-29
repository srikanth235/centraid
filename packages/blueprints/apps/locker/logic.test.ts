// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  catCounts,
  createLogic,
  currentPool,
  listTitle,
  sidebarCounts,
  sidebarTags,
} from "./logic.ts";
import type { AppData, AppState, LockerRow } from "./types.ts";

function row(
  item_id: string,
  title: string,
  extra: Partial<LockerRow> = {}
): LockerRow {
  return { item_id, title, type: "login", ...extra };
}

function state(): AppState {
  return {
    nav: { kind: "all" },
    selectedId: null,
    detail: null,
    detailLoading: false,
    reveal: {},
    search: "",
    searchResults: null,
    dark: false,
    narrow: false,
    sideOpen: false,
    showList: true,
    locked: false,
    authConfigured: true,
    authSession: "session",
    authBusy: false,
    authError: "",
    pendingItemId: null,
    reauthOpen: false,
    gen: false,
    genLen: 20,
    genNum: true,
    genSym: true,
    genValue: "",
    genApply: null,
    edit: null,
    trashRows: [],
    watch: { compromised: 0, weak: 0, reused: 0, items: [] },
    denied: false,
    readFailedShown: false,
  };
}

describe("Locker logic", () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="noticeBanner" hidden></div><div id="consentBanner" hidden></div><div id="consentDetail"></div>';
  });

  test("derives navigation pools, counts and tags without exposing details", () => {
    const data: AppData = {
      items: [
        row("b", "Beta", { favorite: true, tags: ["work"] }),
        row("a", "Alpha", {
          type: "card",
          weak: true,
          tags: ["finance", "work"],
        }),
      ],
      truncated: false,
    };
    const appState = state();
    expect(currentPool(appState, data).map((item) => item.title)).toStrictEqual(
      ["Alpha", "Beta"]
    );
    appState.nav = { kind: "fav" };
    expect(
      currentPool(appState, data).map((item) => item.item_id)
    ).toStrictEqual(["b"]);
    expect(sidebarCounts(data, appState)).toStrictEqual({
      all: 2,
      fav: 1,
      watch: 0,
    });
    expect(catCounts(data)).toMatchObject({ login: 1, card: 1 });
    expect(sidebarTags(data)).toStrictEqual([
      { tag: "finance", count: 1 },
      { tag: "work", count: 2 },
    ]);
    expect(listTitle({ kind: "tag", tag: "work" })).toBe("#work");
  });

  test("opens a secret-bearing item only with the supplied session and one-time permit", async () => {
    const read = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
      item: {
        item_id: "item-a",
        type: "login",
        title: "Example",
        password: "secret",
      },
    }));
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { read, write: vi.fn<() => Promise<void>>() },
    });
    const appState = state();
    appState.reveal = { password: true };
    const render = vi.fn<() => void>();
    const logic = createLogic({
      state: appState,
      data: { items: [], truncated: false },
      render,
      refresh: vi.fn<() => Promise<void>>(),
    });
    await logic.selectItem("item-a", "session-a", "permit-a");
    expect(read).toHaveBeenCalledWith({
      query: "item",
      input: {
        item_id: "item-a",
        auth_session: "session-a",
        item_token: "permit-a",
      },
    });
    expect(appState.detail?.password).toBe("secret");
    expect(appState.reveal).toStrictEqual({});
  });

  test("secret writes are online-only, strip fields outside the selected type, and do not retain detail", async () => {
    const write = vi.fn<() => Promise<Record<string, unknown>>>(async () => ({
      status: "executed",
      output: { item_id: "item-new" },
    }));
    Object.defineProperty(window, "centraid", {
      configurable: true,
      value: { read: vi.fn<() => Promise<void>>(), write },
    });
    const appState = state();
    appState.detail = {
      item_id: "old",
      type: "login",
      title: "Old",
      password: "old-secret",
    };
    const refresh = vi.fn<() => Promise<void>>();
    const logic = createLogic({
      state: appState,
      data: { items: [], truncated: false },
      render: vi.fn<() => void>(),
      refresh,
    });
    await logic.saveItem({
      mode: "new",
      type: "login",
      title: " Example ",
      tags: "work, private",
      alias: "",
      urlMatchPolicy: "exact-host",
      fields: { password: "new-secret", cvv: "must-not-cross" },
      allowedKeys: ["password"],
    });
    expect(write).toHaveBeenCalledWith({
      action: "add-item",
      input: {
        type: "login",
        title: "Example",
        tags: ["work", "private"],
        url_match_policy: "exact-host",
        password: "new-secret",
      },
      onlineOnly: true,
    });
    expect(refresh).toHaveBeenCalledWith();
    expect(appState.detail).toBeNull();
    expect(appState.selectedId).toBeNull();
  });

  test("a consent denial clears selected secret state and exposes the approval banner", () => {
    const appState = state();
    appState.selectedId = "item-a";
    appState.detail = {
      item_id: "item-a",
      type: "login",
      title: "Example",
      password: "secret",
    };
    const logic = createLogic({
      state: appState,
      data: { items: [row("item-a", "Example")], truncated: false },
      render: vi.fn<() => void>(),
      refresh: vi.fn<() => Promise<void>>(),
    });
    logic.applyDenied({ code: "VAULT_CONSENT", message: "Approve reveal" });
    expect(appState.denied).toBe(true);
    expect(appState.detail).toBeNull();
    expect(
      (document.querySelector("#consentBanner") as HTMLElement).hidden
    ).toBe(false);
    expect(document.querySelector("#consentDetail")?.textContent).toBe(
      "Approve reveal"
    );
  });
});
