import type { JSX, ReactNode } from "react";

import type { InlineFrame } from "@centraid/blueprints/apps/inline-types";

import AppMarkGlyph from "../../ui/AppMark.js";
import AppBand from "../AppBand.js";
import { useInlineFrameChannel, useInlineFrameState } from "../inlineFrame.js";

const MARK_SIZE = 26;

export interface InlineAppFrameOpts {
  app: AppMetaResolvedType;
  mountKey: string;
  firstParty: boolean;
  compact: boolean;
  onHome: () => void;
}

export interface InlineAppFrameSlots {
  frame: InlineFrame;
  mark: ReactNode;
  title: string;
  count: ReactNode;
  actions: ReactNode;
  band: ReactNode;
}

function AppMark({ app }: { app: AppMetaResolvedType }): JSX.Element {
  return (
    <AppMarkGlyph
      colorKey={app.colorKey}
      iconKey={app.iconKey}
      size={MARK_SIZE}
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

  const claimable = Boolean(contributed.band) && firstParty && compact;
  const claim = claimable ? contributed.band : null;

  return {
    actions: contributed.appBar?.actions ?? null,
    band: claim ? (
      <AppBand claim={claim} appName={app.name} onHome={onHome} />
    ) : undefined,
    count: contributed.appBar?.count ?? undefined,
    frame: channel.frame,
    mark: <AppMark app={app} />,
    title: contributed.appBar?.title ?? app.name,
  };
}
