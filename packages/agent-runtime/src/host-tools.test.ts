import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeToolToHostTool, flattenCodexMcpServers } from './host-tools.js';

describe('claudeToolToHostTool', () => {
  it('maps an MCP tool name `mcp__server__tool` to `server.tool`', () => {
    assert.deepEqual(claudeToolToHostTool('mcp__github__list_pull_requests'), {
      name: 'github.list_pull_requests',
      source: 'mcp',
      server: 'github',
    });
  });

  it('treats a bare tool name as native', () => {
    assert.deepEqual(claudeToolToHostTool('Bash'), { name: 'Bash', source: 'native' });
  });
});

describe('flattenCodexMcpServers', () => {
  it('flattens each server tools map into `<server>.<tool>` entries', () => {
    const tools = flattenCodexMcpServers([
      {
        name: 'chrome-devtools',
        tools: {
          upload_file: { name: 'upload_file', description: 'Upload a file.' },
          list_network_requests: { name: 'list_network_requests' },
        },
      },
      { name: 'empty-server' },
    ]);
    assert.deepEqual(
      tools.map((t) => t.name),
      ['chrome-devtools.upload_file', 'chrome-devtools.list_network_requests'],
    );
    assert.equal(tools[0]?.source, 'mcp');
    assert.equal(tools[0]?.server, 'chrome-devtools');
    assert.equal(tools[0]?.description, 'Upload a file.');
  });
});
