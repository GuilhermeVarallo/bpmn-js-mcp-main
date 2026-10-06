/**
 * Tests for bpmn:Association waypoint sanity-checking after connect_bpmn_elements.
 *
 * The handler should detect when the first/last waypoints of a newly-created
 * association are outside the source/target element bounds (which can happen
 * with boundary events whose canvas position may not be fully committed at
 * connection time) and recompute a clean 2-point straight path.
 *
 * TODO reference:
 *   "After creating a bpmn:Association, sanity-check that the first waypoint
 *   falls within (or within a small tolerance of) the source element bounds
 *   and the last waypoint within the target element bounds — if not, recompute
 *   and apply a straight 2-point path immediately"
 *   "When the source is a bpmn:BoundaryEvent, resolve its canvas-absolute
 *   position … before computing waypoints"
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleConnect, handleAddElement, handleSetEventDefinition } from '../../../src/handlers';
import { parseResult, createDiagram, addElement, clearDiagrams } from '../../helpers';
import { getDiagram } from '../../../src/diagram-manager';

/** Check whether point (px, py) is within `bounds` + `tolerance` pixels. */
function pointWithinBounds(
  px: number,
  py: number,
  el: { x: number; y: number; width: number; height: number },
  tolerance: number
): boolean {
  return (
    px >= el.x - tolerance &&
    px <= el.x + el.width + tolerance &&
    py >= el.y - tolerance &&
    py <= el.y + el.height + tolerance
  );
}

describe('connect_bpmn_elements — association waypoint sanity check', () => {
  beforeEach(() => clearDiagrams());

  test('association from BoundaryEvent has first waypoint within source bounds', async () => {
    /**
     * Build: Start → Task (host) → End
     *        [CompensateBoundaryEvent] attached to host → [CompensationHandler] via Association
     *
     * After connect_bpmn_elements, the association's first waypoint should be
     * within or near the boundary event's bounding box (not at stale 0,0
     * coordinates from creation time).
     */
    const diagramId = await createDiagram('Association Sanity Check');

    const start = await addElement(diagramId, 'bpmn:StartEvent', { name: 'Start' });
    const host = await addElement(diagramId, 'bpmn:ServiceTask', { name: 'Process Payment' });
    const end = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End' });

    await handleConnect({ diagramId, sourceElementId: start, targetElementId: host });
    await handleConnect({ diagramId, sourceElementId: host, targetElementId: end });

    // Add compensation boundary event on the host task
    const compBEResult = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: host,
        name: 'Compensation',
      })
    );
    const compBEId = compBEResult.elementId as string;

    await handleSetEventDefinition({
      diagramId,
      elementId: compBEId,
      eventDefinitionType: 'bpmn:CompensateEventDefinition',
    });

    // Add compensation handler (not in main flow)
    const handlerResult = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:Task',
        name: 'Refund Payment',
      })
    );
    const handlerId = handlerResult.elementId as string;

    // Connect boundary event → handler via Association
    const connResult = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: compBEId,
        targetElementId: handlerId,
        connectionType: 'bpmn:Association',
      })
    );
    const assocId = connResult.connectionId as string;

    const diagram = getDiagram(diagramId)!;
    const reg = diagram.modeler.get('elementRegistry') as any;

    const assoc = reg.get(assocId);
    const compBE = reg.get(compBEId);
    const handler = reg.get(handlerId);

    expect(assoc).toBeDefined();
    expect(assoc.waypoints).toBeDefined();
    expect(assoc.waypoints.length).toBeGreaterThanOrEqual(2);

    const wps = assoc.waypoints as Array<{ x: number; y: number }>;
    const first = wps[0];
    const last = wps[wps.length - 1];

    // First waypoint must be near the source (boundary event)
    expect(pointWithinBounds(first.x, first.y, compBE, 30)).toBe(true);
    // Last waypoint must be near the target (handler)
    expect(pointWithinBounds(last.x, last.y, handler, 30)).toBe(true);
  });

  test('connect response for boundary event association includes nextSteps hint about layout', async () => {
    /**
     * The response for an association from/to a BoundaryEvent should include
     * a nextSteps hint recommending to run layout_bpmn_diagram, because
     * association waypoints are frozen at creation time.
     */
    const diagramId = await createDiagram('Association nextSteps Hint Test');

    const host = await addElement(diagramId, 'bpmn:ServiceTask', { name: 'Charge Card' });

    const compBEResult = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: host,
        name: 'Comp',
      })
    );
    const compBEId = compBEResult.elementId as string;

    await handleSetEventDefinition({
      diagramId,
      elementId: compBEId,
      eventDefinitionType: 'bpmn:CompensateEventDefinition',
    });

    const handlerResult = parseResult(
      await handleAddElement({ diagramId, elementType: 'bpmn:Task', name: 'Refund' })
    );
    const handlerId = handlerResult.elementId as string;

    const connResult = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: compBEId,
        targetElementId: handlerId,
        connectionType: 'bpmn:Association',
      })
    );

    // nextSteps should mention layout_bpmn_diagram
    const steps = connResult.nextSteps as Array<{ tool: string; description: string }>;
    expect(Array.isArray(steps)).toBe(true);
    const hasLayoutStep = steps.some((s) => s.tool === 'layout_bpmn_diagram');
    expect(hasLayoutStep).toBe(true);

    // The layout step description should mention associations
    const layoutStep = steps.find((s) => s.tool === 'layout_bpmn_diagram');
    expect(layoutStep?.description).toMatch(/association/i);
  });
});
