/**
 * Tests for flow label placement excluding gateway label bounding boxes.
 *
 * When a flow exits a gateway and the gateway's own label is placed
 * in the "below" position, the flow label should avoid that same slot.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleLayoutDiagram } from '../../../src/handlers/layout/layout-diagram';
import { createDiagram, addElement, connect, clearDiagrams } from '../../helpers';
import { getDiagram } from '../../../src/diagram-manager';

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

describe('flow label excludes gateway label bounding box', () => {
  beforeEach(() => clearDiagrams());

  test('flow label exiting gateway does not overlap gateway label', async () => {
    const diagramId = await createDiagram('Flow Label Exclusion Test');

    const startId = await addElement(diagramId, 'bpmn:StartEvent', { name: 'Start' });
    const gwId = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Route?' });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'Path A' });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'Path B' });
    const endId = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End' });

    await connect(diagramId, startId, gwId);
    // Label the outgoing flows so they have flow labels to position
    await connect(diagramId, gwId, taskA, 'Yes');
    await connect(diagramId, gwId, taskB, 'No');
    await connect(diagramId, taskA, endId);
    await connect(diagramId, taskB, endId);

    await handleLayoutDiagram({ diagramId });

    const diagram = getDiagram(diagramId)!;
    const reg = diagram.modeler.get('elementRegistry') as any;

    const gwEl = reg.get(gwId);
    const gwLabel = gwEl?.label;
    if (!gwLabel) return; // no gateway label

    const gwLabelX = gwLabel.x;
    const gwLabelY = gwLabel.y;
    const gwLabelW = gwLabel.width ?? 70;
    const gwLabelH = gwLabel.height ?? 20;

    // For each labeled outgoing flow from the gateway, check the flow label doesn't
    // overlap the gateway label
    const allEls = reg.getAll() as any[];
    const outgoingFlows = allEls.filter(
      (el: any) =>
        el.type === 'bpmn:SequenceFlow' &&
        el.source?.id === gwId &&
        el.label &&
        el.businessObject?.name
    );

    for (const flow of outgoingFlows) {
      const flowLabel = flow.label;
      if (!flowLabel) continue;

      const flX = flowLabel.x;
      const flY = flowLabel.y;
      const flW = flowLabel.width ?? 70;
      const flH = flowLabel.height ?? 20;

      const overlaps = rectsOverlap(flX, flY, flW, flH, gwLabelX, gwLabelY, gwLabelW, gwLabelH);

      expect(
        overlaps,
        `Flow label "${flow.businessObject.name}" at (${flX},${flY},${flW}x${flH}) ` +
          `overlaps gateway label at (${gwLabelX},${gwLabelY},${gwLabelW}x${gwLabelH}). ` +
          `Flow labels should avoid gateway label region.`
      ).toBe(false);
    }
  });
});
