import {
  debounce,
  outcomeMessage,
  statusLine,
} from "@centraid/design/elements";

import { CAT_ORDER, byTitle, catOf } from "./format.ts";
import { genPassword } from "./totp.ts";
import type {
  AppData,
  AppState,
  LockerDetail,
  LockerRow,
  Nav,
  SavePayload,
} from "./types.ts";

interface DeniedInfo {
  code?: string;
  message?: string;
}

interface LogicDeps {
  state: AppState;
  data: AppData;
  render: () => void;
  refresh: () => Promise<void> | void;
}

export function createLogic({ state, data, render, refresh }: LogicDeps) {
  function notice(text?: string) {
    const el = document.querySelector<HTMLElement>("#noticeBanner");
    if (!el) return;
    el.textContent = text || "";
    (el as HTMLElement).hidden = !text;
  }

  function narrate(outcome: VaultOutcome | undefined): boolean {
    if (outcome?.status === "executed") {
      notice("");
      return true;
    }
    notice(outcomeMessage(outcome) ?? "The write did not go through.");
    return false;
  }

  async function act(
    action: string,
    input: Record<string, unknown>,
    { onlineOnly = false }: { onlineOnly?: boolean } = {}
  ): Promise<VaultOutcome | undefined> {
    try {
      return await window.centraid.write({
        action,
        input,
        ...(onlineOnly ? { onlineOnly: true } : {}),
      });
    } catch (error) {
      notice(String((error as { message?: string })?.message ?? error));
      return undefined;
    }
  }

  function applyDenied(d: DeniedInfo | null | undefined) {
    state.denied = true;
    (document.querySelector("#consentBanner") as HTMLElement).hidden = false;
    document.querySelector("#consentDetail")!.textContent = d?.message ?? "";
    data.items = [];
    state.selectedId = null;
    state.detail = null;
    render();
  }

  async function toggleFav(sel: LockerDetail) {
    const outcome = await act(sel.favorite ? "unstar-item" : "star-item", {
      item_id: sel.item_id,
    });
    if (!narrate(outcome)) return;
    statusLine(
      sel.favorite ? "Star removed · receipted." : "Starred · receipted."
    );
    if (state.detail && state.detail.item_id === sel.item_id) {
      state.detail = { ...state.detail, favorite: !sel.favorite };
    }
    await refresh();
  }

  async function trashItem(sel: { item_id: string }) {
    const outcome = await act("trash-item", { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    statusLine("Moved to trash · receipted.", {
      undoLabel: "Undo",
      onUndo: async () => {
        const back = await act("restore-item", { item_id: sel.item_id });
        if (narrate(back)) await refresh();
      },
    });
    state.selectedId = null;
    state.detail = null;
    state.showList = true;
    await refresh();
  }

  async function restoreItem(sel: { item_id: string }) {
    const outcome = await act("restore-item", { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    statusLine("Restored · receipted.");
    state.selectedId = null;
    state.detail = null;
    state.showList = true;
    await refresh();
  }

  async function purgeItem(sel: { item_id: string }) {
    const outcome = await act("purge-item", { item_id: sel.item_id });
    if (!narrate(outcome)) return;
    statusLine("Deleted forever · receipted.");
    state.selectedId = null;
    state.detail = null;
    state.showList = true;
    await refresh();
  }

  async function saveItem({
    mode,
    id,
    type,
    title,
    tags,
    alias,
    urlMatchPolicy,
    fields,
    allowedKeys,
  }: SavePayload): Promise<VaultOutcome | undefined> {
    if (!title.trim()) return undefined;
    const tagList = tags
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const allowed = new Set(allowedKeys);
    const input: Record<string, unknown> = {
      title: title.trim(),
      tags: tagList,
    };
    if (type === "login") input.url_match_policy = urlMatchPolicy;
    for (const [k, v] of Object.entries(fields)) {
      if (allowed.has(k) && v != null && v !== "") input[k] = v;
    }
    // Blank alias is left untouched — never clobber an existing binding.
    const aliasTrimmed = (alias || "").trim();
    if (aliasTrimmed) input.alias = aliasTrimmed;
    let outcome: VaultOutcome | undefined;
    if (mode === "edit") {
      outcome = await act(
        "edit-item",
        { item_id: id, ...input },
        { onlineOnly: true }
      );
    } else {
      outcome = await act("add-item", { type, ...input }, { onlineOnly: true });
    }
    if (!narrate(outcome)) return outcome;
    const savedId =
      mode === "edit"
        ? (id ?? null)
        : ((outcome?.output?.item_id as string | undefined) ?? null);
    statusLine(
      mode === "edit" ? "Saved · receipted." : "Item saved · receipted."
    );
    await refresh();
    // Don't re-fetch secrets here — opening is a fresh presence gesture (#630).
    if (savedId) {
      state.selectedId = null;
      state.detail = null;
      state.showList = true;
      render();
    }
    return outcome;
  }

  async function selectItem(
    id: string,
    authSession: string,
    itemToken: string
  ) {
    state.selectedId = id;
    state.detail = null;
    state.detailLoading = true;
    state.reveal = {};
    if (state.nav.kind === "watch") state.nav = { kind: "all" };
    state.showList = false;
    render();
    let res: { item?: LockerDetail | null; vaultDenied?: DeniedInfo } | null;
    try {
      res = await window.centraid.read<{
        item?: LockerDetail | null;
        vaultDenied?: DeniedInfo;
      }>({
        query: "item",
        input: {
          item_id: id,
          auth_session: authSession,
          item_token: itemToken,
        },
      });
    } catch {
      res = null;
    }
    state.detailLoading = false;
    if (res?.vaultDenied) {
      applyDenied(res.vaultDenied);
      return;
    }
    if (state.selectedId !== id) return;
    state.detail = res?.item ?? null;
    render();
  }

  function setNav(nav: Nav) {
    state.nav = nav;
    state.selectedId = null;
    state.detail = null;
    state.search = "";
    state.searchResults = null;
    searchSeq += 1;
    state.sideOpen = false;
    state.showList = true;
    render();
  }

  function toggleReveal(fid: string) {
    state.reveal = { ...state.reveal, [fid]: !state.reveal[fid] };
    render();
  }

  function regen() {
    state.genValue = genPassword({
      len: state.genLen,
      num: state.genNum,
      sym: state.genSym,
    });
    render();
  }

  function openGenerator(applyFn?: ((password: string) => void) | null) {
    state.gen = true;
    state.genApply = applyFn ?? null;
    regen();
  }

  function closeGen() {
    state.gen = false;
    state.genApply = null;
    render();
  }

  let searchSeq = 0;
  const applySearchInput = debounce(async (raw: string) => {
    state.search = raw;
    const q = raw.trim();
    const seq = ++searchSeq;
    if (!q) {
      state.searchResults = null;
      render();
      return;
    }
    let rows: LockerRow[] = [];
    try {
      const res = await window.centraid.read<{
        items?: LockerRow[];
        vaultDenied?: DeniedInfo;
      }>({
        query: "search",
        input: { term: q },
      });
      if (res?.vaultDenied) {
        applyDenied(res.vaultDenied);
        return;
      }
      rows = res?.items ?? [];
    } catch {
      rows = [];
    }
    if (seq !== searchSeq) return;
    state.searchResults = rows;
    render();
  }, 150);

  function clearSearch() {
    searchSeq += 1;
    state.search = "";
    state.searchResults = null;
    render();
  }

  return {
    notice,
    narrate,
    act,
    applyDenied,
    toggleFav,
    trashItem,
    restoreItem,
    purgeItem,
    saveItem,
    selectItem,
    setNav,
    toggleReveal,
    regen,
    openGenerator,
    closeGen,
    applySearchInput,
    clearSearch,
  };
}

// Timed clipboard wipe (#298). Clear only if the clipboard still holds our
// value — never clobber a later copy.
const CLIP_CLEAR_S = 30;
let clipClearTimer: ReturnType<typeof setTimeout> | null = null;
let lastSecretCopied: string | null = null;
function scheduleClipboardClear(secret: string) {
  if (clipClearTimer) clearTimeout(clipClearTimer);
  lastSecretCopied = secret;
  if (!navigator.clipboard || !navigator.clipboard.writeText) return;
  clipClearTimer = setTimeout(() => {
    clipClearTimer = null;
    if (!navigator.clipboard.readText) {
      return;
    }
    void navigator.clipboard
      .readText()
      .then(async (current) => {
        if (current === secret) await navigator.clipboard.writeText("");
        if (lastSecretCopied === secret) lastSecretCopied = null;
      })
      .catch(() => {
        /* clipboard permissions changed — leave current value */
      });
  }, CLIP_CLEAR_S * 1000);
}

export function clearSecretClipboard(): void {
  if (clipClearTimer) {
    clearTimeout(clipClearTimer);
    clipClearTimer = null;
  }
  const secret = lastSecretCopied;
  lastSecretCopied = null;
  if (!secret || !navigator.clipboard?.readText) return;
  void navigator.clipboard
    .readText()
    .then((current) =>
      current === secret ? navigator.clipboard.writeText("") : undefined
    )
    .catch((error: unknown) => {
      console.warn(
        "locker clipboard wipe failed",
        error instanceof Error ? error.message : error
      );
    });
}

export function copy(text: string, label?: string, secret?: boolean) {
  // writeText is a promise — a sync try/catch never sees its rejection.
  const okStatus = () =>
    statusLine(
      (label || "Copied") +
        " copied" +
        (secret ? " · clears in " + CLIP_CLEAR_S + "s" : "")
    );
  if (!navigator.clipboard || !navigator.clipboard.writeText) {
    statusLine("Copy is unavailable here.");
    return;
  }
  navigator.clipboard
    .writeText(text)
    .then(() => {
      if (secret) scheduleClipboardClear(text);
      okStatus();
    })
    .catch(() => statusLine("Copy is unavailable here."));
}

export function currentPool(state: AppState, data: AppData): LockerRow[] {
  if (state.nav.kind === "trash") return [...state.trashRows].sort(byTitle);
  let pool =
    state.searchResults == null
      ? data.items.slice()
      : state.searchResults.slice();
  if (state.nav.kind === "fav") pool = pool.filter((i) => i.favorite);
  else if (state.nav.kind === "cat") {
    const nav = state.nav;
    pool = pool.filter((i) => i.type === nav.type);
  } else if (state.nav.kind === "tag") {
    const nav = state.nav;
    pool = pool.filter((i) => (i.tags || []).includes(nav.tag));
  }
  return pool.sort(byTitle);
}

export function sidebarCounts(
  data: AppData,
  state: AppState
): { all: number; fav: number; watch: number } {
  const items = data.items;
  return {
    all: items.length,
    fav: items.filter((i) => i.favorite).length,
    watch: state.watch.compromised + state.watch.weak,
  };
}

export function catCounts(data: AppData): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of CAT_ORDER)
    counts[t] = data.items.filter((i) => i.type === t).length;
  return counts;
}

export function sidebarTags(
  data: AppData
): Array<{ tag: string; count: number }> {
  const allTags = [...new Set(data.items.flatMap((i) => i.tags || []))].sort();
  return allTags.map((tag) => ({
    tag,
    count: data.items.filter((i) => (i.tags || []).includes(tag)).length,
  }));
}

export function listTitle(nav: Nav): string {
  const navTitles: Record<string, string> = {
    all: "All items",
    fav: "Favorites",
    watch: "Watchtower",
    trash: "Trash",
  };
  if (nav.kind === "cat") return catOf(nav.type).label;
  if (nav.kind === "tag") return "#" + nav.tag;
  return navTitles[nav.kind] || "All items";
}
