/*
 * The experimental gate's resolution order (env > prefs > option > off) and
 * its authoritative-env contract — the v0 early-feedback door.
 */

import { describe, expect, it } from "vitest";

import {
  EXPERIMENTAL_FEATURE_PREF_KEYS,
  resolveExperimentalFeatures,
} from "./experimental-features.js";

describe(resolveExperimentalFeatures, () => {
  it("defaults every feature off — the v0 surface", () => {
    expect(resolveExperimentalFeatures({ env: {} }).features).toStrictEqual({
      automations: false,
      connectors: false,
    });
  });

  it("reads durable prefs per feature", () => {
    const { features } = resolveExperimentalFeatures({
      env: {},
      prefs: {
        [EXPERIMENTAL_FEATURE_PREF_KEYS.automations]: true,
        [EXPERIMENTAL_FEATURE_PREF_KEYS.connectors]: false,
      },
    });
    expect(features).toStrictEqual({ automations: true, connectors: false });
  });

  it("drops garbage pref values instead of widening the gate", () => {
    const { features } = resolveExperimentalFeatures({
      env: {},
      prefs: {
        [EXPERIMENTAL_FEATURE_PREF_KEYS.automations]: "true",
        [EXPERIMENTAL_FEATURE_PREF_KEYS.connectors]: 1,
      },
    });
    expect(features).toStrictEqual({ automations: false, connectors: false });
  });

  it("falls back to the host option when no pref is set", () => {
    const { features } = resolveExperimentalFeatures({
      env: {},
      options: { automations: true },
    });
    expect(features).toStrictEqual({ automations: true, connectors: false });
  });

  it("lets a pref override the host option in both directions", () => {
    const { features } = resolveExperimentalFeatures({
      env: {},
      prefs: { [EXPERIMENTAL_FEATURE_PREF_KEYS.automations]: false },
      options: { automations: true, connectors: true },
    });
    expect(features).toStrictEqual({ automations: false, connectors: true });
  });

  it("treats a set env var as authoritative for every feature", () => {
    const { features } = resolveExperimentalFeatures({
      env: { CENTRAID_EXPERIMENTAL: "automations" },
      prefs: { [EXPERIMENTAL_FEATURE_PREF_KEYS.connectors]: true },
      options: { connectors: true },
    });
    expect(features).toStrictEqual({ automations: true, connectors: false });
  });

  it("parses a comma list with whitespace and mixed case", () => {
    const { features, unknownEnvTokens } = resolveExperimentalFeatures({
      env: { CENTRAID_EXPERIMENTAL: " Automations , CONNECTORS " },
    });
    expect(features).toStrictEqual({ automations: true, connectors: true });
    expect(unknownEnvTokens).toStrictEqual([]);
  });

  it("surfaces unknown env tokens for a boot warning", () => {
    const { features, unknownEnvTokens } = resolveExperimentalFeatures({
      env: { CENTRAID_EXPERIMENTAL: "automations,automatons" },
    });
    expect(features.automations).toBe(true);
    expect(unknownEnvTokens).toStrictEqual(["automatons"]);
  });

  it("an empty env var forces everything off despite prefs", () => {
    const { features } = resolveExperimentalFeatures({
      env: { CENTRAID_EXPERIMENTAL: "" },
      prefs: { [EXPERIMENTAL_FEATURE_PREF_KEYS.automations]: true },
    });
    expect(features).toStrictEqual({ automations: false, connectors: false });
  });
});
