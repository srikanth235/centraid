import { expect, test } from 'vitest';
import { outcomeForStopReason } from './stop-reason.js';

test('end_turn emits final only', () => {
  const o = outcomeForStopReason('end_turn');
  expect(o.emitFinal).toBe(true);
  expect(o.notice).toBeUndefined();
  expect(o.error).toBeUndefined();
});

test('missing stopReason is treated as end_turn', () => {
  expect(outcomeForStopReason(undefined).emitFinal).toBe(true);
});

test('refusal is a hard error without final', () => {
  const o = outcomeForStopReason('refusal');
  expect(o.emitFinal).toBe(false);
  expect(o.error?.type).toBe('error');
  expect(o.error && o.error.type === 'error' && o.error.message).toMatch(/refused/i);
});

test('max_tokens warns then allows final', () => {
  const o = outcomeForStopReason('max_tokens');
  expect(o.emitFinal).toBe(true);
  expect(o.notice?.code).toBe('stop_truncated');
});

test('max_turn_requests warns then allows final', () => {
  const o = outcomeForStopReason('max_turn_requests');
  expect(o.emitFinal).toBe(true);
  expect(o.notice?.code).toBe('stop_truncated');
});

test('cancelled notices but still delivers text', () => {
  const o = outcomeForStopReason('cancelled');
  expect(o.emitFinal).toBe(true);
  expect(o.notice?.code).toBe('stop_cancelled');
});

test('unknown stopReason is labeled', () => {
  const o = outcomeForStopReason('something_new');
  expect(o.emitFinal).toBe(true);
  expect(o.notice?.code).toBe('stop_other');
});
