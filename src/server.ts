/**
 * MCP Server factory: wires request handlers ↔ tool modules ↔ resources.
 *
 * Over stdio one server serves the whole process.  Over HTTP (http-server.ts)
 * every MCP session gets its own Server bound to its own SessionScope, and
 * each handler runs inside that scope so diagrams never cross sessions.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { type ToolModule } from './module';
import { bpmnModule } from './bpmn-module';
import { withMcpAppsMeta } from './handlers';
import {
  detectMcpAppsSupport,
  isMcpAppsHostSupported,
  setMcpAppsHostSupported,
} from './mcp-apps/host-support';
import { isFilesystemAccessEnabled, withoutFilesystemArgs } from './filesystem-policy';
import type { ToolContext } from './types';
import { RESOURCE_TEMPLATES, listResources, readResource } from './resources';
import { listPrompts, getPrompt } from './prompts';
import { type SessionScope, currentScope, runInScope } from './session-scope';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { version: PKG_VERSION } = require('../package.json') as { version: string };

/**
 * Run `after` once the tool settles — also when it fails, since a failed call
 * may already have mutated the diagram. The tool's own error wins over one
 * from `after`.
 */
async function withAfterHook<T>(result: Promise<T>, after: () => Promise<void>): Promise<T> {
  let value: T;
  try {
    value = await result;
  } catch (error) {
    await after().catch((hookError) => console.error('[server] afterToolCall failed:', hookError));
    throw error;
  }
  await after();
  return value;
}

// ── Registered tool modules ────────────────────────────────────────────────
// Add new editor modules here (e.g. dmnModule, formModule) when available.
const modules: ToolModule[] = [bpmnModule];

export interface McpServerHooks {
  /**
   * Runs inside the session scope after every tools/call, before its result
   * is sent — the stateless HTTP mode writes changed diagrams back to the
   * shared store here. A throw turns the call into an error.
   */
  afterToolCall?: () => Promise<void>;
}

export function createMcpServer(
  scope: SessionScope = currentScope(),
  hooks: McpServerHooks = {}
): Server {
  const server = new Server(
    { name: 'bpmn-js-mcp', version: PKG_VERSION },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
      instructions:
        'Every mutating tool (all tools except export_bpmn, list_bpmn_diagrams, list_bpmn_elements, ' +
        'validate_bpmn_diagram, analyze_bpmn_lanes, and ' +
        'list_bpmn_process_variables) accepts an optional `_clientRequestId` string argument, not ' +
        'listed in its schema. If the same ID is sent again, the server returns the cached result ' +
        'without re-executing the operation — use it for safe retries on network errors.',
    }
  );

  const inScope = <T>(fn: () => T): T => runInScope(scope, fn);

  // Hosts advertise MCP Apps support in `initialize`; the diagram viewer is
  // only offered to them (issue #11 / ADR-025).
  server.oninitialized = () =>
    inScope(() => setMcpAppsHostSupported(detectMcpAppsSupport(server.getClientCapabilities())));

  // ── Tool handlers ────────────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () =>
    inScope(() => {
      let tools: any[] = modules.flatMap((m) => m.toolDefinitions);
      if (!isFilesystemAccessEnabled()) tools = withoutFilesystemArgs(tools);
      return { tools: isMcpAppsHostSupported() ? withMcpAppsMeta(tools) : tools };
    })
  );

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) =>
    inScope(() => {
      const { name, arguments: args } = request.params;

      // Build a ToolContext with progress notification capability when the
      // client supplied a progressToken in the request's _meta.
      const progressToken = request.params._meta?.progressToken;
      const context: ToolContext = {};
      if (progressToken !== undefined && extra?.sendNotification) {
        context.sendProgress = async (
          progress: number,
          total?: number,
          message?: string
        ): Promise<void> => {
          await extra.sendNotification({
            method: 'notifications/progress' as const,
            params: { progressToken, progress, total, message },
          });
        };
      }

      for (const mod of modules) {
        const result = mod.dispatch(name, args, context);
        if (result) {
          return hooks.afterToolCall ? withAfterHook(result, hooks.afterToolCall) : result;
        }
      }

      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    })
  );

  // ── Resource handlers ────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () =>
    inScope(() => ({ resources: listResources() }))
  );

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: RESOURCE_TEMPLATES,
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    inScope(() => readResource(request.params.uri))
  );

  // ── Prompt handlers ──────────────────────────────────────────────────────

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: listPrompts(),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return getPrompt(name, args || {});
  });

  return server;
}
