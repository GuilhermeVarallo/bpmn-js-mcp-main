/**
 * Whether tool arguments may name paths on the server's filesystem.
 *
 * `create_bpmn_diagram` (`filePath` import) and `export_bpmn` (`filePath`
 * export) read and write wherever the caller points them.  Over stdio the
 * caller is the local user, on their own machine, so this is the intended
 * open→edit→save workflow.  Over HTTP the caller is anyone holding a token,
 * and the same arguments become arbitrary file read/write on the server —
 * so the HTTP mode turns this off (see index.ts).
 */

import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

let filesystemAccess = true;

export function setFilesystemAccess(enabled: boolean): void {
  filesystemAccess = enabled;
}

export function isFilesystemAccessEnabled(): boolean {
  return filesystemAccess;
}

/** Throw InvalidParams when `argName` names a server path and access is off. */
export function assertFilesystemAccess(argName: string): void {
  if (filesystemAccess) return;
  throw new McpError(
    ErrorCode.InvalidParams,
    `'${argName}' is disabled on this server (HTTP mode): it cannot read or write server files. ` +
      'Pass the BPMN XML in `xml` and take the exported content from the tool result instead.'
  );
}

/** export_bpmn formats that can be returned in the tool result without a file. */
const INLINE_EXPORT_FORMATS = ['xml', 'svg', 'both', 'png'];

/**
 * Tool definitions as advertised when filesystem access is off: `filePath`
 * removed from every schema (export_bpmn lists it as required), and
 * export_bpmn restricted to the formats that come back inline.
 */
export function withoutFilesystemArgs<T extends { name: string; inputSchema?: any }>(
  tools: readonly T[]
): T[] {
  return tools.map((tool) => {
    const properties = tool.inputSchema?.properties;
    if (!properties?.filePath) return tool;
    const { filePath: _removed, ...rest } = properties;
    const inputSchema = {
      ...tool.inputSchema,
      properties: rest,
      required: (tool.inputSchema.required ?? []).filter((r: string) => r !== 'filePath'),
    };
    let description = (tool as any).description as string | undefined;
    if (tool.name === 'export_bpmn') {
      inputSchema.properties = {
        ...rest,
        format: { ...rest.format, enum: INLINE_EXPORT_FORMATS },
      };
      description =
        'On this server (HTTP mode) export_bpmn returns its content in the tool result only — ' +
        'no file is written; formats: xml, svg, both, png (inline image). ' +
        (description ?? '');
    }
    return { ...tool, description, inputSchema };
  });
}
