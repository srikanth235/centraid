// The digest is generated, so the test is that it says the SAME thing the
// runner enforces: a brief that drifts from the catalog is unwritten law with
// extra steps.
import assert from "node:assert/strict";
import test from "node:test";

import { buildBrief, renderBrief } from "./brief.mjs";
import { loadRules } from "./eslint.config.mjs";
import { lawDigestAt } from "./arrival.mjs";

test("the brief names every enabled rule, with the door and severity the runner uses", async () => {
  const brief = await buildBrief();
  const declared = await loadRules();
  assert.deepEqual(
    brief.rules.map((rule) => `${rule.id} ${rule.door} ${rule.severity}`),
    declared.map((row) => `${row.id} ${row.door} ${row.severity}`)
  );
  for (const rule of brief.rules) {
    assert.match(rule.statute, /^CONSTITUTION\.md#/u, `${rule.id} has no statute link`);
    assert.ok(rule.description.length > 10, `${rule.id} has no description`);
  }
});

test("the digest it prints is the law digest at HEAD", async () => {
  const brief = await buildBrief();
  assert.equal(brief.digest, lawDigestAt("HEAD"));
  assert.match(brief.digest, /^[0-9a-f]{64}$/u);
});

test("the rendered digest carries the domains and the exceptions in force", async () => {
  const text = renderBrief(await buildBrief());
  assert.match(text, /## Doctrine digest — law `[0-9a-f]{12}`/u);
  assert.match(text, /### Rules in force/u);
  assert.match(text, /### Doctrine domains/u);
  assert.match(text, /### Exceptions in force/u);
  // The one line that keeps a stamped brief from becoming an alibi.
  assert.match(text, /held to HEAD, not to this page/u);
  for (const rule of (await buildBrief()).rules) {
    assert.ok(text.includes(`\`${rule.id}\``), `${rule.id} is missing from the digest`);
  }
});
