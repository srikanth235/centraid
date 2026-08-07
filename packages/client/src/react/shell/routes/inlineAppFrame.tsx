import type { JSX, ReactNode } from "react";

import type { InlineFrame } from "@centraid/blueprints/apps/inline-types";

import AppBand from "../AppBand.js";
import { iconSvg } from "../iconSvg.js";
import { useInlineFrameChannel, useInlineFrameState } from "../inlineFrame.js";
import { useBandOwner } from "../useBandOwner.js";
import type { BandOwner } from "../useBandOwner.js";

import chrome from "../chrome.module.css";

// Frame integration for an inline app (Photos v4, §3).
//
// Photos is a ROUTE INSIDE THE FRAME, not a standalone app: the app bar, the
// status line and the compact band are the frame's, and the app supplies what
// they carry. This module turns one mounted app's contributions into the slots
// `InlineAppRoute` hands `ShellFrame` — and it is where the two conditions on a
// band claim are enforced, because they are the FRAME's conditions:
//
//   1. first-party only, until submission can enforce the capsule. A vendor
//      app that claimed the band could hide the way home.
//   2. the member's own `bandOwner` preference wins over the app's claim.
//
// A claim that fails either test is simply not honoured — the app is never
// told, because an app that could detect the refusal would start drawing its
// own band again, which is the duplication this whole channel retires.
//
// WHERE THE HAND-BACK LIVES, AND WHY (issue #712 E3). `useBandOwner` shipped
// with a `setBandOwner` NOTHING called: the band could be claimed and never
// given back, so condition 2 above was a preference with no way to express it.
// The control is a FRAME action in the app bar — contributed here, ahead of
// the app's own actions, never by the app — for three reasons:
//
//   1. It is PER APP, which is what the hook is. Its own comment says a member
//      who wants the host band back in Photos "has said nothing about the next
//      app that claims", so the affordance belongs beside that app, not in a
//      global list. (The alternative the brief names — a frame-Settings list
//      of apps that have claimed — is an admin screen for a preference the
//      member forms while looking at the band, and it would leave them
//      navigating away from the thing they want to change.)
//   2. It is REVERSIBLE FROM THE SAME PLACE. It renders whenever the mounted
//      app HAS a claim on a compact surface, in both states, so handing the
//      band back does not hide the way to take it again. A control that only
//      appears in one direction is the defect this fixes, one level down.
//   3. It does not depend on the app cooperating. The app bar is the frame's
//      chrome; an app that never renders a settings row still gets the
//      affordance, and an app cannot suppress it.

/** The app mark leading the bar lockup. The brief's chip is 26px. */
const MARK_SIZE = 26;

export interface InlineAppFrameOpts {
  app: AppMetaResolvedType;
  /** Re-keys the channel, so a re-mount starts from an empty bar. */
  mountKey: string;
  /** Ships with the frame (a bundled blueprint), so it may claim the band. */
  firstParty: boolean;
  /** The compact form factor. Layout only — never a trust boundary. */
  compact: boolean;
  /** The capsule's one tap. */
  onHome: () => void;
}

export interface InlineAppFrameSlots {
  /** Handed to the app's `Root`. */
  frame: InlineFrame;
  mark: ReactNode;
  title: string;
  count: ReactNode;
  /** The app's own bar actions, or nothing. */
  actions: ReactNode;
  /** The claimed band, or `undefined` to leave the frame's band standing. */
  band: ReactNode;
}

function AppMark({ app }: { app: AppMetaResolvedType }): JSX.Element {
  const finish = window.CentraidTokens.tileFinish(app.color, "gradient");
  return (
    <span
      style={{
        alignItems: "center",
        background: finish.background,
        blockSize: MARK_SIZE,
        borderRadius: 8,
        boxShadow: finish.boxShadow || undefined,
        color: finish.glyphColor,
        display: "inline-flex",
        flex: "none",
        inlineSize: MARK_SIZE,
        justifyContent: "center",
      }}
      aria-hidden="true"
      // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
      dangerouslySetInnerHTML={{ __html: iconSvg(app.iconKey, 14, 1.9) }}
    />
  );
}

/**
 * The frame's hand-back control. A plain toggle, labelled with what pressing
 * it DOES rather than with the state it is in — "Use Centraid's band" is an
 * instruction; "App band: on" is a readout the member then has to reason
 * about. `title` mirrors the label because this is an icon-only target in the
 * bar's own register, and the label is what a screen reader is handed.
 */
function BandOwnerToggle({
  appName,
  owner,
  onChange,
}: {
  appName: string;
  owner: BandOwner;
  onChange: (owner: BandOwner) => void;
}): JSX.Element {
  const label =
    owner === "app" ? "Use Centraid's band" : `Use ${appName}'s band`;
  return (
    <button
      className={chrome.tbBtn}
      type="button"
      aria-label={label}
      aria-pressed={owner === "host"}
      title={label}
      onClick={() => onChange(owner === "app" ? "host" : "app")}
      // oxlint-disable-next-line react/no-danger -- #639 the complete HTML source is a reviewed local SVG/icon catalog value.
      dangerouslySetInnerHTML={{ __html: iconSvg("Grid", 14) }}
    />
  );
}

export function useInlineAppFrame({
  app,
  mountKey,
  firstParty,
  compact,
  onHome,
}: InlineAppFrameOpts): InlineAppFrameSlots {
  const channel = useInlineFrameChannel(mountKey);
  const contributed = useInlineFrameState(channel);
  const { bandOwner, setBandOwner } = useBandOwner(app.id);

  // Whether there is a CHOICE to offer, which is not the same question as
  // whether the claim is honoured: the toggle renders in both states, so the
  // band can be taken back after it is handed over.
  const claimable = Boolean(contributed.band) && firstParty && compact;
  const claim = claimable && bandOwner === "app" ? contributed.band : null;

  return {
    actions: (
      <>
        {claimable ? (
          <BandOwnerToggle
            appName={app.name}
            owner={bandOwner}
            onChange={setBandOwner}
          />
        ) : null}
        {contributed.appBar?.actions ?? null}
      </>
    ),
    band: claim ? (
      <AppBand claim={claim} appName={app.name} onHome={onHome} />
    ) : undefined,
    count: contributed.appBar?.count ?? undefined,
    frame: channel.frame,
    mark: <AppMark app={app} />,
    // The installed name until the app says otherwise: a bar that was blank
    // until the app's first paint would flicker the one thing that says where
    // you are.
    title: contributed.appBar?.title ?? app.name,
  };
}
