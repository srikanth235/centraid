/**
 * Real-path tests for the external info probe (issue #504 packaging).
 * Run: node --test scripts/gateway-package/probe.test.mjs
 */
import { createServer } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeGatewayInfo, waitForGatewayInfo, INFO_PATH } from './probe.mjs';

test('probeGatewayInfo accepts 200 with version', async () => {
  const server = createServer((req, res) => {
    if (req.url?.startsWith(INFO_PATH)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '0.1.0', schemaEpoch: 1 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const result = await probeGatewayInfo(base);
    assert.equal(result.ok, true);
    assert.equal(result.status, 200);
    assert.match(result.detail, /0\.1\.0/);
  } finally {
    server.close();
  }
});

test('probeGatewayInfo accepts 401 as listen proof', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await probeGatewayInfo(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, true);
    assert.equal(result.status, 401);
  } finally {
    server.close();
  }
});

test('probeGatewayInfo rejects 200 without version string', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ schemaEpoch: 1 }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await probeGatewayInfo(`http://127.0.0.1:${port}`);
    assert.equal(result.ok, false);
  } finally {
    server.close();
  }
});

test('waitForGatewayInfo eventually succeeds', async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits += 1;
    if (hits < 2) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: 'x' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const result = await waitForGatewayInfo(`http://127.0.0.1:${port}`, {
      deadlineMs: 5_000,
      intervalMs: 50,
    });
    assert.equal(result.ok, true);
    assert.ok(hits >= 2);
  } finally {
    server.close();
  }
});
