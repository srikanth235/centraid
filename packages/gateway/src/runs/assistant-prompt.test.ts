import { expect, test } from 'vitest';
import { buildAssistantPrompt, buildVaultToolsGrounding } from './assistant-prompt.js';

// Real-app E2E testing (2026-07-10) found the Ask panel's agent claiming a
// destructive purge had completed without ever calling vault_invoke — the
// prompt warned against claiming an outbox send completed but had no
// equivalent guard for writes/parking. Both prompt builders share the same
// REGISTER text, so one assertion covers the vault assistant, the per-app
// kit-ask register, and the OpenClaw embedded grounding alike.
test('the register warns against claiming a write completed without calling vault_invoke', () => {
  const prompt = buildAssistantPrompt('My vault', 'schema…');
  expect(prompt).toMatch(/never claim a write executed, was parked, or failed/i);
  expect(prompt).toMatch(/destructive or irreversible/i);
});

test('the grounding variant (no answer-format block) carries the same guard', () => {
  const grounding = buildVaultToolsGrounding('My vault', 'schema…');
  expect(grounding).toMatch(/never claim a write executed, was parked, or failed/i);
});
