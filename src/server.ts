import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Config } from './config.js';

export function createServer(config: Config, version: string, root: AbortSignal) {
  const server = new Server({ name: 'ssh-mcp', version }, { capabilities: { tools: {} } });
  const schema = z.strictObject({});
  const output = z.object({ servers: z.array(z.object({ server_id: z.string(), description: z.string(), host: z.string(), port: z.number().int(), username: z.string(), auth_type: z.enum(['password', 'private_key']) })) });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ssh_list', description: '列出配置中的 SSH 服务器与认证类型，按 server_id 排序，不联网探测，不返回凭据。远端操作前使用精确 server_id 选择目标。', inputSchema: z.toJSONSchema(schema), outputSchema: z.toJSONSchema(output) }] }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    if (root.aborted || request.params.name !== 'ssh_list' || !schema.safeParse(request.params.arguments ?? {}).success) return { isError: true, content: [{ type: 'text', text: '工具参数无效，请按输入 Schema 检查必填字段、类型、取值范围和未知参数' }] };
    const structuredContent = { servers: [...config.servers.values()].map(s => ({ server_id: s.id, description: s.description, host: s.host, port: s.port, username: s.username, auth_type: s.privateKeyPath ? 'private_key' : 'password' })) };
    return { structuredContent, content: [{ type: 'text', text: JSON.stringify(structuredContent) }] };
  });
  return server;
}
