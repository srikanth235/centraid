/**
 * Scenario generator (issue #708): two weeks of a real camera roll — a Tahoe
 * scouting weekend, a city evening, an ordinary backyard sunset — so the grid,
 * the Home mosaic, favorites and albums all have something honest to render on
 * a fresh vault. Runs under the demo register: owner credential, `seed.demo`
 * provenance, invisible to automations, one-click purge. Deterministic: dates
 * derive from input.now and the roll itself is fixed bytes on disk, so a
 * reload reproduces the same scenario (tests ride this too).
 *
 * The bytes are real PNGs shipped beside this file in `sample/`, read here and
 * handed to `media.add_asset` as inline `data:` URIs. The handler worker
 * imports this file by its own path (app-engine worker/runner.ts `await
 * import(pathToFileURL(req.handlerFile).href)`), so `import.meta.url` resolves
 * to the SHIPPED app dir — bundled or cloned — and node builtins are in scope;
 * the images therefore travel with the package (`files: ["apps"]`) and need no
 * second delivery mechanism.
 *
 * Every image is <=360 px on its long edge on purpose: that is the Photos
 * grid's `THUMB_EDGE` "known small" ceiling (media.ts), so a tile paints the
 * original directly instead of probing a `?variant=thumb` derivative the
 * gateway's preview backstop has not generated yet. ThumbHash and dHash are
 * precomputed off the same rasters (the client's canvas normally pays for them
 * at upload time) so placeholders and near-duplicate detection behave exactly
 * as they would for a real import.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const PURPOSE = "dpv:ServiceProvision";
const SAMPLE_DIR = path.join(import.meta.dirname, "sample");
/** Pacific daylight time — the whole roll is one American trip. */
const TZ_OFFSET_MIN = -420;

/**
 * The roll, newest last. `day`/`hour` place each frame relative to input.now;
 * `thumbhash`/`phash` are the precomputed derivatives described above.
 */
const ROLL = [
  {
    file: "downtown-blue-hour.png",
    title: "Downtown at blue hour",
    day: -13,
    hour: 20,
    width: 360,
    height: 240,
    thumbhash: "DPcFFYJIeHl1eHdweIdoeJeAfAeI",
    phash: "3727170f8b494d6e",
  },
  {
    file: "harbor-lights.png",
    title: "Harbor lights from the pier",
    day: -13,
    hour: 21,
    width: 270,
    height: 360,
    thumbhash: "TPcFDQJoiHJ4B3dXiHqHR4hwiQcn",
    phash: "935517099b3bb235",
  },
  {
    file: "cabin-window-morning.png",
    title: "First morning from the cabin window",
    day: -11,
    hour: 7,
    width: 270,
    height: 360,
    thumbhash: "XdcVFQJ3d4+HV4hXh4eHd4dwhwk3",
    phash: "0f0f0f272b958f27",
  },
  {
    file: "trailhead-sign.png",
    title: "Trailhead before the climb",
    day: -9,
    hour: 9,
    width: 270,
    height: 360,
    thumbhash: "mOgNDQJoiI93R5dXd4h3h1iMgAeH",
    phash: "0f072f0d4d554149",
  },
  {
    file: "granite-switchback.png",
    title: "Granite switchbacks",
    day: -9,
    hour: 11,
    width: 360,
    height: 240,
    thumbhash: "G+cNLYZod3h/d3dzh1iId4iAhghY",
    phash: "0f0f0f171f9f0f97",
  },
  {
    file: "sand-harbor-dawn.png",
    title: "Sand Harbor at dawn",
    day: -4,
    hour: 6,
    width: 360,
    height: 240,
    thumbhash: "JNcJDYJYd3d/d4d0iCeIh5hwgAkn",
    phash: "1f0f0f0e57334f25",
  },
  {
    file: "truckee-river-bend.png",
    title: "Bend in the Truckee",
    day: -4,
    hour: 10,
    width: 360,
    height: 240,
    thumbhash: "m9cJFYQ3eIh/eXeGh0h3dKhwhApY",
    phash: "170f0f0b1b09071f",
    favorite: true,
  },
  {
    file: "emerald-bay-overlook.png",
    title: "Emerald Bay overlook",
    day: -3,
    hour: 19,
    width: 360,
    height: 240,
    thumbhash: "UwcKDYJnd3iPd4dzh1iHhrdwc/hX",
    phash: "1f0f0f1337250d17",
    favorite: true,
  },
  {
    file: "tahoe-dusk-ridge.png",
    title: "Dusk over the west shore",
    day: -3,
    hour: 20,
    width: 360,
    height: 240,
    thumbhash: "DAcKDYJod3d7h4hweHiIeJiAi2gH",
    phash: "1d2b070f5b371e4b",
  },
  {
    file: "backyard-last-light.png",
    title: "Last light in the backyard",
    day: -1,
    hour: 19,
    width: 360,
    height: 240,
    thumbhash: "GDgOJYhneHiIeHeAiKh3h3eAcVcI",
    phash: "0f170f0f0f4f4bc9",
  },
];

