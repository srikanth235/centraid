// People, rebuilt from the Binding Layer v12 handoff: the orchestrator.
//
// This file wires the app and draws none of it. It owns the two mutable bags
// (`state`, `data`), builds the read factory (`logic.ts`) and the write
// factory (`writes.ts`) once, feeds the frame (title, count, verbs, band,
// status line), and hands each screen the props `types.ts` freezes. The
// screens live in `components/`; the recipes they are built from live in
// `components/shared.module.css`, declared exactly once.
//
// THE VAULT LINK IS DRAWN, as far as the contract lets it be. `queries/*` now
// answer the sharing plane (`queries/_shared.ts`), so the ring, the two filter
// chips, the vault-counting tiles and status lines, and the person screen's
// `Vaults` + `Shared with them` sections are all here — and all of them fall
// back to wave 1's link-free rendering when `links_available` is false, which
// is what a parked `share.*` scope looks like from in here.
//
// THE GRANT PLANE IS THE PERSON SCREEN'S OWN READ (#825). `Share` and
// `Revoke` are live there, and neither travels through `logic.ts` or
// `writes.ts`: the plane is the gateway's door, not one of this app's vault
// queries, so `components/PersonGrants.tsx` holds it and this file supplies
// only the two things a host owes it — the roster, which is where a party id
// has a name, and the frame's one status line.
//
// STILL ABSENT, and absence rather than omission: the six record sections the
// handoff itself excludes (lists, journal, tasks, gifts, debts, typed
// relationships, edit history).
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactElement } from "react";

import {
  observeWidth,
  onDataChange,
  onFocusRefresh,
} from "@centraid/design/elements";

import { publishOutcome } from "../_shared/app-frame.tsx";
import { libraryReachability } from "../_shared/view-state-kit.ts";
import type { InlineAppProps } from "../inline-types.ts";
import { Chrome } from "./Chrome.tsx";
import { ConfirmHost } from "./components/ConfirmHost.tsx";
import { PeopleRouteBody } from "./components/PeopleRouteBody.tsx";
import { appBar, bandClaim } from "./frame.tsx";
import { createLogic } from "./logic.ts";
import { STATUS } from "./people-copy.ts";
import {
  EDIT,
  LOG,
  MERGE,
  PERSON,
  SEARCH,
  TRASH,
  shelfFromSegment,
} from "./shelves.ts";
import type {
  AppData,
  AppState,
  ComposerKey,
  ComposerState,
  LogDraft,
  PersonDraft,
  RosterFilter,
} from "./types.ts";
import { DEFAULT_CADENCE, makeData, makeState } from "./view-state.ts";
import { createWrites } from "./writes.ts";

/**
 * Vault entities this app's queries read — the doorbell filter. Restored in
 * full from the list the wall preserved: an app that declared fewer would
 * sleep through a change it renders, and one that declared more would wake on
 * every unrelated write.
 */
export const CHANGE_TABLES = [
  "people.profile",
  "people.important_date",
  "tally.obligation",
  "schedule.task",
  "core.party",
  "core.activity",
  "core.link",
  "core.content_item",
  "core.party_identifier",
  "social.contact_channel",
  "core.tag",
  "core.concept",
  "knowledge.note",
  "knowledge.annotation",
];

interface Core {
  logic: ReturnType<typeof createLogic>;
  writes: ReturnType<typeof createWrites>;
}

