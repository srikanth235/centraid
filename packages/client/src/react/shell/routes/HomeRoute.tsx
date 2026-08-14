import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";

import type { LocalUsageReportDTO } from "../../../gateway-client-local-storage.js";
import {
  getDailyBrief,
  getGatewayBackupStatus,
  listGatewayDevices,
} from "../../../gateway-client.js";
import { seat } from "../../host-platform.js";
import HomeHealthRibbon from "../../screens/HomeHealthRibbon.js";
import HomeSpringboard from "../../screens/HomeSpringboard.js";
import { useShellActions } from "../actions.js";
import { ambientSignalFor } from "../ambientStatus.js";
import PageScroll from "../PageScroll.js";
import { useCachedQuery } from "../queryCache.js";
import { useGatewayStatus } from "../useGatewayRuntime.js";
import { HOME_CONFLICTS, homeOutOfRoom } from "./homeConditions.js";
import {
  clearHomeSample,
  loadHomeSample,
  NO_SAMPLE,
  seedHomeSample,
  syncHomeSampleReplica,
} from "./homeSample.js";
import type { HomeSampleProgress } from "./homeSample.js";
import { buildHomeTiles } from "./homeTiles.js";
import type { HomeTileContent } from "./homeTiles.js";
import { startVisibilityTicker } from "./visibility-ticker.js";

/** The whole of Home's input: which apps this vault has. Everything a tile
 *  shows is CONTENT, so the route reads it rather than taking it as a prop. */
export interface HomeRouteProps {
  userApps: readonly UserAppMeta[];
  drafts: readonly DraftAppMeta[];
  /** The installed-app registry must settle before Home can call anything empty. */
  appsLoading: boolean;
}

