// NAMING A PLACE — the one conversation that turns a coordinate into a
// location (issue #816).
//
// A place minted from a photograph's GPS carries its own coordinate as a label,
// and every surface phrases such a row as "A place with no name yet" rather
// than printing the digits (`place-phrase.ts`). That fallback is honest, and it
// is also a question the app never got round to asking. This is the ask: it
// renders exactly where the fallback phrase renders — the Places shelf heading,
// the info panel's Place row — and nowhere else, because a place the member
// already named has nothing to answer.
//
// TWO AFFORDANCES, NOT A FORM. "Name this place?" opens a single inline input;
// "This is home" is the one-tap path, because home is the name that does the
// most work in this product — it is what anchors a relative phrase ("3.4 km NE
// of Home") for every OTHER place the vault cannot name, so a member who
// answers it once makes a whole library legible.
//
// WHY "This is home" SITS BESIDE THE PROMPT AND NOT INSIDE THE OPEN INPUT.
// `InlineInput` cancels on blur, and a control rendered next to an open input
// is unreachable by either pointer or keyboard without first blurring it — the
// press would land on a button that had already unmounted. So the two answers
// are offered together, before either is taken, and the input owns the surface
// once it opens.
//
// After the write the app repaints from the change feed: the command stamps
// `core.place`, which is in `PHOTOS_READ_TABLES_LIST`, so the shelf heading, the
// info panel and any phrase anchored on this place all re-read the named row.
// Nothing here caches the phrase, and nothing needs to.
import { useState } from "react";

import { act, narrate } from "../outcomes.ts";
import { InlineInput } from "./InlineInput.tsx";

import styles from "./PlaceNaming.module.css";

/** The kind "This is home" declares, and the name it declares it under. A
 *  member can rename it afterwards like any other place; the kind is what the
 *  phrase ladder reads. */
const HOME_NAME = "Home";

export function PlaceNaming({
  placeId,
  scope,
  refresh,
}: {
  /** The `core_place` row being named. */
  placeId: string;
  /** The mounted scope the place lives in; absent means the ambient one. */
  scope?: string | null;
  refresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);

  async function submit(name: string, kind?: "home"): Promise<void> {
    setOpen(false);
    const outcome = await act(
      "name-place",
      { place_id: placeId, name, ...(kind ? { kind } : {}) },
      scope
    );
    // `narrate` puts a refusal on the frame's one status line; a success says
    // nothing, because the place's new name is the receipt.
    if (narrate(outcome)) await refresh();
  }

  if (open) {
    return (
      <InlineInput
        className={`kit-input ${styles.input}`}
        label="Place name"
        placeholder="Place name"
        onSubmit={(name) => void submit(name)}
        onCancel={() => setOpen(false)}
      />
    );
  }
  return (
    <span className={styles.prompt}>
      <button
        type="button"
        className={styles.ask}
        onClick={() => setOpen(true)}
      >
        Name this place?
      </button>
      <button
        type="button"
        className={styles.ask}
        onClick={() => void submit(HOME_NAME, "home")}
      >
        This is home
      </button>
    </span>
  );
}