export function Root({
  rootRef,
  frame,
  compact = false,
}: InlineAppProps): ReactElement {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [narrow, setNarrow] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [readFailedState, setReadFailedState] = useState(false);
  const [consent, setConsent] = useState<{ message: string } | null>(null);

  const rootElRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const stateRef = useRef<AppState>(makeState());
  const dataRef = useRef<AppData>(makeData());
  const coreRef = useRef<Core | null>(null);
  /** The status line is carrying a write's OUTCOME, so the ambient sentence
   *  stays out of the way until the member navigates. */
  const outcomeHeld = useRef(false);

  if (!coreRef.current) {
    const state = stateRef.current;
    const data = dataRef.current;
    const render = (): void => bump();
    const logic = createLogic({
      state,
      data,
      render,
      setLoaded,
      setConsent,
      setReadFailed: setReadFailedState,
    });
    const writes = createWrites({
      frame,
      refresh: logic.refresh,
      hold: () => {
        outcomeHeld.current = true;
      },
      notice: logic.notice,
    });
    coreRef.current = { logic, writes };
  }

  const core = coreRef.current;
  const { logic } = core;
  const { writes } = core;
  const state = stateRef.current;
  const data = dataRef.current;

  // Seed the compact layout BEFORE the first paint. `observeWidth` in the
  // mount effect below only fires post-paint, so without this the phone form
  // factor would paint at desktop metrics for one frame.
  useLayoutEffect(() => {
    const element = rootElRef.current;
    if (!element) return;
    const isNarrow =
      element.dataset.appWidth === "narrow" ||
      compact ||
      element.clientWidth < 860;
    if (isNarrow !== stateRef.current.narrow) {
      stateRef.current.narrow = isNarrow;
      setNarrow(isNarrow);
    }
  }, [compact]);

  useEffect(() => {
    const stopDoorbell = onDataChange(
      CHANGE_TABLES,
      () => void logic.refresh(),
      {
        debounceMs: 200,
      }
    );
    const stopFocus = onFocusRefresh(() => void logic.refresh());
    const stopWidth = rootElRef.current
      ? observeWidth(rootElRef.current, 860, (isNarrow: boolean) => {
          stateRef.current.narrow = isNarrow;
          setNarrow(isNarrow);
        })
      : () => {};
    void logic.refresh();
    return () => {
      stopDoorbell();
      stopFocus();
      stopWidth();
    };
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- mount-once wiring, stable deps via refs (#505)
  }, []);

  // OFFLINE IS READ, NEVER INVENTED (`_shared/view-state-kit.ts`): the host's
  // own knob first, then the evidence of a read that actually came back failed.
  const offline =
    libraryReachability({
      hostStatus: rootElRef.current?.dataset.gatewayStatus ?? null,
      readFailed: readFailedState,
    }) === "unreachable";

  // ──── navigation + screen handlers ────

  const navigate = useCallback(
    (shelf: typeof state.shelf, personId?: string | null) => {
      outcomeHeld.current = false;
      logic.go(shelf, personId);
    },
    [logic]
  );

  // The screens take handlers by name, so the few that are `logic`'s own
  // functions are bound here rather than passed through raw — one naming
  // convention for every callback a route receives.
  const handleTermChange = logic.setSearch;
  const handleClearSearch = logic.clearSearch;
  const handleToggleSection = logic.toggleSection;
  const handleBack = logic.goBack;

  const openPerson = useCallback(
    (partyId: string) => navigate(PERSON, partyId),
    [navigate]
  );

  const openLog = useCallback(
    (partyId: string) => {
      state.log = { party_id: partyId, kind: "Message", text: "" };
      navigate(LOG, partyId);
    },
    [navigate, state]
  );

  const openEdit = useCallback(() => {
    const person = data.person;
    state.draft = {
      party_id: person?.party_id ?? null,
      name: person?.name ?? "",
      role: person?.role ?? "",
      avatar_color: person?.avatar_color ?? null,
      cadence_days: person?.cadence_days ?? DEFAULT_CADENCE,
    };
    navigate(EDIT);
  }, [data, navigate, state]);

  const openNew = useCallback(() => {
    state.draft = {
      party_id: null,
      name: "",
      role: "",
      avatar_color: null,
      cadence_days: DEFAULT_CADENCE,
    };
    navigate(EDIT, null);
  }, [navigate, state]);

  const selectFilter = useCallback(
    (filter: RosterFilter) => {
      state.filter = filter;
      bump();
    },
    [state]
  );

  const composerChange = useCallback(
    (patch: Partial<ComposerState>) => {
      if (!state.composer) return;
      state.composer = { ...state.composer, ...patch };
      bump();
    },
    [state]
  );

  const composerSave = useCallback(() => {
    const composer = state.composer;
    const person = data.person;
    if (!composer || !person) return;
    state.composer = null;
    bump();
    if (composer.key === "notes")
      void writes.addNote(person.party_id, composer.value, person.name);
    else if (composer.key === "dates")
      void writes.addImportantDate(
        person.party_id,
        composer.label,
        composer.monthDay,
        person.name
      );
    else
      void writes.saveChannel(person.party_id, {
        kind: composer.kind,
        value: composer.value,
        ...(composer.label ? { label: composer.label } : {}),
      });
  }, [data, state, writes]);

  const draftChange = useCallback(
    (patch: Partial<PersonDraft>) => {
      if (!state.draft) return;
      state.draft = { ...state.draft, ...patch };
      bump();
    },
    [state]
  );

  const logChange = useCallback(
    (patch: Partial<LogDraft>) => {
      if (!state.log) return;
      state.log = { ...state.log, ...patch };
      bump();
    },
    [state]
  );

  // ──── the route ────

  // `loading` is passed at every call site rather than folded into `base`:
  // "a read has not landed yet" is the gate every empty state in the app sits
  // behind, and the honesty test for it reads the JSX (`src/state-honesty.test.ts`).
  const routeBody = (
    <PeopleRouteBody
      data={data}
      loaded={loaded}
      mergeCandidates={() => logic.mergeCandidates()}
      narrow={narrow}
      offline={offline}
      onAddPerson={openNew}
      onCancel={handleBack}
      onClearSearch={handleClearSearch}
      onComposerCancel={() => {
        state.composer = null;
        bump();
      }}
      onComposerChange={composerChange}
      onComposerSave={composerSave}
      onDeleteChannel={(channel) => void writes.deleteChannel(channel)}
      onDraftChange={draftChange}
      onDraftSave={() => {
        const draft = state.draft;
        if (!draft) return;
        void writes.savePerson(draft, data.person);
        handleBack();
      }}
      onEdit={openEdit}
      onLogChange={logChange}
      onLogPerson={openLog}
      onLogSave={() => {
        const draft = state.log;
        const name = data.person?.name ?? "";
        if (!draft) return;
        void writes.logTouch(draft, name);
        handleBack();
      }}
      onMerge={() => navigate(MERGE, state.personId)}
      onMergeConfirm={() => {
        if (!data.person || !state.mergeSourceId) return;
        state.confirm = {
          kind: "merge",
          party_id: data.person.party_id,
          source_party_id: state.mergeSourceId,
        };
        bump();
      }}
      onOpenComposer={(key: ComposerKey) => {
        state.composer = {
          key,
          value: "",
          label: "",
          kind: "phone",
          monthDay: "01-01",
        };
        bump();
      }}
      onOpenPerson={openPerson}
      onPersonLog={() => data.person && openLog(data.person.party_id)}
      onPersonToggleStar={() =>
        data.person && void writes.toggleStar(data.person)
      }
      onPickSource={(partyId) => {
        state.mergeSourceId = partyId;
        bump();
      }}
      onRestore={(person) => void writes.restorePerson(person)}
      onSelectFilter={selectFilter}
      onSelectTile={(tile) => {
        // Every tile lands on the roster under the filter it names — the
        // two link tiles included, which is what makes `Vaults` and
        // `To link` navigations rather than badges.
        if (tile === "starred") selectFilter("starred");
        else if (tile === "reconnect") selectFilter("due");
        else if (tile === "linked") selectFilter("linked");
        else if (tile === "to_link") selectFilter("unlinked");
        else selectFilter("all");
        navigate(null);
      }}
      onStatus={(message) => {
        // A share or a revoke is an OUTCOME, so it holds the line exactly as
        // a People write's own outcome does, until the member navigates.
        outcomeHeld.current = true;
        publishOutcome(frame, { text: message });
      }}
      onTermChange={handleTermChange}
      onToggleReminder={(dateId, label) => {
        const date = data.person?.dates.find((d) => d.date_id === dateId);
        void writes.toggleReminder(dateId, label, date?.reminder_on ?? false);
      }}
      onToggleSection={handleToggleSection}
      onToggleStar={(person) => void writes.toggleStar(person)}
      onTrash={() => {
        if (!data.person) return;
        state.confirm = { kind: "trash", party_id: data.person.party_id };
        bump();
      }}
      personRow={(partyId) => logic.personRow(partyId)}
      searchInputRef={(el) => {
        searchInputRef.current = el;
      }}
      state={state}
    />
  );

  // ──── the two modal confirms ────

  const confirm = state.confirm;
  const confirmSubject = logic.personRow(confirm?.party_id ?? null);
  const confirmSource = logic.personRow(confirm?.source_party_id ?? null);
  const overlays = (
    <ConfirmHost
      confirm={confirm}
      subjectName={confirmSubject?.name ?? null}
      sourceName={confirmSource?.name ?? null}
      onCancel={() => {
        state.confirm = null;
        bump();
      }}
      onConfirm={() => {
        state.confirm = null;
        bump();
        if (!confirm || !confirmSubject) return;
        if (confirm.kind === "trash") {
          void writes.trashPerson(confirmSubject);
          navigate(null, null);
          return;
        }
        if (!confirmSource) return;
        void writes.mergePeople(confirmSource, confirmSubject).then((ok) => {
          if (ok) {
            state.merged = true;
            bump();
          }
        });
      }}
    />
  );

  // ──── the frame ────

  const counts = logic.rosterCounts();
  const barCountValue =
    state.shelf === null
      ? counts.people
      : state.shelf === TRASH
        ? data.trash.length
        : state.shelf === SEARCH
          ? (state.searchResults?.length ?? 0)
          : null;
  const handedOff = narrow;
  // The roster's bar carries `<k> of <m> linked` on a pointer surface, where
  // there is room for the pair. On the compact surface the plain people count
  // stands — the handoff gives the phone the shorter meta.
  const linkedMeta =
    state.shelf === null && data.linksAvailable && !handedOff
      ? STATUS.barLinked(counts.linked, counts.people)
      : null;
  useEffect(() => {
    frame.setAppBar(
      appBar({
        shelf: state.shelf,
        count: barCountValue,
        compact: handedOff,
        ...(linkedMeta ? { linkedMeta } : {}),
        ...(data.person ? { personName: data.person.name } : {}),
        ...(state.shelf === null
          ? { onAdd: openNew, onTrash: () => navigate(TRASH) }
          : {}),
        ...(state.shelf === PERSON ? { onEdit: openEdit } : {}),
      })
    );
  }, [
    frame,
    state.shelf,
    barCountValue,
    handedOff,
    linkedMeta,
    data.person,
    openNew,
    openEdit,
    navigate,
    state,
    data,
  ]);

  useEffect(() => {
    if (!narrow) {
      frame.claimBand(null);
      return;
    }
    frame.claimBand(
      bandClaim(state.shelf, (segment) => navigate(shelfFromSegment(segment)))
    );
  }, [frame, state.shelf, narrow, navigate, state]);

  // The AMBIENT sentence, replaced in place by any write's own outcome until
  // the member navigates (`writes.ts` holds the line; `navigate` releases it).
  useEffect(() => {
    if (outcomeHeld.current) return;
    const text = logic.ambientStatus();
    publishOutcome(frame, text ? { text } : null);
  }, [
    frame,
    logic,
    state.shelf,
    state.search,
    counts.people,
    counts.due,
    counts.starred,
    counts.linked,
    counts.toLink,
    data.linksAvailable,
  ]);

  // Hand the bar, the band and the line back when People stops being the route.
  useEffect(() => {
    return () => {
      frame.setAppBar(null);
      frame.claimBand(null);
      frame.clearStatus();
    };
  }, [frame]);

  return (
    <Chrome
      shelf={state.shelf}
      narrow={narrow}
      bandOwned={handedOff}
      consent={consent}
      onSelectShelf={(shelf) => navigate(shelf)}
      rootRef={(el) => {
        rootElRef.current = el;
        rootRef(el);
      }}
      slots={{ scroll: routeBody, overlays }}
    />
  );
}
