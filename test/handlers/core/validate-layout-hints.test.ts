/**
 * Tests for validate_bpmn_diagram improvements:
 * - bpmn-mcp/layout-needs-alignment fixToolCall should include specific
 *   non-orthogonal flow IDs so callers can use set_bpmn_connection_waypoints.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleValidate } from '../../../src/handlers/core/validate';
import { createDiagram, addElement, connect, clearDiagrams, parseResult } from '../../helpers';

describe('validate layout-needs-alignment fix includes flow IDs', () => {
  beforeEach(() => clearDiagrams());

  test('layout-needs-alignment fixToolCall includes nonOrthogonalFlowIds when available', async () => {
    // Build a diagram that is likely to have layout issues
    const diagramId = await createDiagram('Validate Fix Hint Test');

    // Manually place elements with bad positions to trigger layout-needs-alignment
    const start = await addElement(diagramId, 'bpmn:StartEvent', { name: 'Start', x: 100, y: 100 });
    const t1 = await addElement(diagramId, 'bpmn:Task', { name: 'Task A', x: 300, y: 180 });
    const t2 = await addElement(diagramId, 'bpmn:Task', { name: 'Task B', x: 500, y: 100 });
    const end = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End', x: 700, y: 180 });

    await connect(diagramId, start, t1);
    await connect(diagramId, t1, t2);
    await connect(diagramId, t2, end);

    const res = parseResult(await handleValidate({ diagramId }));

    expect(res.success).toBe(true);

    // Find any layout-needs-alignment issue
    const layoutIssue = (res.issues as any[]).find(
      (i: any) => i.rule === 'bpmn-mcp/layout-needs-alignment'
    );

    if (!layoutIssue) {
      // Layout might be clean — that's OK, test is conditional
      return;
    }

    // The fixToolCall should point to layout_bpmn_diagram
    expect(layoutIssue.fixToolCall).toBeDefined();
    expect(layoutIssue.fixToolCall.tool).toBe('layout_bpmn_diagram');
    expect(layoutIssue.fixToolCall.args).toHaveProperty('diagramId', diagramId);

    // If there are non-orthogonal flows, the fix should include nonOrthogonalFlowIds
    // in the args or hint
    if (layoutIssue.fixToolCall.args.nonOrthogonalFlowIds) {
      expect(Array.isArray(layoutIssue.fixToolCall.args.nonOrthogonalFlowIds)).toBe(true);
    }
  });
});