/** The four frames that made the "where are we staying" shortlist. */
const ALBUM_TITLE = "Tahoe scouting";
const ALBUM_FILES = [
  "emerald-bay-overlook.png",
  "tahoe-dusk-ridge.png",
  "truckee-river-bend.png",
  "granite-switchback.png",
];
const ALBUM_COVER = "emerald-bay-overlook.png";

export default async function seedHandler({ input, log, ctx }) {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const at = (day, hour) => {
    const stamp = new Date(now + day * 86400000);
    stamp.setUTCHours(hour, 0, 0, 0);
    return stamp.toISOString();
  };
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({
      command,
      input: args,
      purpose: PURPOSE,
    });
    if (out.status !== "executed") {
      throw new Error(`${command} ${out.status}: ${out.reason ?? "no reason"}`);
    }
    return out.output;
  };

  // Uploads run STRICTLY in order (recursion, not Promise.all): asset ids are
  // minted per invoke, so a parallel roll would shuffle the timeline's tie
  // breaks and the album's member positions run to run — and determinism is
  // the whole contract of a scenario generator.
  const assetIdByFile = new Map();
  const addFrame = async (index) => {
    const frame = ROLL[index];
    if (!frame) return;
    const bytes = readFileSync(path.join(SAMPLE_DIR, frame.file));
    const added = await invoke("media.add_asset", {
      data_uri: `data:image/png;base64,${bytes.toString("base64")}`,
      kind: "photo",
      title: frame.title,
      captured_at: at(frame.day, frame.hour),
      tz_offset_min: TZ_OFFSET_MIN,
      width: frame.width,
      height: frame.height,
      thumbhash: frame.thumbhash,
      phash: frame.phash,
    });
    assetIdByFile.set(frame.file, added.asset_id);
    // The general editor rather than set_favorite: one command, and it is the
    // path the app's own detail pane takes.
    if (frame.favorite)
      await invoke("media.update_asset", {
        asset_id: added.asset_id,
        favorite: 1,
      });
    return addFrame(index + 1);
  };
  await addFrame(0);

  const album = await invoke("media.create_album", { title: ALBUM_TITLE });
  const addMember = async (index) => {
    const file = ALBUM_FILES[index];
    if (!file) return;
    await invoke("media.add_to_album", {
      album_id: album.album_id,
      asset_id: assetIdByFile.get(file),
    });
    return addMember(index + 1);
  };
  await addMember(0);
  await invoke("media.set_album_cover", {
    album_id: album.album_id,
    asset_id: assetIdByFile.get(ALBUM_COVER),
  });

  log.info(
    `photos scenario: ${ROLL.length} assets seeded (2 favorites, 1 album of ${ALBUM_FILES.length})`
  );
  return { seeded: ROLL.length };
}
