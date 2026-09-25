import { describe, it, expect } from 'vitest';
import { generateMcpConfig, type McpServer } from './mcp';

const servers: McpServer[] = [
  { name: 'github', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'xxx' } },
  { name: 'docs', url: 'https://docs.example.com/mcp' },
];

describe('generateMcpConfig', () => {
  it('claude-code uses mcpServers with stdio fields', () => {
    const cfg = JSON.parse(generateMcpConfig('claude-code', servers));
    expect(cfg.mcpServers.github.command).toBe('npx');
    expect(cfg.mcpServers.github.args).toEqual(['-y', '@modelcontextprotocol/server-github']);
    expect(cfg.mcpServers.github.env.GITHUB_TOKEN).toBe('xxx');
    expect(cfg.mcpServers.docs.type).toBe('http');
    expect(cfg.mcpServers.docs.url).toBe('https://docs.example.com/mcp');
  });
  it('cursor uses mcpServers too and tolerates bare url entries', () => {
    const cfg = JSON.parse(generateMcpConfig('cursor', servers));
    expect(cfg.mcpServers.docs.url).toBeDefined();
    expect(cfg.mcpServers.docs.type).toBeUndefined();
  });
  it('vscode uses servers with type field', () => {
    const cfg = JSON.parse(generateMcpConfig('vscode', servers));
    expect(cfg.servers.github.type).toBe('stdio');
    expect(cfg.servers.docs.type).toBe('http');
  });
  it('empty list produces empty config', () => {
    const cfg = JSON.parse(generateMcpConfig('claude-code', []));
    expect(cfg.mcpServers).toEqual({});
  });
});
