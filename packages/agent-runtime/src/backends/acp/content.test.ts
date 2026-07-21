// Pure-function coverage for reading ACP ContentBlock payloads off the wire.

import { expect, test } from 'vitest';
import { firstString, isObject, textOf } from './content.ts';

test('textOf collapses falsy content to an empty string', () => {
  expect(textOf(null)).toBe('');
  expect(textOf(undefined)).toBe('');
  expect(textOf('')).toBe('');
});

test('textOf returns a bare string verbatim', () => {
  expect(textOf('hello')).toBe('hello');
});

test('textOf concatenates an array of blocks in order', () => {
  expect(textOf([{ text: 'a' }, 'b', { text: 'c' }])).toBe('abc');
  expect(textOf([])).toBe('');
});

test('textOf reads a { text } block', () => {
  expect(textOf({ type: 'text', text: 'hi' })).toBe('hi');
});

test('textOf recurses into a nested { content } payload (tool_call_update shape)', () => {
  expect(textOf({ content: { text: 'nested' } })).toBe('nested');
  expect(textOf({ content: [{ text: 'x' }, { text: 'y' }] })).toBe('xy');
});

test('textOf returns empty string for an object with neither text nor content', () => {
  expect(textOf({ type: 'image', data: 'abc' })).toBe('');
});

test('firstString returns the first non-blank value, trimmed', () => {
  expect(firstString('  hi  ')).toBe('hi');
  expect(firstString(undefined, 42, '', '   ', ' second ')).toBe('second');
});

test('firstString skips whitespace-only and non-string values, returning undefined when none qualify', () => {
  expect(firstString('   ', '\t', null, 7)).toBeUndefined();
  expect(firstString()).toBeUndefined();
});

test('isObject is true only for non-null objects', () => {
  expect(isObject({})).toBe(true);
  expect(isObject([])).toBe(true);
  expect(isObject(null)).toBe(false);
  expect(isObject('x')).toBe(false);
  expect(isObject(undefined)).toBe(false);
});
