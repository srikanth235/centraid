import React, { useEffect, useId, useMemo } from "react";

import { claimStatusHost } from "./status-host";
import StatusLine from "./StatusLine";

export interface StatusLineHostProps {
  /** A name for the presentation, used only to make the id readable. */
  name?: string;
}

/**
 * The status line, hosted INSIDE a presentation that covers the app root
 * (#1015, S3 — audit B5). An iOS `Modal` renders in its own root view, so the
 * root `StatusLine` paints underneath it; an editor or sheet mounts this
 * inside its own tree and the same one channel paints there while it is up.
 *
 * There is still exactly one line and one channel — this only claims WHERE it
 * paints. The claim is dropped on unmount and the root takes the line back.
 */
export default function StatusLineHost({
  name = "host",
}: StatusLineHostProps = {}): React.JSX.Element {
  // `useId` rather than a counter: the id has to be stable across this
  // component's own re-renders and unique against every other host, and that
  // is exactly what React already guarantees.
  const id = `${name}-${useId()}`;
  // The claim is an effect, not render work: a render that pushed would push
  // again on every re-render and on a discarded concurrent render.
  useEffect(() => claimStatusHost(id), [id]);
  return useMemo(() => <StatusLine hostId={id} />, [id]);
}
