import assert from "node:assert/strict";
import test from "node:test";

import { scanHairline, scanSource } from "./lint-hairline.mjs";

test("mobile source draws no border at `StyleSheet.hairlineWidth`", () => {
  assert.deepEqual(scanHairline(), []);
});

test("the gate catches the platform hairline used as a border width", () => {
  const findings = scanSource(
    `const styles = StyleSheet.create({
       card: { borderWidth: StyleSheet.hairlineWidth },
       rule: { height: StyleSheet.hairlineWidth },
     });`,
    "fixture.ts"
  );
  assert.equal(findings.length, 2);
  assert.match(findings[0], /fixture\.ts:2: `hairlineWidth`/u);
  assert.match(findings[0], /borders\.hairline/u);
  assert.match(findings[1], /fixture\.ts:3: `hairlineWidth`/u);
});

test("the gate catches a test mock that re-declares the field", () => {
  const findings = scanSource(
    `vi.mock("react-native", () => ({
       StyleSheet: { create: (s) => s, hairlineWidth: 1 },
     }));`,
    "fixture.ts"
  );
  assert.equal(findings.length, 1);
  assert.match(findings[0], /fixture\.ts:2/u);
});

test("the gate leaves the token — and prose naming the trap — alone", () => {
  assert.deepEqual(
    scanSource(
      `// A full point, never \`StyleSheet.hairlineWidth\` — see borders.ts.
       import { borders } from "@centraid/design";
       const styles = StyleSheet.create({
         card: { borderWidth: borders.hairline },
       });`,
      "fixture.ts"
    ),
    []
  );
});
