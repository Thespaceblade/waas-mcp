#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerWaasTools } from "./tools.js";

const server = new McpServer({
  name: "waas-mcp",
  version: "0.2.4",
});

registerWaasTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
