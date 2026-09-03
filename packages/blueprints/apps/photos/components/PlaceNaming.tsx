import { useState } from "react";

import { act, narrate } from "../outcomes.ts";
import { InlineInput } from "./InlineInput.tsx";

import styles from "./PlaceNaming.module.css";

const HOME_NAME = "Home";

export function PlaceNaming({
  placeId,
  scope,
  refresh,
}: {
  placeId: string;
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
