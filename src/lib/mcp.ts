export type McpTarget = 'claude-code' | 'cursor' | 'vscode';

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export function generateMcpConfig(target: McpTarget, servers: McpServer[]): string {
  const stdio = (s: McpServer) => ({
    ...(s.command ? { command: s.command } : {}),
    ...(s.args?.length ? { args: s.args } : {}),
    ...(s.env ? { env: s.env } : {}),
  });
  const http = (s: McpServer) => (s.url ? { type: 'http', url: s.url } : stdio(s));

  let obj: Record<string, unknown>;
  if (target === 'vscode') {
    obj = { servers: Object.fromEntries(servers.map((s) => [s.name, s.url ? { type: 'http', url: s.url } : { type: 'stdio', ...stdio(s) }])) };
  } else if (target === 'claude-code') {
    // claude-code requires an explicit type on remote (http) entries.
    obj = { mcpServers: Object.fromEntries(servers.map((s) => [s.name, http(s)])) };
  } else {
    // cursor (.cursor/mcp.json) shares the mcpServers shape and tolerates a bare url.
    obj = { mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.url ? { url: s.url } : stdio(s)])) };
  }
  return JSON.stringify(obj, null, 2);
}
