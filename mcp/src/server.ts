import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolSet } from './types';

/** Register the core's JSON schemas without introducing SDK types into the core. */
export function toolServer(tools: McpToolSet): McpServer {
  const server = new McpServer({ name: 'rein-mcp', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, 'Unknown tool');
    let progress = 0;
    const token = extra._meta?.progressToken;
    const result = await tool.handler(request.params.arguments ?? {}, {
      progress:
        token === undefined
          ? undefined
          : async (message) => {
              await extra.sendNotification({
                method: 'notifications/progress',
                params: { progressToken: token, progress: ++progress, message },
              });
            },
    });
    return { ...result };
  });
  return server;
}
