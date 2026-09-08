/**
 * Scenario generator (issue #708): two weeks of a real camera roll — a Tahoe
 * scouting weekend, a city evening, an ordinary backyard sunset — so the grid,
 * the Home mosaic, favorites, albums and Places all have something honest to
 * render on a fresh vault. Runs under the demo register: owner credential, `seed.demo`
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

const SAMPLE_DIR = path.join(import.meta.dirname, "sample");
/** Pacific daylight time — the whole roll is one American trip. */
const TZ_OFFSET_MIN = -420;

/**
 * WHERE THE ROLL WAS SHOT.
 *
 * Places was the one shelf a seeded vault could not exercise: `placeSections`
 * only emits a section for assets that actually carry a place, and nothing in
 * this scenario carried one, so the shelf read "Places 0" on a vault that was
 * otherwise full. That looked like a missing feature and was really missing
 * data.
 *
 * The pairs below are the real coordinates of the places these frames are
 * named after, so the shelf groups the way a genuine Tahoe roll would. Three
 * properties are deliberate rather than incidental, because each one is a
 * behaviour worth being able to see:
 *
 *   - Several frames SHARE a coordinate. `findOrCreatePlaceTx` rounds to four
 *     decimals (~11m) for identity, so those collapse into one place row with
 *     a count above 1 — which is the only way to tell grouping works from
 *     grouping being skipped.
 *   - Portraits share coordinates with landscapes (Ana at the trailhead sits
 *     at the trailhead), so People and Places intersect on the same asset.
 *   - The home frames sit hundreds of kilometres from the trip, so the shelf
 *     has to show a trip and a home rather than one undifferentiated blob.
 *
 * Frames deliberately left OUT of this table stay place-less. A camera roll
 * where every frame knows where it was is not a camera roll anyone has, and
 * the "photograph nobody told where it was taken" path needs a case too.
 */
const HOME_BACKYARD = { lat: 37.4419, lng: -122.143 };
const EMBARCADERO = { lat: 37.7955, lng: -122.3937 };
const TALLAC_TRAILHEAD = { lat: 38.9186, lng: -120.0836 };
const WEST_SHORE_RIDGE = { lat: 39.0021, lng: -120.1131 };
const PLACE_BY_FILE = {
  "downtown-blue-hour.png": EMBARCADERO,
  "harbor-lights.png": EMBARCADERO,
  "marco-harbor-wall.png": EMBARCADERO,
  "cabin-window-morning.png": { lat: 39.0682, lng: -120.1268 },
  "trailhead-sign.png": TALLAC_TRAILHEAD,
  "ana-trailhead.png": TALLAC_TRAILHEAD,
  "granite-switchback.png": { lat: 38.9067, lng: -120.0917 },
  "sand-harbor-dawn.png": { lat: 39.1979, lng: -119.9308 },
  "truckee-river-bend.png": { lat: 39.1682, lng: -120.1429 },
  "emerald-bay-overlook.png": { lat: 38.9542, lng: -120.1094 },
  "tahoe-dusk-ridge.png": WEST_SHORE_RIDGE,
  "tahoe-pan.mp4": WEST_SHORE_RIDGE,
  "backyard-last-light.png": HOME_BACKYARD,
  "ana-kitchen-window.png": HOME_BACKYARD,
  "ana-porch-evening.png": HOME_BACKYARD,
  "ana-and-marco-table.png": HOME_BACKYARD,
};

/** The coordinate fields `media.add_asset` takes, or nothing when the frame
 *  carries no location. Spread into the call so a place-less frame sends no
 *  half-pair — the command refuses one coordinate without the other. */
function placeInput(file) {
  const spot = PLACE_BY_FILE[file];
  return spot ? { latitude: spot.lat, longitude: spot.lng } : {};
}

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
    monthOffset: -24,
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
    monthOffset: -24,
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
    monthOffset: -13,
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
    monthOffset: -8,
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
    monthOffset: -4,
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

/**
 * The PORTRAIT half of the roll (issue #712 test seeding). The landscape roll
 * above has no people in it, so People, face review and the whole triage verb
 * had nothing to render on a fresh vault — the one flow this pass rewrote was
 * also the one flow a seeded vault could not reach.
 *
 * These are original procedurally drawn frames, not photographs of anyone and
 * not any third party's character art: the sample dir ships inside the package
 * (`files: ["apps"]`), so every byte here has to be ours to distribute. They
 * are drawn with HUMAN face geometry rather than a stylised/anime one, because
 * a face detector trained on human faces is what would eventually run over
 * them.
 *
 * `faces` carries the EXACT normalised boxes the generator drew, staged below
 * as `media.face_region` proposals. That deliberately bypasses detection: the
 * device work-lease lane does not run in an iOS simulator at all (Expo skips
 * background task registration there), and #712 changed the ANSWERING of
 * proposals — `media.answer_face_proposal`, `review_state`, the shared triage
 * session — not the finding of them. Seeding the rows tests what changed.
 */
