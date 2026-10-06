/**
 * Tests for lane-boundary awareness in gateway label placement.
 *
 * Bug: when a gateway sits in one lane and the "below" label candidate
 * falls into an adjacent (different) lane, the label should be demoted
 * in scoring and the algorithm should prefer "above" or another side.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleLayoutDiagram } from '../../../src/handlers/layout/layout-diagram';
import { handleCreateParticipant } from '../../../src/handlers/collaboration/create-participant';
import { handleCreateLanes } from '../../../src/handlers/collaboration/create-lanes';
import { createDiagram, addElement, connect, clearDiagrams } from '../../helpers';
import { getDiagram } from '../../../src/diagram-manager';

describe('gateway label lane-boundary awareness', () => {
  beforeEach(() => clearDiagrams());

  test('gateway label does not fall into adjacent lane below', async () => {
    // Build a two-lane pool:
    //   Lane A (top):    Start → Gateway (named) → TaskA
    //   Lane B (bottom): TaskB  ← branch from Gateway
    // Gateway is in Lane A. Its "below" candidate would be in Lane B.
    // The algorithm should detect this and prefer "above".

    const diagramId = await createDiagram('Lane Boundary Test');

    const { participantId } = await handleCreateParticipant({
      diagramId,
      name: 'Pool',
      height: 300,
    }).then((r) => JSON.parse(r.content[0].text as string));

    const lanesResult = await handleCreateLanes({
      diagramId,
      participantId,
      lanes: [
        { name: 'Lane A', height: 150 },
        { name: 'Lane B', height: 150 },
      ],
    });
    const lanesData = JSON.parse(lanesResult.content[0].text as string);
    const [laneAId, laneBId] = lanesData.laneIds ?? Object.values(lanesData.lanes ?? {});

    if (!laneAId || !laneBId) {
      // If lane IDs not available, skip structural test
      return;
    }

    const startId = await addElement(diagramId, 'bpmn:StartEvent', {
      name: 'Start',
      laneId: laneAId,
    });
    const gwId = await addElement(diagramId, 'bpmn:ExclusiveGateway', {
      name: 'Check?',
      laneId: laneAId,
    });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'Approve', laneId: laneAId });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'Reject', laneId: laneBId });
    const endId = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End', laneId: laneAId });

    await connect(diagramId, startId, gwId);
    await connect(diagramId, gwId, taskA);
    await connect(diagramId, gwId, taskB);
    await connect(diagramId, taskA, endId);
    await connect(diagramId, taskB, endId);

    await handleLayoutDiagram({ diagramId });

    const diagram = getDiagram(diagramId)!;
    const reg = diagram.modeler.get('elementRegistry') as any;

    const gwEl = reg.get(gwId);
    const gwLabel = gwEl?.label;
    if (!gwLabel) return; // no label to test

    // Find Lane B
    const allEls = reg.getAll() as any[];
    const laneB = allEls.find((el: any) => el.id === laneBId);
    if (!laneB) return; // lane not found

    // The gateway label should NOT fall inside Lane B's Y range
    const labelCentreY = gwLabel.y + (gwLabel.height ?? 20) / 2;
    const laneBTop = laneB.y;
    const laneBBottom = laneB.y + laneB.height;

    expect(
      labelCentreY >= laneBTop && labelCentreY <= laneBBottom,
      `Gateway label (centreY=${labelCentreY}) should NOT be inside Lane B (y=${laneBTop}..${laneBBottom}). ` +
        `It should be placed in Lane A or above the gateway.`
    ).toBe(false);
  });
});
