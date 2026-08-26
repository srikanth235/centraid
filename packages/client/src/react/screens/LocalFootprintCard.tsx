import { useMemo, useState } from "react";
import type { JSX } from "react";

import type { LocalUsageReportDTO } from "../../gateway-client-local-storage.js";
import { cx } from "../ui/cx.js";
import Icon from "../ui/Icon.js";
import {
  budgetSummary,
  footprintScale,
  footprintSlices,
  formatBytes,
} from "./localUsageView.js";

import a11y from "../styles/a11y.module.css";
import controlsCss from "../styles/controls.module.css";
import gwStyles from "./GatewayScreen.module.css";
import styles from "./LocalFootprintCard.module.css";

// Storage → Footprint (#544): what Centraid is using on THIS machine,
// split by component. The page's opening statement, so it leads with one
// figure and one rail rather than a table — "how much, and how close to the
// line" is the question; the breakdown is the follow-up.
//
// The rail is drawn against the owner's budget when they set one, and against
// the physical disk otherwise (see `footprintScale` for why never against
// free space). Over budget, the fill hatches rather than merely reddening:
// crossing a line the owner drew themselves should look like crossing it.

export interface LocalFootprintCardProps {
  report: LocalUsageReportDTO | null;
  loadError: string | null;
  /**
   * A full re-walk is in flight. The VERB lives on `StorageScreen`'s section
   * head (v11) — this card only needs to know so its figures can say they are
   * being remeasured; it no longer owns the button.
   */
  rescanning: boolean;
}

function OccupancyRail({
  report,
}: {
  report: LocalUsageReportDTO;
}): JSX.Element {
  const scale = footprintScale(report);
  const slices = footprintSlices(report);

  if (scale.kind === "none") {
    return (
      <div className={controlsCss.note}>
        Nothing measurable on this volume yet.
      </div>
    );
  }

  return (
    <div className={styles.rail} data-over={scale.over || undefined}>
      <div className={styles.railTrack}>
        {/* The bar is a row of hue segments, not an image: the reading it used
            to fake with `role="img"` is real text now (absolutely positioned,
            so it is not a flex item and costs no gap). */}
        <span className={a11y.srOnly}>
          {`${formatBytes(report.totalBytes)} used of ${formatBytes(scale.againstBytes ?? 0)}`}
        </span>
        {/* Each component keeps its own hue; widths are shares of the SCALE,
            not of the total, so the bar and the denominator agree. */}
        {slices.map((slice) => (
          <span
            key={slice.component}
            className={styles.railSegment}
            style={{
              width: `${(slice.fraction * scale.fillFraction * 100).toFixed(3)}%`,
              background: slice.color,
            }}
            title={`${slice.label} — ${formatBytes(slice.bytes)}`}
          />
        ))}
        {scale.warnFraction === null ? null : (
          <span
            className={styles.railWarnMark}
            style={{ left: `${(scale.warnFraction * 100).toFixed(2)}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      <div className={styles.railFoot}>
        <span>0</span>
        <span className={styles.railCap}>
          {formatBytes(scale.againstBytes ?? 0)}
          <span className={styles.railCapKind}>
            {scale.kind === "budget" ? "budget" : "this disk"}
          </span>
        </span>
      </div>
    </div>
  );
}

export default function LocalFootprintCard({
  report,
  loadError,
  rescanning,
}: LocalFootprintCardProps): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const slices = useMemo(
    () => (report ? footprintSlices(report) : []),
    [report]
  );

  return (
    <section
      className={cx(gwStyles.panel, styles.card)}
      data-testid="local-footprint-card"
    >
      {/* NO HEAD OF ITS OWN (binding layer v11). "Capacity · 8.2 GB of 512 GB"
          and the Rescan verb are `StorageScreen`'s section head, above this
          container: a head inside the border reads as a caption on the card
          rather than as the name of this stretch of the page, and the figure
          was being stated twice — once in the head, once as the headline. */}
      <div className={styles.body}>
        {loadError ? (
          <div className={styles.loadError}>
            Couldn’t measure local storage: {loadError}
          </div>
        ) : report ? (
          <>
            {/* `data-measuring` mutes the figures while a re-walk is in
                flight: they are the PREVIOUS measurement until it lands, and a
                number that looks live while it is stale is the one thing this
                card must never do. */}
            <div
              className={styles.headline}
              data-measuring={rescanning || undefined}
              data-status={report.limit.status}
            >
              <span className={styles.headlineFigure}>
                {formatBytes(report.totalBytes)}
              </span>
              <span className={styles.headlineNote}>
                {budgetSummary(report, report.limits)}
              </span>
            </div>

            <OccupancyRail report={report} />

            {report.error ? (
              <div className={styles.staleNote}>
                Last measurement failed ({report.error}) — showing the previous
                figures.
              </div>
            ) : null}

            <div className={styles.legend} data-testid="footprint-legend">
              {slices.map((slice, index) => {
                const open = expanded === slice.component;
                return (
                  <button
                    key={slice.component}
                    type="button"
                    className={styles.legendRow}
                    style={{ animationDelay: `${index * 40}ms` }}
                    aria-expanded={open}
                    onClick={() => setExpanded(open ? null : slice.component)}
                  >
                    <i
                      className={styles.chip}
                      style={{ background: slice.color }}
                    />
                    <span className={styles.legendLabel}>{slice.label}</span>
                    <span className={styles.legendShare}>
                      {(slice.fraction * 100).toFixed(
                        slice.fraction >= 0.1 ? 0 : 1
                      )}
                      %
                    </span>
                    <span className={cx(styles.figure, styles.legendBytes)}>
                      {formatBytes(slice.bytes)}
                    </span>
                    {open ? (
                      <span className={styles.legendBlurb}>
                        {slice.blurb}
                        {slice.unreadable
                          ? ` Part of this tree is unreadable (${slice.unreadable}), so the figure is a floor.`
                          : ""}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {report.disk ? (
              <div className={styles.diskLine}>
                <Icon name="Gauge" size={13} />
                <span>
                  {formatBytes(report.disk.freeBytes)} free of{" "}
                  {formatBytes(report.disk.totalBytes)} on this disk
                </span>
              </div>
            ) : null}
          </>
        ) : (
          <div className={gwStyles.panelEmpty}>Measuring what’s on disk…</div>
        )}
      </div>
    </section>
  );
}
