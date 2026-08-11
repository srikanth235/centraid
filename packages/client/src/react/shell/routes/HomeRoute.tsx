import { useCallback, useEffect, useRef, useState } from "react";
import type { JSX } from "react";

import type { LocalUsageReportDTO } from "../../../gateway-client-local-storage.js";
import { getDailyBrief } from "../../../gateway-client.js";
import HomeSpringboard from "../../screens/HomeSpringboard.js";
import { useShellActions } from "../actions.js";
import PageScroll from "../PageScroll.js";
import { useCachedQuery } from "../queryCache.js";
import { HOME_CONFLICTS, homeOutOfRoom } from "./homeConditions.js";
import {
  autoSeedVaultId,
  clearHomeSample,
  hasAutoSeeded,
  loadHomeSample,
  markAutoSeeded,
  NO_SAMPLE,
  seedHomeSample,
  syncHomeSampleReplica,
} from "./homeSample.js";
import type { HomeSampleProgress } from "./homeSample.js";
import { buildHomeTiles } from "./homeTiles.js";
import type { HomeTileContent } from "./homeTiles.js";

/** The whole of Home's input: which apps this vault has. Everything a tile
 *  shows is CONTENT, so the route reads it rather than taking it as a prop. */
export interface HomeRouteProps {
  userApps: readonly UserAppMeta[];
  drafts: readonly DraftAppMeta[];
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
  const { userApps, drafts } = props;

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

  /*
   * The one automatic fill.
   *
   * A vault's first Home fills itself, so the front door makes the product's
   * argument instead of asking the member to accept an offer that demonstrates
   * nothing until they do. Everything about the fill is otherwise unchanged —
   * same generators, same working state, and the same "Sample data · Clear the
   * sample" note that `SampleLoaded` already draws once the rows land.
   *
   * Four guards, and each one is load-bearing:
   *
   *   • `attempted` — a ref, not state, because it must be true for the REST OF
   *     THIS MOUNT the instant the effect commits. State would not settle until
   *     the next render, and the sample query refreshing mid-fill would re-enter
   *     here and start a second run over the first.
   *   • the query being `ready` — `NO_SAMPLE` is what an in-flight or failed
   *     read looks like, and it is indistinguishable from "empty vault" on the
   *     two fields below. Filling on a read that has not landed yet would seed a
   *     vault that is already full.
   *   • `rows === 0` — never write over a vault that already has sample rows.
   *   • `hasAutoSeeded` — the durable half, and the reason "Clear the sample"
   *     means something. It is marked BEFORE the fill runs, so a fill that dies
   *     halfway costs this vault its automatic demonstration rather than
   *     retrying on every visit forever.
   */
  const attempted = useRef(false);
  useEffect(() => {
    if (attempted.current) return;
    if (sampleQuery.state.status !== "ready") return;
    if (sample.rows > 0 || sample.seedable.length === 0) return;
    attempted.current = true;
    void (async () => {
      const vaultId = await autoSeedVaultId();
      if (vaultId === null || (await hasAutoSeeded(vaultId))) return;
      await markAutoSeeded(vaultId);
      onSeed();
    })();
  }, [sampleQuery.state.status, sample.rows, sample.seedable.length, onSeed]);

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

  return (
    // NOT `flush` (issue #708). `flush` drops the page gutter for a screen whose
    // content owns its own spacing — true of the day-one card, which carries
    // `--sp-6` of its own, and false of everything else Home draws. So the
    // moment one tile had content the grid and the start band ran edge to edge
    // and the band's heading clipped against the frame: Home looked right on
    // first paint and wrong on every return, which is exactly when a member
    // notices. The springboard is an ordinary page body and takes the ordinary
    // gutter (compact-aware since `mainScroll` learned the 720px step).
    <PageScroll>
      <HomeSpringboard
        conflicts={HOME_CONFLICTS}
        // Only a SETTLED read can say a tile is empty. While the reads are in
        // flight the springboard shows static skeletons, which is a different
        // sentence: "still looking", not "there is nothing" — so `loading`
        // gates the whole graded treatment rather than one branch of it.
        loading={!settled}
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
  );
}
