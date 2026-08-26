// THE ROUTE SWITCH for everything that is not the item list or one item.
//
// One place where a `ShelfId` becomes a screen, so the orchestrator keeps its
// one job — the boundary — and the routes keep theirs. Every screen below
// takes the state it needs as props and holds NONE of its own: the add / edit
// form's typed values and the generator's output live in the orchestrator's
// bag, where the lock's enumerated wipe can reach them.
import type { ReactNode } from "react";

import type { Bag } from "../bag.ts";
import { emptySeed } from "../draft.ts";
import { clockAt } from "../format.ts";
import { reviewRegister } from "../review-model.ts";
import type { RouteActs } from "../route-acts.ts";
import {
  ACCESS,
  EDIT,
  EXPORT,
  FILL,
  GEN,
  IMPORT,
  SEARCH,
  TRASH,
  WATCH,
} from "../shelves.ts";
import type { ShelfId } from "../shelves.ts";
import { EditScreen } from "./Edit.tsx";
import { GenScreen } from "./Gen.tsx";
import { ReviewScreen } from "./Review.tsx";
import { SearchScreen } from "./Search.tsx";
import {
  AccessScreen,
  ExportScreen,
  FillScreen,
  ImportScreen,
} from "./Surfaces.tsx";
import { TrashScreen } from "./Trash.tsx";

/** The routes this switch draws. Everything else — the list, one item, the
 *  two gates — belongs to the orchestrator, which owns their state. */
const ROUTED: ReadonlySet<string> = new Set([
  String(EDIT),
  String(GEN),
  String(WATCH),
  String(SEARCH),
  String(IMPORT),
  String(ACCESS),
  String(TRASH),
  String(EXPORT),
  String(FILL),
]);

export function isRoutedScreen(shelf: ShelfId): boolean {
  return shelf !== null && ROUTED.has(String(shelf));
}

export interface ScreensProps {
  shelf: ShelfId;
  bag: Bag;
  /** Has the items read landed? Nothing is empty until one has. */
  loaded: boolean;
  /** The gateway is out of reach — the add / edit commit is withheld. */
  offline: boolean;
  /** A write is in flight. */
  busy: boolean;
  /** One clock for the whole room, so an expiry read here and a countdown
   *  read next door cannot disagree by a second. */
  now: number;
  acts: RouteActs;
  /** Opening an item is a per-item gesture: it opens the permit gate. */
  onOpenItem: (itemId: string) => void;
  /** Leave the form without writing. The typed values go with it. */
  onCancelEdit: () => void;
}

export function Screens(props: ScreensProps): ReactNode {
  const { acts, bag, shelf } = props;

  if (shelf === EDIT) {
    // A member who arrives at this route by URL rather than by the bar's verb
    // gets the same empty form the verb would have built. The first keystroke
    // puts a seed in the bag, which is where a typed secret has to live.
    return (
      <EditScreen
        seed={bag.editSeed ?? emptySeed()}
        offline={props.offline}
        busy={props.busy}
        error={bag.editError}
        onChange={acts.handleEditChange}
        onRetype={acts.handleRetype}
        onGenerate={() => acts.handleGenerateInto("password")}
        onSave={acts.handleSave}
        onCancel={props.onCancelEdit}
      />
    );
  }

  if (shelf === GEN) {
    return (
      <GenScreen
        value={bag.generated}
        options={bag.genOptions}
        onOptions={acts.handleGenOptions}
        onRegenerate={acts.handleRegenerate}
        onCopy={acts.handleCopyGenerated}
        onPutOnItem={acts.handlePutOnItem}
      />
    );
  }

  if (shelf === WATCH) {
    return (
      <ReviewScreen
        register={reviewRegister(bag.items, props.now)}
        windowCount={bag.items.length}
        checkedAtClock={bag.lastMatchedAt ? clockAt(bag.lastMatchedAt) : null}
        loaded={props.loaded}
        onShowThem={acts.handleShowVerdict}
        onChange={(row) => props.onOpenItem(row.item_id)}
      />
    );
  }

  if (shelf === SEARCH) {
    return (
      <SearchScreen
        query={bag.searchTerm}
        status={bag.searchStatus}
        results={bag.searchResults}
        onQuery={acts.handleQuery}
        onClear={acts.handleClearQuery}
        onRetry={acts.handleRetrySearch}
        onOpen={props.onOpenItem}
      />
    );
  }

  if (shelf === TRASH) {
    return (
      <TrashScreen
        rows={bag.trashRows}
        loaded={props.loaded}
        onRestore={acts.handleRestore}
        onPurge={acts.handleAskPurge}
      />
    );
  }

  if (shelf === IMPORT) return <ImportScreen />;
  if (shelf === ACCESS) return <AccessScreen />;
  if (shelf === EXPORT) return <ExportScreen items={bag.items.length} />;
  if (shelf === FILL) return <FillScreen />;
  return null;
}
