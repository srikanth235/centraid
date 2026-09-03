import type { ReactNode } from "react";

import { EDIT, LOG, MERGE, PERSON, SEARCH, TOUCH, TRASH } from "../shelves.ts";
import type {
  AppData,
  AppState,
  ComposerKey,
  ComposerState,
  ContactChannel,
  LogDraft,
  PersonDraft,
  PersonRow,
  RosterFilter,
  TouchTile,
  TrashedPerson,
} from "../types.ts";
import { EditRoute } from "./EditRoute.tsx";
import { LogRoute } from "./LogRoute.tsx";
import { MergeRoute } from "./MergeRoute.tsx";
import { PersonRoute } from "./PersonRoute.tsx";
import { RosterRoute } from "./RosterRoute.tsx";
import { SearchRoute } from "./SearchRoute.tsx";
import { TouchRoute } from "./TouchRoute.tsx";
import { TrashRoute } from "./TrashRoute.tsx";

export interface PeopleRouteBodyProps {
  loaded: boolean;
  offline: boolean;
  narrow: boolean;
  state: AppState;
  data: AppData;
  mergeCandidates: () => readonly PersonRow[];
  personRow: (partyId: string | null) => PersonRow | null;
  onSelectTile: (tile: TouchTile) => void;
  onOpenPerson: (partyId: string) => void;
  onLogPerson: (partyId: string) => void;
  onTermChange: (term: string) => void;
  onClearSearch: () => void;
  onSelectFilter: (filter: RosterFilter) => void;
  onToggleStar: (person: PersonRow) => void;
  searchInputRef: (el: HTMLInputElement | null) => void;
  onToggleSection: (key: string) => void;
  onOpenComposer: (key: ComposerKey) => void;
  onComposerChange: (patch: Partial<ComposerState>) => void;
  onComposerSave: () => void;
  onComposerCancel: () => void;
  onPersonLog: () => void;
  onEdit: () => void;
  onPersonToggleStar: () => void;
  onToggleReminder: (dateId: string, label: string) => void;
  onDeleteChannel: (channel: ContactChannel) => void;
  onStatus: (message: string) => void;
  onTrash: () => void;
  onMerge: () => void;
  onLogChange: (patch: Partial<LogDraft>) => void;
  onLogSave: () => void;
  onCancel: () => void;
  onDraftChange: (patch: Partial<PersonDraft>) => void;
  onDraftSave: () => void;
  onRestore: (person: TrashedPerson) => void;
  onPickSource: (partyId: string) => void;
  onMergeConfirm: () => void;
  onAddPerson: () => void;
}

export function PeopleRouteBody(props: PeopleRouteBodyProps): ReactNode {
  const base = { offline: props.offline, narrow: props.narrow };
  const loading = !props.loaded;
  const { state, data } = props;

  if (state.shelf === TOUCH) {
    return (
      <TouchRoute
        {...base}
        loading={loading}
        dashboard={data.dashboard}
        onSelectTile={props.onSelectTile}
        onOpenPerson={props.onOpenPerson}
        onLog={props.onLogPerson}
      />
    );
  }
  if (state.shelf === SEARCH) {
    return (
      <SearchRoute
        {...base}
        loading={loading}
        term={state.search}
        status={state.searchStatus}
        results={state.searchResults ?? []}
        filter={state.filter}
        onTermChange={props.onTermChange}
        onClear={props.onClearSearch}
        onSelectFilter={props.onSelectFilter}
        onOpenPerson={props.onOpenPerson}
        onToggleStar={props.onToggleStar}
        inputRef={props.searchInputRef}
      />
    );
  }
  if (state.shelf === PERSON) {
    return (
      <PersonRoute
        {...base}
        loading={loading}
        person={data.person}
        collapsed={state.collapsed}
        composer={state.composer}
        onToggleSection={props.onToggleSection}
        onOpenComposer={props.onOpenComposer}
        onComposerChange={props.onComposerChange}
        onComposerSave={props.onComposerSave}
        onComposerCancel={props.onComposerCancel}
        onLog={props.onPersonLog}
        onEdit={props.onEdit}
        onToggleStar={props.onPersonToggleStar}
        onToggleReminder={props.onToggleReminder}
        onDeleteChannel={props.onDeleteChannel}
        roster={data.people}
        onStatus={props.onStatus}
        onTrash={props.onTrash}
        onMerge={props.onMerge}
      />
    );
  }
  if (state.shelf === LOG) {
    return (
      <LogRoute
        {...base}
        loading={loading}
        person={data.person ?? props.personRow(state.personId)}
        draft={state.log}
        onChange={props.onLogChange}
        onSave={props.onLogSave}
        onCancel={props.onCancel}
      />
    );
  }
  if (state.shelf === EDIT) {
    return (
      <EditRoute
        {...base}
        loading={loading}
        draft={state.draft}
        mode={state.draft?.party_id ? "edit" : "new"}
        onChange={props.onDraftChange}
        onSave={props.onDraftSave}
        onCancel={props.onCancel}
      />
    );
  }
  if (state.shelf === TRASH) {
    return (
      <TrashRoute
        {...base}
        loading={loading}
        people={data.trash}
        onRestore={props.onRestore}
      />
    );
  }
  if (state.shelf === MERGE) {
    return (
      <MergeRoute
        {...base}
        loading={loading}
        keep={data.person}
        candidates={props.mergeCandidates()}
        source={props.personRow(state.mergeSourceId)}
        merged={state.merged}
        onPickSource={props.onPickSource}
        onMerge={props.onMergeConfirm}
        onCancel={props.onCancel}
      />
    );
  }
  return (
    <RosterRoute
      {...base}
      loading={loading}
      people={data.people}
      linksAvailable={data.linksAvailable}
      filter={state.filter}
      onSelectFilter={props.onSelectFilter}
      onOpenPerson={props.onOpenPerson}
      onToggleStar={props.onToggleStar}
      onAddPerson={props.onAddPerson}
    />
  );
}