const PORTRAITS = [
  {
    file: "ana-kitchen-window.png",
    title: "Ana by the kitchen window",
    day: -12,
    hour: 9,
    width: 270,
    height: 360,
    thumbhash: "6QcKHQTqdn9pZme4V3x1Z3dvUvQF",
    phash: "303878783ce480c0",
    faces: [
      {
        bbox: { x: 0.3374, y: 0.1795, w: 0.4511, h: 0.4743 },
        confidence: 0.94,
      },
    ],
  },
  {
    file: "marco-workshop.png",
    title: "Marco in the workshop",
    day: -10,
    hour: 15,
    width: 270,
    height: 360,
    thumbhash: "oSgKDQTod496lmfIV3x1ZzeAdQSI",
    phash: "0070706c70e88080",
    faces: [
      {
        bbox: { x: 0.2778, y: 0.1769, w: 0.4667, h: 0.4907 },
        confidence: 0.94,
      },
    ],
  },
  {
    file: "ana-trailhead.png",
    title: "Ana at the trailhead",
    day: -8,
    hour: 11,
    width: 270,
    height: 360,
    thumbhash: "pecJHQTXeH+KdmjXSIxlZ0iJgIAI",
    phash: "0070704454c88080",
    faces: [
      { bbox: { x: 0.2478, y: 0.1909, w: 0.4822, h: 0.507 }, confidence: 0.94 },
    ],
  },
  {
    file: "marco-harbor-wall.png",
    title: "Marco by the harbour wall",
    day: -6,
    hour: 17,
    width: 270,
    height: 360,
    thumbhash: "IQgKHQjZd495lmfIV3tmaDaAZwN4",
    phash: "0030705064ec80c0",
    faces: [
      {
        bbox: { x: 0.3191, y: 0.2058, w: 0.4433, h: 0.4661 },
        confidence: 0.94,
      },
    ],
  },
  {
    file: "ana-and-marco-table.png",
    title: "Ana and Marco at the table",
    day: -4,
    hour: 20,
    width: 270,
    height: 360,
    thumbhash: "pCgODQKZp3+IuHe4d4lIWFDuBHRO",
    phash: "0000ccccbcba30dc",
    faces: [
      {
        bbox: { x: 0.1326, y: 0.2868, w: 0.3422, h: 0.3598 },
        confidence: 0.94,
      },
      { bbox: { x: 0.5435, y: 0.2938, w: 0.35, h: 0.368 }, confidence: 0.94 },
    ],
  },
  {
    file: "ana-profile-doorway.png",
    title: "Someone in the doorway",
    day: -3,
    hour: 18,
    width: 270,
    height: 360,
    thumbhash: "IwgOFQSQd2iXd4iYaIl2eISfYOYJ",
    phash: "0060e0a890100000",
    faces: [
      {
        bbox: { x: 0.1978, y: 0.2485, w: 0.4044, h: 0.4252 },
        confidence: 0.61,
      },
    ],
  },
  {
    file: "ana-porch-evening.png",
    title: "Ana on the porch",
    day: -2,
    hour: 19,
    width: 270,
    height: 360,
    thumbhash: "oygKNQaod496hoe3V3yUZ5h/hvlX",
    phash: "007070544cec8086",
    faces: [
      {
        bbox: { x: 0.3046, y: 0.1807, w: 0.4278, h: 0.4498 },
        confidence: 0.94,
      },
    ],
  },
  {
    file: "empty-hallway.png",
    title: "The hallway, no one in it",
    day: -1,
    hour: 13,
    width: 270,
    height: 360,
    thumbhash: "aAgKBQB3iI94d4iXd3iHiEd/dYA3",
    phash: "0030300c0c0c0000",
    faces: [],
  },
];

/** Named so a confirmed proposal has someone to be. Face review never invents
 *  a person — the member picks one, so the roster has to exist first. */
const FACE_PEOPLE = ["Ana Ribeiro", "Marco Salas"];

/** The four frames that made the "where are we staying" shortlist. */
const ALBUM_TITLE = "Tahoe scouting";
const ALBUM_FILES = [
  "emerald-bay-overlook.png",
  "tahoe-dusk-ridge.png",
  "truckee-river-bend.png",
  "granite-switchback.png",
];
const ALBUM_COVER = "emerald-bay-overlook.png";

/** A tiny deterministic video payload. The journey corpus needs media-kind
 * diversity, not playback fidelity; the viewer's capability rows and video
 * badge read the vault's honest kind/duration metadata while the fixture stays
 * small enough for the inline scenario door. */
