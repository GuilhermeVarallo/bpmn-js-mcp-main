/**
 * Tests for autosizeOnly mode on layout_bpmn_diagram.
 * Merges autosize_bpmn_pools_and_lanes functionality into layout_bpmn_diagram.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  handleLayoutDiagram,
  handleCreateCollaboration,
  handleAddElement,
} from '../../../src/handlers';
import { TOOL_DEFINITION as LAYOUT_TOOL } from '../../../src/handlers/layout/layout-diagram-schema';
import { createDiagram, parseResult, clearDiagrams } from '../../helpers';

describe('layout_bpmn_diagram autosizeOnly mode', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  async function createPoolWithElements(diagramId: string) {
    const collab = parseResult(
      await handleCreateCollaboration({
        diagramId,
        participants: [
          { name: 'Process', width: 300, height: 200 },
          { name: 'External', collapsed: true },
        ],
      })
    );
    const poolId = collab.participantIds[0];

    for (let i = 0; i < 6; i++) {
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:UserTask',
        name: `Task ${i + 1}`,
        participantId: poolId,
        x: 200 + i * 160,
        y: 150,
      });
    }

    return poolId;
  }

  test('autosizeOnly resizes pools without running full layout', async () => {
    const diagramId = await createDiagram();
    await createPoolWithElements(diagramId);

    const res = parseResult(await handleLayoutDiagram({ diagramId, autosizeOnly: true }));

    expect(res.success).toBe(true);
    expect(res.autosizeOnly).toBe(true);
    expect(res.poolCount).toBeGreaterThanOrEqual(1);
  });

  test('autosizeOnly reports pool resize results', async () => {
    const diagramId = await createDiagram();
    await createPoolWithElements(diagramId);

    const res = parseResult(await handleLayoutDiagram({ diagramId, autosizeOnly: true }));

    expect(res.poolResults).toBeDefined();
    expect(Array.isArray(res.poolResults)).toBe(true);
  });

  test('autosizeOnly with participantId scopes to single pool', async () => {
    const diagramId = await createDiagram();
    const poolId = await createPoolWithElements(diagramId);

    const res = parseResult(
      await handleLayoutDiagram({ diagramId, autosizeOnly: true, participantId: poolId })
    );

    expect(res.success).toBe(true);
    expect(res.autosizeOnly).toBe(true);
  });

  test('autosizeOnly appears in tool definition schema', () => {
    const props = LAYOUT_TOOL.inputSchema.properties;
    expect(props.autosizeOnly).toBeDefined();
    expect(props.autosizeOnly.type).toBe('boolean');
  });
});
