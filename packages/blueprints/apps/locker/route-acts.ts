import { useCallback, useMemo, useRef } from "react";
import type { RefObject } from "react";

import type { Bag } from "./bag.ts";
import {
  draftFrom,
  emptySeed,
  isReady,
  retype,
  seedFromDetail,
} from "./draft.ts";
import { generate } from "./gen-model.ts";
import type { GenOptions } from "./gen-model.ts";
import { ARCHIVED, DUPLICATED, UNARCHIVED } from "./item-copy.ts";
import {
  ADDRESSES_SAVED,
  CUSTOM_LABEL_MISSING,
  EDIT_CREATED,
  EDIT_SAVED,
  EDIT_TITLE_MISSING,
  FIELD_REMOVED,
  FIELD_SAVED,
  GEN_REGENERATED,
  GEN_SEEDED,
  PASSKEY_CLEARED,
  PASSKEY_RP_MISSING,
  PASSKEY_SAVED,
  PURGED,
  PURGE_PARKED,
  RESTORED_WHOLE,
} from "./route-copy.ts";
import { emptySidecarDraft } from "./session.ts";
import type { SidecarDraft } from "./session.ts";
import { EDIT } from "./shelves.ts";
import type { ShelfId } from "./shelves.ts";
import type {
  CheckKey,
  ItemDraftSeed,
  LockerDetail,
  LockerItemType,
  LockerRow,
} from "./types.ts";
import {
  addItemWrite,
  archiveWrite,
  clearPasskeyWrite,
  duplicateWrite,
  editItemWrite,
  purgeWrite,
  removeFieldWrite,
  restoreWrite,
  setAddressesWrite,
  setFieldWrite,
  setPasskeyWrite,
} from "./writes.ts";
import type { LockerWrite } from "./writes.ts";

const SEARCH_SETTLE_MS = 150;

export interface ActOutcome {
  text: string | ((status: string) => string);
  undo?: () => void;
}

export interface RouteActsInput {
  bagRef: RefObject<Bag>;
  act: (write: LockerWrite, outcome: ActOutcome) => Promise<void>;
  bump: () => void;
  go: (shelf: ShelfId) => void;
  copySecret: (value: string, label: string) => void;
  publish: (text: string) => void;
}

export interface RouteActs {
  handleEditChange: (seed: ItemDraftSeed) => void;
  handleRetype: (type: LockerItemType) => void;
  handleSave: () => void;
  handleEditDetail: (detail: LockerDetail | null) => void;
  handleNewItem: () => void;
  handleGenerateInto: (key: string) => void;
  handleGenOptions: (options: GenOptions) => void;
  handleRegenerate: () => void;
  handleCopyGenerated: () => void;
  handlePutOnItem: () => void;
  handleQuery: (value: string) => void;
  handleClearQuery: () => void;
  handleRetrySearch: () => void;
  handleRestore: (itemId: string) => void;
  handleAskPurge: (itemId: string) => void;
  handlePurge: (itemId: string) => void;
  handleShowVerdict: (key: CheckKey) => void;
  handleArchive: (itemId: string, archived: boolean) => void;
  handleDuplicate: (itemId: string) => void;
  handleFieldDraft: (draft: SidecarDraft["field"]) => void;
  handleFieldSave: () => void;
  handleFieldRemove: (fieldId: string) => void;
  handleAddressDraft: (draft: SidecarDraft["addresses"]) => void;
  handleAddressSave: () => void;
  handlePasskeyDraft: (draft: SidecarDraft["passkey"]) => void;
  handlePasskeySave: () => void;
  handlePasskeyClear: () => void;
}

