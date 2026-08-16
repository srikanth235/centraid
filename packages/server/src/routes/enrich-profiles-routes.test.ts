/*
 * The engine-profiles route (issue #807): one read of gateway prefs, no
 * spawns, and a wire shape the Settings surface renders directly.
 */

import { describe, expect, test } from "vitest";

import { BUILT_IN_PROFILE } from "@centraid/vault";

import { ENRICH_CAPABILITIES } from "../enrich/capability-registry.js";
import type { EngineProfile } from "../enrich/engine-profiles.js";
import { engineProfilePrefsKey } from "../enrich/engine-profiles.js";
import {
  ENRICH_PROFILES_PATH,
  makeEnrichProfilesRouteHandler,
} from "./enrich-profiles-routes.js";

/** A response recorder — these handlers only ever write one JSON body. */
function recorder() {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    writeHead: (code: number) => {
      status = code;
      return res;
    },
    end: (chunk?: unknown) => {
      if (typeof chunk === "string") chunks.push(chunk);
      else if (chunk) chunks.push(Buffer.from(chunk as Uint8Array).toString());
    },
  } as unknown as Parameters<
    ReturnType<typeof makeEnrichProfilesRouteHandler>
  >[1];
  return {
    res,
    get status() {
      return status || (res as { statusCode: number }).statusCode;
    },
    body: <T>(): T => JSON.parse(chunks.join("")) as T,
  };
}

const request = (url: string, method = "GET") =>
  ({ url, method }) as Parameters<
    ReturnType<typeof makeEnrichProfilesRouteHandler>
  >[0];

describe("enrich-profiles-routes", () => {
  test("lists the derived built-ins for a gateway with empty prefs", async () => {
    const out = recorder();
    const handled = await makeEnrichProfilesRouteHandler({
      readPrefs: () => ({}),
    })(request(ENRICH_PROFILES_PATH), out.res);
    expect(handled).toBe(true);
    expect(out.status).toBe(200);
    const { profiles } = out.body<{ profiles: EngineProfile[] }>();
    expect(profiles).toHaveLength(ENRICH_CAPABILITIES.length);
    for (const profile of profiles) {
      expect(profile.id).toBe(BUILT_IN_PROFILE);
      expect(profile.builtIn).toBe(true);
      expect(profile.egress).toBe("gateway");
    }
  });

  test("adds the member's profiles with their computed egress class", async () => {
    const out = recorder();
    await makeEnrichProfilesRouteHandler({
      readPrefs: () => ({
        "harness.kind": "codex",
        [engineProfilePrefsKey("careful-ocr")]: {
          capability: "ocr",
          label: "Careful OCR",
          harness: "codex",
          model: "some-model-id",
        },
      }),
    })(request(`${ENRICH_PROFILES_PATH}?anything=1`), out.res);
    const { profiles } = out.body<{ profiles: EngineProfile[] }>();
    const mine = profiles.find((profile) => profile.id === "careful-ocr");
    expect(mine).toStrictEqual({
      id: "careful-ocr",
      label: "Careful OCR",
      capability: "ocr",
      engine: { kind: "delegate", harness: "codex", model: "some-model-id" },
      egress: "provider",
      builtIn: false,
    });
  });

  test("declines other paths and refuses other methods", async () => {
    const handler = makeEnrichProfilesRouteHandler({ readPrefs: () => ({}) });
    const other = recorder();
    await expect(
      handler(request("/centraid/_enrich/something-else"), other.res)
    ).resolves.toBe(false);
    const posted = recorder();
    await expect(
      handler(request(ENRICH_PROFILES_PATH, "POST"), posted.res)
    ).resolves.toBe(true);
    expect(posted.status).toBe(405);
  });
});