// Home (issue #708). Home is the springboard and nothing else: the app bar
// carries the title, the meta and the two actions, and the body is the content
// grid. The composer hero and the All/Apps/Automations library shelf that used
// to sit under it are gone — Home shows you your own content, and the shelf's
// job ("which things do I own") belongs to the All apps sheet and to Starred.
//
// The route's remaining work is the two reads the springboard eats: the daily
// brief and the per-app tile content.
export default function HomeRoute(props: HomeRouteProps): JSX.Element {
  const { navigate } = useShellActions();
  const { appsLoading, userApps, drafts } = props;
  const [ambientNow, setAmbientNow] = useState(() => Date.now());
  useEffect(
    () => startVisibilityTicker(() => setAmbientNow(Date.now()), 60_000),
    []
  );
  const gatewayStatus = useGatewayStatus();
  const ambientQuery = useCachedQuery("home:ambient-signal", async () => {
    const readAt = Date.now();
    const [backup, devices] = await Promise.all([
      getGatewayBackupStatus().catch(() => undefined),
      listGatewayDevices().catch(() => undefined),
    ]);
    const lastBackupAt = backup?.vaults
      .map((vault) => vault.lastBackupAt)
      .filter((value): value is string => value !== undefined)
      .map((value) => Date.parse(value))
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    return {
      deviceCount: devices?.length,
      lastBackupAt,
      lastKnownAt: readAt,
    };
  });

  // Cached across visits (issue #659) AND across boots (#708). Home is the
  // app's front door and the most re-entered route in the shell, so it paints
  // from the last known answer and revalidates behind it.
  //
  // `persist` is what makes the second sentence true. The in-memory cache dies
  // with the JS context, so a reload — or the OS evicting an installed PWA —
  // put Home back to skeletons even though the member had just been looking at
  // it. Both keys hold vault CONTENT (event titles, a note's first line), so
  // this is a deliberate decision to write that to unencrypted browser storage
  // on the member's own device, in exchange for the front door opening
  // instantly. It is purged whenever the shell re-scopes, so it cannot outlive
  // the vault it describes.
  const briefQuery = useCachedQuery(
    "home:brief",
    async () => getDailyBrief().catch(() => undefined),
    { persist: true }
  );

  // Two queries, not one, because the second READS the first: the gateway's
  // daily brief is what the agenda, tasks and tally tiles are made of, so the
  // tile content can only be derived once the brief has settled. Splitting
  // them also keeps the eight replica reads and the disk-budget probe off the
  // brief's critical path.
  //
  // Everything here is imported lazily for the reason `blob-auth.ts`
  // documents — the authed gateway client touches `window.CentraidApi` at
  // module load, so an eager import drags the whole transport into Home's
  // chunk.
  const brief =
    briefQuery.state.status === "ready" ? briefQuery.state.data : undefined;
  // NULL until the brief has settled (issue #708). `useCachedQuery` treats the
  // KEY as the loader's identity — an inline closure that captures a different
  // `brief` is deliberately NOT a change — so running this while the brief was
  // still in flight cached a `tileContent` built from `brief === undefined` and
  // never recomputed it. That is the whole bug behind "I seeded the vault and
  // Home still says nothing is here": agenda, tasks and the tally figure are
  // MADE of the brief, so they were permanently absent from the cached answer
  // while the seeded rows sat on the gateway. Gating the key costs one settle
  // (the brief hydrates from its own persisted copy on the first render, so in
  // practice this is the same frame) and makes the dependency real.
  const springboardFeed = useCachedQuery(
    briefQuery.state.status === "loading" ? null : "home:springboard",
    async () => {
      const [tileContent, localUsage] = await Promise.all([
        import("./homeTileContent.js")
          .then(async (mod) =>
            mod.loadHomeTileContent({
              brief,
              reader: await mod.homeTileReader(),
            })
          )
          .catch((): HomeTileContent => ({})),
        // Never a refresh — that forces a walk of the whole blob CAS, which is
        // an explicit owner action, not something Home does on every visit.
        import("../../../gateway-client-local-storage.js")
          .then((mod) => mod.getLocalStorageUsage())
          .catch((): LocalUsageReportDTO | undefined => undefined),
      ]);
      return { localUsage, tileContent };
    },
    {
      persist: true,
      // The mosaic's thumbnails are `URL.createObjectURL` handles (see
      // `authorizeBlobUrl`), bound to the document that minted them. Persisted,
      // they would come back as four broken images on exactly the boot this is
      // meant to make instant — so the stored copy keeps the COUNT and lets the
      // tile re-authorize its own pictures. Everything else survives verbatim.
      toPersisted: (data) => ({
        ...data,
        tileContent: data.tileContent.photos
          ? {
              ...data.tileContent,
              photos: { ...data.tileContent.photos, thumbs: [] },
            }
          : data.tileContent,
      }),
    }
  );

  // The sample plane (#708). Cheap, cached, and fail-soft to "no offer" — a
  // gateway that cannot answer should cost the member an offer, never the
  // whole front door.
  const sampleQuery = useCachedQuery("home:sample", loadHomeSample);
  const sample =
    sampleQuery.state.status === "ready" ? sampleQuery.state.data : NO_SAMPLE;
  const [clearing, setClearing] = useState(false);
  // The fill's position, or null when none is running. State rather than a
  // boolean because the wait is TEN SECONDS long — seven generators, of which
  // photos alone is ten uploads — and the only honest way to hold somebody
  // through that is to say which one is running and how many are left.
  const [filling, setFilling] = useState<HomeSampleProgress | null>(null);
  // True for the render right after a seed lands: the grid arrives staggered
  // once, as the payoff for pressing, and never again on a routine revisit.
  const [justFilled, setJustFilled] = useState(false);

  const refreshAfterSample = useCallback(async () => {
    // Replica FIRST, refresh SECOND — the order is the fix for "I pressed the
    // button and nothing filled in". The tiles read the local replica, and the
    // seed's rows only reach it when the change feed's nudge lands, which
    // races the refresh below; pulling explicitly makes the refreshed queries
    // see the seeded (or purged) rows instead of the pre-press state.
    // `syncHomeSampleReplica` is fail-soft by contract, so a sync that cannot
    // run still lets the refresh repaint whatever IS local.
    await syncHomeSampleReplica();
    // Both reads, because a seed writes rows the springboard reads AND changes
    // the demo plane's own row count.
    await Promise.all([
      briefQuery.refresh(),
      springboardFeed.refresh(),
      sampleQuery.refresh(),
    ]);
  }, [briefQuery, springboardFeed, sampleQuery]);

  const onSeed = useCallback(() => {
    const total = sample.seedable.length;
    // Set before the run so the control is never briefly pressable twice, and
    // so an empty `seedable` — which emits no progress at all — still shows a
    // block rather than a live button over a promise that is already settling.
    setFilling({ appId: sample.seedable[0], done: 0, total });
    void seedHomeSample(sample.seedable, (progress) => setFilling(progress))
      // The catch-up is a STEP, and it is named as one: the generators have all
      // returned, so the counts are full, but the rows are on the gateway and
      // the tiles read the local replica — `refreshAfterSample` pulls it before
      // it refetches. Leaving the last app's sentence up across that pull is
      // how "the bar filled and then nothing happened" gets built.
      .then(() => setFilling({ done: total, total }))
      .then(refreshAfterSample)
      .then(() => setJustFilled(true))
      .finally(() => setFilling(null));
  }, [sample.seedable, refreshAfterSample]);

  const onClear = useCallback(() => {
    setClearing(true);
    setJustFilled(false);
    void clearHomeSample()
      .catch(() => undefined)
      .then(refreshAfterSample)
      .finally(() => setClearing(false));
  }, [refreshAfterSample]);

  const apps: AppMetaResolvedType[] = [...userApps, ...drafts];
  /** The gateway app id (a bundled install keeps its own id). */
  const gatewayAppId = (app: AppMetaResolvedType): string =>
    (app as UserAppMeta).centraidAppId ?? app.id;

  // The springboard's tiles are the FIRST-PARTY apps this vault actually has.
  // Since #708 that is all eight: the gateway installs every bundled app at
  // vault mount, so Home opens on the full grid rather than on whatever the
  // member had got round to acquiring from a catalogue.
  const ready =
    springboardFeed.state.status === "ready"
      ? springboardFeed.state.data
      : undefined;
  const settled = ready !== undefined;
  const tiles = buildHomeTiles({
    content: ready?.tileContent ?? {},
    installedIds: apps.map((app) => gatewayAppId(app)),
  });
  const outOfRoom = homeOutOfRoom(ready?.localUsage, () =>
    navigate({ kind: "storage" })
  );
  const ambientFacts =
    ambientQuery.state.status === "ready" ? ambientQuery.state.data : undefined;
  const ambientSignal = ambientSignalFor({
    gatewayStatus,
    now: ambientNow,
    seat: seat(),
    ...(ambientFacts?.deviceCount === undefined
      ? {}
      : { deviceCount: ambientFacts.deviceCount }),
    ...(ambientFacts?.lastBackupAt === undefined
      ? {}
      : { lastBackupAt: ambientFacts.lastBackupAt }),
    ...(ambientFacts?.lastKnownAt === undefined
      ? {}
      : { lastKnownAt: ambientFacts.lastKnownAt }),
  });

  return (
    // NOT `flush` (issue #708). `flush` drops the page gutter for a screen whose
    // content owns its own spacing — true of the day-one card, which carries
    // `--sp-6` of its own, and false of everything else Home draws. So the
    // moment one tile had content the grid and the start band ran edge to edge
    // and the band's heading clipped against the frame: Home looked right on
    // first paint and wrong on every return, which is exactly when a member
    // notices. The springboard is an ordinary page body and takes the ordinary
    // gutter (compact-aware since `mainScroll` learned the 720px step).
    <>
      <HomeHealthRibbon signal={ambientSignal} onOpen={navigate} />
      <PageScroll>
        <HomeSpringboard
          conflicts={HOME_CONFLICTS}
          // Only a SETTLED read can say a tile is empty. While the reads are in
          // flight the springboard shows static skeletons, which is a different
          // sentence: "still looking", not "there is nothing" — so `loading`
          // gates the whole graded treatment rather than one branch of it.
          loading={appsLoading || !settled}
          justFilled={justFilled}
          onConnect={() => navigate({ kind: "connectors" })}
          onOpen={(id: string) => navigate({ kind: "app", id })}
          sample={{
            canSeed: sample.seedable.length > 0,
            clearing,
            filling,
            loaded: sample.rows > 0,
            onClear,
            onSeed,
          }}
          tiles={tiles}
          {...(outOfRoom ? { outOfRoom } : {})}
        />
      </PageScroll>
    </>
  );
}
