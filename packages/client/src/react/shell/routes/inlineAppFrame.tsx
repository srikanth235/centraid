import type { JSX, ReactNode } from "react";

import type { InlineFrame } from "@centraid/blueprints/apps/inline-types";

import AppBand from "../AppBand.js";
import { iconSvg } from "../iconSvg.js";
import { useInlineFrameChannel, useInlineFrameState } from "../inlineFrame.js";
import { useBandOwner } from "../useBandOwner.js";

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

export function useInlineAppFrame({
  app,
  mountKey,
  firstParty,
  compact,
  onHome,
}: InlineAppFrameOpts): InlineAppFrameSlots {
  const channel = useInlineFrameChannel(mountKey);
  const contributed = useInlineFrameState(channel);
  const { bandOwner } = useBandOwner(app.id);

  const claim =
    contributed.band && firstParty && compact && bandOwner === "app"
      ? contributed.band
      : null;

  return {
    actions: contributed.appBar?.actions ?? null,
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