const VIDEO = {
  file: "tahoe-pan.mp4",
  title: "Tahoe shoreline pan",
  day: -2,
  hour: 17,
  width: 360,
  height: 240,
  duration: 12,
  thumbhash: "DAcKDYJod3d7h4hweHiIeJiAi2gH",
  data: "AAAAHGZ0eXBtcDQyAAAAAG1wNDJpc29t",
};

export default async function seedHandler({ input, log, ctx }) {
  const now = new Date(input?.now ?? Date.now()).getTime();
  const at = (day, hour, monthOffset = 0) => {
    const stamp = new Date(now);
    stamp.setUTCMonth(stamp.getUTCMonth() + monthOffset);
    stamp.setUTCDate(stamp.getUTCDate() + day);
    stamp.setUTCHours(hour, 0, 0, 0);
    return stamp.toISOString();
  };
  const invoke = async (command, args) => {
    const out = await ctx.vault.invoke({
      command,
      input: args,
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
      captured_at: at(frame.day, frame.hour, frame.monthOffset),
      tz_offset_min: TZ_OFFSET_MIN,
      width: frame.width,
      height: frame.height,
      thumbhash: frame.thumbhash,
      phash: frame.phash,
      ...placeInput(frame.file),
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

  // ── Portraits, then their face proposals ────────────────────────────────
  // Same ordered recursion as the landscape roll, and for the same reason.
  const facesByAsset = [];
  const addPortrait = async (index) => {
    const frame = PORTRAITS[index];
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
      ...placeInput(frame.file),
    });
    assetIdByFile.set(frame.file, added.asset_id);
    if (frame.faces.length)
      facesByAsset.push({ assetId: added.asset_id, faces: frame.faces });
    return addPortrait(index + 1);
  };
  await addPortrait(0);

  const video = await invoke("media.add_asset", {
    data_uri: `data:video/mp4;base64,${VIDEO.data}`,
    kind: "video",
    title: VIDEO.title,
    captured_at: at(VIDEO.day, VIDEO.hour),
    tz_offset_min: TZ_OFFSET_MIN,
    width: VIDEO.width,
    height: VIDEO.height,
    duration_s: VIDEO.duration,
    thumbhash: VIDEO.thumbhash,
    ...placeInput(VIDEO.file),
  });
  assetIdByFile.set(VIDEO.file, video.asset_id);

  // The roster a confirm can name. `people.add_person` is the same command the
  // People app uses, so these are ordinary parties, not seed-only rows.
  const addPerson = async (index) => {
    const name = FACE_PEOPLE[index];
    if (!name) return;
    // `cadence_days` is required by the command — a person the People app
    // would never nag about still needs the field, so pick its own default
    // rather than inventing a reminder cadence Photos has no opinion on.
    await invoke("people.add_person", {
      display_name: name,
      cadence_days: 90,
    });
    return addPerson(index + 1);
  };
  await addPerson(0);

  // Face regions have NO create command of their own: they are enrichment
  // output, and enrichment output reaches the vault through the staging
  // publisher (`ingest/enrich-publishers.ts` faceRegionPublisher). So the seed
  // takes the same road a real enricher takes — stage a batch, publish it —
  // rather than reaching past the command surface into SQL. External ids keep
  // the enricher's `<asset>:face:<n>` convention so a later real pass diffs
  // against these rows instead of duplicating them.
  if (facesByAsset.length) {
    const rows = facesByAsset.flatMap(({ assetId, faces }) =>
      faces.map((face, n) => ({
        entity_type: "media.face_region",
        external_id: `${assetId}:face:${n}`,
        payload: {
          asset_id: assetId,
          bbox: face.bbox,
          confidence: face.confidence,
        },
      }))
    );
    const batch = await invoke("sync.stage_rows", {
      kind: "enrich.faces",
      label: "Face proposals (scenario)",
      rows,
    });
    // Auto-publish trust may have applied the batch already; publishing a
    // non-draft batch fails its own precondition, so only push a draft.
    if (batch.published === undefined || batch.staged !== undefined)
      await invoke("sync.publish_batch", { batch_id: batch.batch_id }).catch(
        () => undefined
      );
  }

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

  const faceCount = facesByAsset.reduce((n, e) => n + e.faces.length, 0);
  const placedFiles = Object.keys(PLACE_BY_FILE);
  const distinctPlaces = new Set(
    placedFiles.map((file) => {
      const spot = PLACE_BY_FILE[file];
      return `${spot.lat},${spot.lng}`;
    })
  ).size;
  log.info(
    `photos scenario: ${ROLL.length + PORTRAITS.length + 1} assets seeded ` +
      `(2 favorites, 1 album of ${ALBUM_FILES.length}, ` +
      `${faceCount} face proposals across ${facesByAsset.length} frames, ` +
      `${placedFiles.length} located frames across ${distinctPlaces} places)`
  );
  return { seeded: ROLL.length + PORTRAITS.length + 1 };
}
