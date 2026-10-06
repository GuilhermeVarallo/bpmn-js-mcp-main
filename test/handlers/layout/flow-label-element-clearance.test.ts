/**
 * Regression test: flow label bounding boxes must not intersect source or target
 * element bounding boxes after layout.
 *
 * TODO reference:
 *   "Add a regression test: after layouting a two-lane pool with labelled flows
 *   between the lanes, assert that each flow label's bounding box does not
 *   intersect either the source or the target element's bounding box."
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleLayoutDiagram } from '../../../src/handlers/layout/layout-diagram';
import { getDiagram } from '../../../src/diagram-manager';
import {
  handleCreateParticipant,
  handleCreateLanes,
  handleAddElement,
  handleConnect,
} from '../../../src/handlers';
import { clearDiagrams, createDiagram, parseResult } from '../../helpers';

function rectsOverlap(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

describe('flow label clearance from connected elements', () => {
  beforeEach(() => clearDiagrams());

  test('cross-lane flow label does not overlap source or target element after layout', async () => {
    /**
     * Build a 2-lane pool:
     *   Customer lane: [Start] → [Place Order]
     *   System lane:             [Process Order] → [End]
     *
     * Cross-lane flow (labeled "Submit"): Place Order → Process Order
     *
     * After layout, the "Submit" label should not overlap the bounding box of
     * "Place Order" (source) or "Process Order" (target).
     */
    const diagramId = await createDiagram('Cross-Lane Label Clearance Test');

    const poolRes = parseResult(
      await handleCreateParticipant({ diagramId, name: 'Order Process' })
    );
    const pool = poolRes.participantId as string;

    const lanesRes = parseResult(
      await handleCreateLanes({
        diagramId,
        participantId: pool,
        lanes: [{ name: 'Customer' }, { name: 'System' }],
      })
    );
    const [laneCustomer, laneSystem] = lanesRes.laneIds as string[];

    const start = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:StartEvent',
        name: 'Start',
        participantId: pool,
        laneId: laneCustomer,
      })
    ).elementId;

    const placeOrder = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:UserTask',
        name: 'Place Order',
        participantId: pool,
        laneId: laneCustomer,
      })
    ).elementId;

    const processOrder = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:ServiceTask',
        name: 'Process Order',
        participantId: pool,
        laneId: laneSystem,
      })
    ).elementId;

    const endEvent = parseResult(
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:EndEvent',
        name: 'End',
        participantId: pool,
        laneId: laneSystem,
      })
    ).elementId;

    await handleConnect({ diagramId, sourceElementId: start, targetElementId: placeOrder });
    const crossFlowRes = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: placeOrder,
        targetElementId: processOrder,
        label: 'Submit',
      })
    );
    const crossLaneFlow = crossFlowRes.connectionId as string;
    await handleConnect({ diagramId, sourceElementId: processOrder, targetElementId: endEvent });

    await handleLayoutDiagram({ diagramId });

    const diagram = getDiagram(diagramId)!;
    const reg = diagram.modeler.get('elementRegistry') as any;

    const flowEl = reg.get(crossLaneFlow);
    expect(flowEl).toBeDefined();

    const flowLabel = flowEl?.label;
    if (!flowLabel) {
      // No label element — nothing to assert
      return;
    }

    const lx = flowLabel.x;
    const ly = flowLabel.y;
    const lw = flowLabel.width ?? 90;
    const lh = flowLabel.height ?? 20;

    const srcEl = reg.get(placeOrder);
    const tgtEl = reg.get(processOrder);

    expect(srcEl).toBeDefined();
    expect(tgtEl).toBeDefined();

    // The flow label must not overlap the source (Place Order) bounding box
    const overlapsSource = rectsOverlap(
      lx,
      ly,
      lw,
      lh,
      srcEl.x,
      srcEl.y,
      srcEl.width,
      srcEl.height
    );
    expect(overlapsSource).toBe(false);

    // The flow label must not overlap the target (Process Order) bounding box
    const overlapsTarget = rectsOverlap(
      lx,
      ly,
      lw,
      lh,
      tgtEl.x,
      tgtEl.y,
      tgtEl.width,
      tgtEl.height
    );
    expect(overlapsTarget).toBe(false);
  });
});