export function useRouteActs(input: RouteActsInput): RouteActs {
  const { bagRef, act, bump, go, copySecret, publish } = input;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draw = useCallback(
    (options: GenOptions): void => {
      bagRef.current.genOptions = options;
      bagRef.current.generated = generate(options);
      publish(GEN_REGENERATED);
      bump();
    },
    [bagRef, bump, publish]
  );

  const runSearch = useCallback(
    (term: string): void => {
      const bag = bagRef.current;
      const seq = bag.searchSeq;
      if (!term.trim()) {
        bag.searchResults = null;
        bag.searchStatus = "resting";
        bump();
        return;
      }
      void window.centraid
        .read<{ items?: LockerRow[]; vaultDenied?: unknown }>({
          query: "search",
          input: { term },
        })
        .then((payload) => {
          if (seq !== bagRef.current.searchSeq) return;
          const denied = Boolean(payload?.vaultDenied);
          bagRef.current.searchResults = denied ? null : (payload?.items ?? []);
          bagRef.current.searchStatus = denied ? "unreachable" : "ready";
          bump();
        })
        .catch(() => {
          if (seq !== bagRef.current.searchSeq) return;
          bagRef.current.searchResults = null;
          bagRef.current.searchStatus = "unreachable";
          bump();
        });
    },
    [bagRef, bump]
  );

  const handleQuery = useCallback(
    (value: string): void => {
      const bag = bagRef.current;
      bag.searchTerm = value;
      bag.searchSeq += 1;
      bag.searchStatus = value.trim() ? "searching" : "resting";
      bump();
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => runSearch(value), SEARCH_SETTLE_MS);
    },
    [bagRef, bump, runSearch]
  );

  const handleSave = useCallback((): void => {
    const seed = bagRef.current.editSeed;
    if (!seed) return;
    if (!isReady(seed)) {
      bagRef.current.editError = EDIT_TITLE_MISSING;
      bump();
      return;
    }
    bagRef.current.editError = "";
    const draft = draftFrom(seed);
    const write =
      seed.mode === "edit" && seed.itemId
        ? editItemWrite({ ...draft, itemId: seed.itemId })
        : addItemWrite(draft);
    bagRef.current.editSeed = null;
    bagRef.current.generated = "";
    go(null);
    void act(write, { text: seed.mode === "edit" ? EDIT_SAVED : EDIT_CREATED });
  }, [act, bagRef, bump, go]);

  const handleEditChange = useCallback(
    (seed: ItemDraftSeed): void => {
      bagRef.current.editSeed = seed;
      bagRef.current.editError = "";
      bump();
    },
    [bagRef, bump]
  );

  const handleRetype = useCallback(
    (type: LockerItemType): void => {
      const seed = bagRef.current.editSeed ?? emptySeed(type);
      bagRef.current.editSeed = retype(seed, type);
      bump();
    },
    [bagRef, bump]
  );

  const handleEditDetail = useCallback(
    (detail: LockerDetail | null): void => {
      bagRef.current.editSeed = detail ? seedFromDetail(detail) : emptySeed();
      bagRef.current.editError = "";
      go(EDIT);
    },
    [bagRef, go]
  );

  const handleNewItem = useCallback((): void => {
    bagRef.current.editSeed = emptySeed();
    bagRef.current.editError = "";
    go(EDIT);
  }, [bagRef, go]);

  const handleGenerateInto = useCallback(
    (key: string): void => {
      const seed = bagRef.current.editSeed ?? emptySeed();
      bagRef.current.editSeed = {
        ...seed,
        fields: { ...seed.fields, [key]: generate(bagRef.current.genOptions) },
      };
      publish(GEN_REGENERATED);
      bump();
    },
    [bagRef, bump, publish]
  );

  const handleGenOptions = useCallback(
    (options: GenOptions): void => draw(options),
    [draw]
  );

  const handleRegenerate = useCallback((): void => {
    draw(bagRef.current.genOptions);
  }, [bagRef, draw]);

  const handleCopyGenerated = useCallback((): void => {
    const value = bagRef.current.generated;
    if (value) copySecret(value, "Password");
  }, [bagRef, copySecret]);

  const handlePutOnItem = useCallback((): void => {
    const value = bagRef.current.generated;
    const seed = bagRef.current.editSeed ?? emptySeed();
    bagRef.current.editSeed = {
      ...seed,
      fields: { ...seed.fields, password: value },
    };
    go(EDIT);
    bagRef.current.generated = "";
    publish(GEN_SEEDED);
    bump();
  }, [bagRef, bump, go, publish]);

  const handleClearQuery = useCallback(
    (): void => handleQuery(""),
    [handleQuery]
  );

  const handleRetrySearch = useCallback((): void => {
    handleQuery(bagRef.current.searchTerm);
  }, [bagRef, handleQuery]);

  const handleRestore = useCallback(
    (itemId: string): void => {
      void act(restoreWrite(itemId), { text: RESTORED_WHOLE });
    },
    [act]
  );

  const handleAskPurge = useCallback(
    (itemId: string): void => {
      bagRef.current.confirm = { kind: "purge", itemId };
      bump();
    },
    [bagRef, bump]
  );

  const handlePurge = useCallback(
    (itemId: string): void => {
      bagRef.current.confirm = null;
      bump();
      void act(purgeWrite(itemId), {
        text: (status) => (status === "parked" ? PURGE_PARKED : PURGED),
      });
    },
    [act, bagRef, bump]
  );

  const handleShowVerdict = useCallback(
    (check: CheckKey): void => {
      bagRef.current.filter = { kind: "verdict", check };
      go(null);
    },
    [bagRef, go]
  );

  const handleArchive = useCallback(
    (itemId: string, archived: boolean): void => {
      void act(archiveWrite(itemId, archived), {
        text: archived ? UNARCHIVED : ARCHIVED,
      });
    },
    [act]
  );

  const handleDuplicate = useCallback(
    (itemId: string): void => {
      void act(duplicateWrite(itemId), { text: DUPLICATED });
    },
    [act]
  );

  const handleFieldDraft = useCallback(
    (draft: SidecarDraft["field"]): void => {
      bagRef.current.sidecarDraft = {
        ...bagRef.current.sidecarDraft,
        field: draft,
      };
      bump();
    },
    [bagRef, bump]
  );

  const handleFieldSave = useCallback((): void => {
    const draft = bagRef.current.sidecarDraft.field;
    const itemId = bagRef.current.detail?.item_id;
    if (!draft || !itemId) return;
    if (!draft.label.trim()) {
      bagRef.current.editError = CUSTOM_LABEL_MISSING;
      bump();
      return;
    }
    const write = setFieldWrite(itemId, {
      ...(draft.fieldId ? { fieldId: draft.fieldId } : {}),
      ...(draft.section.trim() ? { section: draft.section.trim() } : {}),
      label: draft.label.trim(),
      kind: draft.kind,
      ...(draft.value === "" ? {} : { value: draft.value }),
    });
    bagRef.current.sidecarDraft = {
      ...bagRef.current.sidecarDraft,
      field: null,
    };
    bagRef.current.editError = "";
    void act(write, { text: FIELD_SAVED });
  }, [act, bagRef, bump]);

  const handleFieldRemove = useCallback(
    (fieldId: string): void => {
      const itemId = bagRef.current.detail?.item_id;
      if (!itemId) return;
      void act(removeFieldWrite(itemId, fieldId), { text: FIELD_REMOVED });
    },
    [act, bagRef]
  );

  const handleAddressDraft = useCallback(
    (draft: SidecarDraft["addresses"]): void => {
      bagRef.current.sidecarDraft = {
        ...bagRef.current.sidecarDraft,
        addresses: draft,
      };
      bump();
    },
    [bagRef, bump]
  );

  const handleAddressSave = useCallback((): void => {
    const itemId = bagRef.current.detail?.item_id;
    const draft = bagRef.current.sidecarDraft.addresses;
    if (!itemId || !draft) return;
    const addresses = draft
      .filter((address) => address.url.trim())
      .map((address) => ({
        url: address.url.trim(),
        matchPolicy: address.matchPolicy,
      }));
    bagRef.current.sidecarDraft = {
      ...bagRef.current.sidecarDraft,
      addresses: null,
    };
    void act(setAddressesWrite(itemId, addresses), { text: ADDRESSES_SAVED });
  }, [act, bagRef]);

  const handlePasskeyDraft = useCallback(
    (draft: SidecarDraft["passkey"]): void => {
      bagRef.current.sidecarDraft = {
        ...bagRef.current.sidecarDraft,
        passkey: draft,
      };
      bump();
    },
    [bagRef, bump]
  );

  const handlePasskeySave = useCallback((): void => {
    const itemId = bagRef.current.detail?.item_id;
    const draft = bagRef.current.sidecarDraft.passkey;
    if (!itemId || !draft) return;
    if (!draft.rpId.trim()) {
      bagRef.current.editError = PASSKEY_RP_MISSING;
      bump();
      return;
    }
    const write = setPasskeyWrite(itemId, {
      rpId: draft.rpId.trim(),
      ...(draft.userHandle ? { userHandle: draft.userHandle } : {}),
      ...(draft.displayName ? { displayName: draft.displayName } : {}),
      ...(draft.credentialId ? { credentialId: draft.credentialId } : {}),
      ...(draft.algorithm ? { algorithm: draft.algorithm } : {}),
      ...(draft.privateKey ? { privateKey: draft.privateKey } : {}),
    });
    bagRef.current.sidecarDraft = {
      ...bagRef.current.sidecarDraft,
      passkey: null,
    };
    bagRef.current.editError = "";
    void act(write, { text: PASSKEY_SAVED });
  }, [act, bagRef, bump]);

  const handlePasskeyClear = useCallback((): void => {
    const itemId = bagRef.current.detail?.item_id;
    if (!itemId) return;
    bagRef.current.sidecarDraft = emptySidecarDraft();
    void act(clearPasskeyWrite(itemId), { text: PASSKEY_CLEARED });
  }, [act, bagRef]);

  return useMemo(
    () => ({
      handleEditChange,
      handleRetype,
      handleSave,
      handleEditDetail,
      handleNewItem,
      handleGenerateInto,
      handleGenOptions,
      handleRegenerate,
      handleCopyGenerated,
      handlePutOnItem,
      handleQuery,
      handleClearQuery,
      handleRetrySearch,
      handleRestore,
      handleAskPurge,
      handlePurge,
      handleShowVerdict,
      handleArchive,
      handleDuplicate,
      handleFieldDraft,
      handleFieldSave,
      handleFieldRemove,
      handleAddressDraft,
      handleAddressSave,
      handlePasskeyDraft,
      handlePasskeySave,
      handlePasskeyClear,
    }),
    [
      handleEditChange,
      handleRetype,
      handleSave,
      handleEditDetail,
      handleNewItem,
      handleGenerateInto,
      handleGenOptions,
      handleRegenerate,
      handleCopyGenerated,
      handlePutOnItem,
      handleQuery,
      handleClearQuery,
      handleRetrySearch,
      handleRestore,
      handleAskPurge,
      handlePurge,
      handleShowVerdict,
      handleArchive,
      handleDuplicate,
      handleFieldDraft,
      handleFieldSave,
      handleFieldRemove,
      handleAddressDraft,
      handleAddressSave,
      handlePasskeyDraft,
      handlePasskeySave,
      handlePasskeyClear,
    ]
  );
}
