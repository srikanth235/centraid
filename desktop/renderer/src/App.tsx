/*
 * The seat shell's screens: the four states, Tally, Photos (#1020 lane F).
 *
 * Every list obeys the three-state read law — `starting`, `nothing-to-show`
 * with a reason, or rows — because `readState` is the only thing that decides
 * which to draw and it has no `empty` branch to fall into.
 *
 * All the loading lives in `seat-store.ts` and is read through
 * `useSyncExternalStore`: the seat is an external system that pushes, so
 * subscribing is the right shape and this component holds no state of its own.
 */

import React from "react";

import {
  durabilitySentence,
  readState,
} from "../../electron/src/main/seat-state-core.js";
import { createSeatStore } from "./seat-store.js";
import type { CentraidApi } from "./seat-store.js";

declare global {
  interface Window {
    CentraidApi?: CentraidApi;
  }
}

export function App(): React.ReactElement {
  const api = window.CentraidApi;
  const store = React.useMemo(() => createSeatStore(api), [api]);
  const snapshot = React.useSyncExternalStore(store.subscribe, store.snapshot);
  const { state, failure, dashboard, photos, refusals } = snapshot;

  if (!api) {
    return (
      <main>
        <h1>Centraid</h1>
        <p className="banner" data-testid="no-bridge">
          This window was opened without its preload, so it has no way to reach
          the vault.
        </p>
      </main>
    );
  }

  const read = readState(state);

  return (
    <main>
      <h1>Centraid</h1>

      <section data-testid="seat-state">
        <h2>This seat</h2>
        <dl>
          <dt>Mode</dt>
          <dd data-testid="state-mode">{state?.mode ?? "—"}</dd>
          <dt>Availability</dt>
          <dd data-testid="state-availability">{state?.availability ?? "—"}</dd>
          <dt>Durability</dt>
          <dd data-testid="state-durability">{state?.durability ?? "—"}</dd>
          <dt>Pending work</dt>
          <dd data-testid="state-pending">
            {state
              ? `${state.pending_work.outbox} queued · ${state.pending_work.behind} behind${
                  state.pending_work.stalled ? " · catching up" : ""
                }`
              : "—"}
          </dd>
          <dt>Connectivity</dt>
          <dd data-testid="state-connectivity">{state?.connectivity ?? "—"}</dd>
        </dl>
        {state ? (
          <p data-testid="state-durability-sentence">
            {durabilitySentence(state)}
          </p>
        ) : null}
      </section>

      {failure ? (
        <section className="banner" data-testid="seat-failure">
          <p>{failure}</p>
          <button
            type="button"
            onClick={() => {
              void store.retry();
            }}
          >
            Try again
          </button>
        </section>
      ) : null}

      {read.kind === "starting" ? (
        <p className="banner" data-testid="read-starting">
          Starting…
        </p>
      ) : null}
      {read.kind === "nothing-to-show" ? (
        <p className="banner" data-testid="read-nothing">
          {read.reason}
        </p>
      ) : null}
      {read.kind === "readable" && read.stale ? (
        <p className="banner" data-testid="read-stale">
          What you see may be behind: this seat has not heard from the gateway.
        </p>
      ) : null}

      <section data-testid="tally">
        <h2>Tally</h2>
        {read.kind === "readable" && dashboard ? (
          <dl>
            <dt>Currency</dt>
            <dd data-testid="tally-currency">
              {dashboard.baseCurrency || "—"}
            </dd>
            <dt>Friends</dt>
            <dd data-testid="tally-friends">{dashboard.friendCount}</dd>
            <dt>Groups</dt>
            <dd data-testid="tally-groups">{dashboard.groups.length}</dd>
            <dt>Expenses</dt>
            <dd data-testid="tally-expenses">{dashboard.expenseCount}</dd>
            <dt>Settlements</dt>
            <dd data-testid="tally-settlements">{dashboard.settlementCount}</dd>
            <dt>Open obligations</dt>
            <dd data-testid="tally-obligations">
              {dashboard.openObligationCount}
            </dd>
          </dl>
        ) : null}
        {read.kind === "readable" && !dashboard ? (
          <p data-testid="tally-unavailable">
            The ledger could not be read. {refusals.join(" · ")}
          </p>
        ) : null}
        {dashboard?.truncated ? (
          <p className="banner" data-testid="tally-truncated">
            This is one page of the ledger, not all of it.
          </p>
        ) : null}
      </section>

      <section data-testid="photos">
        <h2>Photos</h2>
        {read.kind === "readable" && !photos ? (
          <p data-testid="photos-unavailable">The library could not be read.</p>
        ) : null}
        {read.kind === "readable" && photos?.length === 0 ? (
          <p data-testid="photos-empty">Nothing here yet.</p>
        ) : null}
        {read.kind === "readable" && photos && photos.length > 0 ? (
          <div className="grid" data-testid="photos-grid">
            {photos.map((tile) => (
              <figure
                className="tile"
                key={tile.assetId}
                data-testid="photo-tile"
              >
                {tile.src && tile.kind === "video" ? (
                  // `preload="metadata"` so the grid costs one range request
                  // per tile rather than a whole file; `controls` because a
                  // seek is the thing this door exists to serve. The empty
                  // `<track>` is what the accessibility lint asks for and it is
                  // honest: a stored video carries no captions until something
                  // transcribes it, and an absent track element says "none"
                  // where a missing one says nothing.
                  <video
                    controls
                    preload="metadata"
                    src={tile.src}
                    data-testid={`photo-video-${tile.assetId}`}
                  >
                    <track kind="captions" />
                  </video>
                ) : null}
                {tile.src && tile.kind !== "video" ? (
                  <img
                    alt={tile.title ?? "A photo"}
                    src={tile.src}
                    data-testid={`photo-image-${tile.assetId}`}
                  />
                ) : null}
                {tile.src ? null : (
                  <figcaption data-testid="photo-no-bytes">
                    These bytes have not arrived yet.
                  </figcaption>
                )}
                <figcaption>
                  {tile.title ?? tile.capturedAt ?? tile.assetId}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : null}
      </section>
    </main>
  );
}
