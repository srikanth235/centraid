import { useCallback, useEffect, useRef, useState } from "react";
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

export interface HomeRouteProps {
  userApps: readonly UserAppMeta[];
  appsLoading: boolean;
  autoSeedSample?: boolean;
  onAutoSeedStarted?: () => void;
}

// Home is the springboard and nothing else (#708): a brief read and a tile read.
export default function HomeRoute(props: HomeRouteProps): JSX.Element {
  const { navigate } = useShellActions();
  const {
    appsLoading,
    userApps,
    autoSeedSample = false,
    onAutoSeedStarted,
  } = props;
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

  // `persist` deliberately writes vault CONTENT to browser storage (#708).
  const briefQuery = useCachedQuery(
    "home:brief",
    async () => getDailyBrief().catch(() => undefined),
    { persist: true }
  );

  // Imports stay lazy: the gateway client touches `window.CentraidApi` at load.
  const brief =
    briefQuery.state.status === "ready" ? briefQuery.state.data : undefined;
  // NULL until the brief settles: `useCachedQuery` keys on the KEY, not the
  // closure, so running early caches a `brief === undefined` tile set (#708).
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
        // Never a refresh: that walks the whole blob CAS, an owner action.
        import("../../../gateway-client-local-storage.js")
          .then((mod) => mod.getLocalStorageUsage())
          .catch((): LocalUsageReportDTO | undefined => undefined),
      ]);
      return { localUsage, tileContent };
    },
    {
      persist: true,
      // Thumbs are `URL.createObjectURL` handles bound to the minting document:
      // persisted they come back broken, so the stored copy keeps the count.
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
  const homeReadsSettled = springboardFeed.state.status === "ready";

  const sampleQuery = useCachedQuery("home:sample", loadHomeSample);
  const sample =
    sampleQuery.state.status === "ready" ? sampleQuery.state.data : NO_SAMPLE;
  const [clearing, setClearing] = useState(false);
  const [filling, setFilling] = useState<HomeSampleProgress | null>(null);
  const [justFilled, setJustFilled] = useState(false);
  const autoSeedStarted = useRef(false);
  const autoSeedPending = autoSeedSample;

  const refreshAfterSample = useCallback(async () => {
    // Replica FIRST, refresh SECOND: the seed's rows reach the local replica
    // only when the change feed's nudge lands, which races the refresh below.
    await syncHomeSampleReplica();
    await Promise.all([
      briefQuery.refresh(),
      springboardFeed.refresh(),
      sampleQuery.refresh(),
    ]);
  }, [briefQuery, springboardFeed, sampleQuery]);

  const onSeed = useCallback(() => {
    const total = sample.seedable.length;
    setFilling({ appId: sample.seedable[0], done: 0, total });
    void seedHomeSample(sample.seedable, (progress) => setFilling(progress))
      .then(() => setFilling({ done: total, total }))
      .then(refreshAfterSample)
      .then(() => setJustFilled(true))
      .finally(() => setFilling(null));
  }, [sample.seedable, refreshAfterSample]);

  // Seed only after the first Home reads settle, or bootstrap and the demo
  // writes contend. The ref keeps it one-shot.
  useEffect(() => {
    if (
      !autoSeedSample ||
      autoSeedStarted.current ||
      sampleQuery.state.status !== "ready" ||
      !homeReadsSettled
    ) {
      return;
    }
    autoSeedStarted.current = true;
    onAutoSeedStarted?.();
    if (sample.rows > 0 || sample.seedable.length === 0) return;
    void Promise.resolve().then(onSeed);
  }, [
    autoSeedSample,
    onAutoSeedStarted,
    onSeed,
    sample.rows,
    sample.seedable,
    sampleQuery.state.status,
    homeReadsSettled,
  ]);

  const onClear = useCallback(() => {
    setClearing(true);
    setJustFilled(false);
    void clearHomeSample()
      .catch(() => undefined)
      .then(refreshAfterSample)
      .finally(() => setClearing(false));
  }, [refreshAfterSample]);

  const gatewayAppId = (app: UserAppMeta): string =>
    app.centraidAppId ?? app.id;

  const ready =
    springboardFeed.state.status === "ready"
      ? springboardFeed.state.data
      : undefined;
  const settled = ready !== undefined;
  const tiles = buildHomeTiles({
    content: ready?.tileContent ?? {},
    installedIds: userApps.map((app) => gatewayAppId(app)),
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
    // NOT `flush` (#708): the springboard is an ordinary page body.
    <>
      <HomeHealthRibbon signal={ambientSignal} onOpen={navigate} />
      <PageScroll>
        <HomeSpringboard
          conflicts={HOME_CONFLICTS}
          // Only a SETTLED read may say a tile is empty.
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
            autoSeedPending,
          }}
          tiles={tiles}
          {...(outOfRoom ? { outOfRoom } : {})}
        />
      </PageScroll>
    </>
  );
}
