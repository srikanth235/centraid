import assert from "node:assert/strict";
import test from "node:test";

import { mobileAffected } from "./check-mobile-native-state.mjs";

test("a file under apps/mobile/ triggers the native-state run", () => {
  assert.equal(mobileAffected(["apps/mobile/App.tsx"]), true);
});

test("the apps/mobile directory itself triggers the native-state run", () => {
  assert.equal(mobileAffected(["apps/mobile"]), true);
});

test("a deeply nested mobile file triggers the native-state run", () => {
  assert.equal(mobileAffected(["apps/mobile/ios/Podfile.lock"]), true);
});

test("one mobile path among non-mobile paths still triggers the run", () => {
  assert.equal(
    mobileAffected([
      "README.md",
      "packages/server/src/x.ts",
      "apps/mobile/app.json",
    ]),
    true
  );
});

test("a change set with no mobile paths skips the run", () => {
  assert.equal(
    mobileAffected(["apps/web/src/main.tsx", "docs/logs.md"]),
    false
  );
});

test("an empty change set skips the run", () => {
  assert.equal(mobileAffected([]), false);
});

test("a sibling directory with the apps/mobile prefix does not trigger the run", () => {
  assert.equal(mobileAffected(["apps/mobile-e2e/flow.yaml"]), false);
});
