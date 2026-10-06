/**
 * Tests for gateway label four-sided scoring.
 *
 * Bug: `getDefaultLabelPosition()` in `adjust-labels.ts` always places gateway
 * labels at `(centreX, bottom + padding)` regardless of whether outgoing flows
 * exit from the bottom vertex. This overlaps with downward-exiting branches.
 *
 * Fix: introduce `getGatewayLabelPosition()` that scores all four candidate
 * sides (above / below / left / right) and picks the face with no departing
 * flow endpoint docked to it.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleLayoutDiagram } from '../../../src/handlers';
import { createDiagram, addElement, connect, clearDiagrams } from '../../helpers';
import { getDiagram } from '../../../src/diagram-manager';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Return true when a label rect (x,y,w,h) overlaps with a flow waypoint
 * segment. A label overlaps when any segment passes through the label box.
 */
function labelOverlapsWaypoints(
  labelX: number,
  labelY: number,
  labelW: number,
  labelH: number,
  waypoints: Array<{ x: number; y: number }>
): boolean {
  // Inflate label rect by 5px tolerance
  const x1 = labelX - 5;
  const y1 = labelY - 5;
  const x2 = labelX + labelW + 5;
  const y2 = labelY + labelH + 5;

  for (let i = 1; i < waypoints.length; i++) {
    const ax = waypoints[i - 1].x;
    const ay = waypoints[i - 1].y;
    const bx = waypoints[i].x;
    const by = waypoints[i].y;

    // Segment AABB
    const segX1 = Math.min(ax, bx);
    const segY1 = Math.min(ay, by);
    const segX2 = Math.max(ax, bx);
    const segY2 = Math.max(ay, by);

    // Label-vs-segment AABB intersection
    if (segX1 <= x2 && segX2 >= x1 && segY1 <= y2 && segY2 >= y1) {
      return true;
    }
  }
  return false;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('gateway label four-sided scoring', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('gateway label is NOT placed below when downward flow exits from gateway bottom', async () => {
    // Build: Start → Gateway (fan-out) → TaskAbove (top branch)
    //                                  → TaskBelow (bottom branch — exits gateway bottom)
    // Both tasks reconnect to End.
    const diagramId = await createDiagram('Gateway Label Test');
    const start = await addElement(diagramId, 'bpmn:StartEvent', { name: 'Start' });
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Check?' });
    const taskAbove = await addElement(diagramId, 'bpmn:Task', { name: 'Task Above' });
    const taskBelow = await addElement(diagramId, 'bpmn:Task', { name: 'Task Below' });
    const end = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End' });

    await connect(diagramId, start, gw);
    const fUp = await connect(diagramId, gw, taskAbove);
    const fDown = await connect(diagramId, gw, taskBelow);
    await connect(diagramId, taskAbove, end);
    await connect(diagramId, taskBelow, end);

    // Run full layout to position elements properly
    await handleLayoutDiagram({ diagramId });

    const diagram = getDiagram(diagramId)!;
    const reg = diagram.modeler.get('elementRegistry') as any;

    const gwEl = reg.get(gw);
    const gwLabel = gwEl.label;
    if (!gwLabel) return; // no label to check

    const fDownConn = reg.get(fDown);
    const fUpConn = reg.get(fUp);

    // If the downward flow exits from below the gateway Y midpoint, the label
    // placed at (centreX, bottom + padding) would sit directly on the downward path.
    // The fix should detect this and place the label above the gateway instead.
    const gwBottom = gwEl.y + gwEl.height;
    const gwMidY = gwEl.y + gwEl.height / 2;

    // Check if the down-branch flow has waypoints that exit below the gateway
    const downWps: Array<{ x: number; y: number }> = fDownConn?.waypoints ?? [];
    const upWps: Array<{ x: number; y: number }> = fUpConn?.waypoints ?? [];

    const hasDownwardExit = downWps.some((wp) => wp.y > gwBottom + 5);
    const hasUpwardExit = upWps.some((wp) => wp.y < gwEl.y - 5);

    // Only run the overlap check when the layout produced a vertical fan-out
    if (!hasDownwardExit || !hasUpwardExit) {
      // Layout produced a horizontal arrangement — no overlap issue in this case
      return;
    }

    const labelX = gwLabel.x;
    const labelY = gwLabel.y;
    const labelW = gwLabel.width ?? 70;
    const labelH = gwLabel.height ?? 20;

    // THE KEY ASSERTION: label must not overlap with the downward-exiting flow
    const overlapsDownFlow = labelOverlapsWaypoints(labelX, labelY, labelW, labelH, downWps);
    expect(
      overlapsDownFlow,
      `Gateway label at (${labelX},${labelY}) overlaps with downward flow (exits below gateway at y=${gwMidY}). ` +
        `Expected label to be placed above the gateway.`
    ).toBe(false);

    // The label should be above the gateway midline when there's a downward exit flow
    const labelCentreY = labelY + labelH / 2;
    expect(
      labelCentreY < gwMidY,
      `Expected gateway label centreY (${labelCentreY}) to be ABOVE gateway midline (${gwMidY}) ` +
        `when a downward flow exits from the gateway bottom.`
    ).toBe(true);
  });

  test('gateway label placed in free quadrant — not on a side with outgoing flows', async () => {
    // A simpler check: after layout with fan-out, the label should not be at the
    // bottom when a downward flow is detected. Run adjustDiagramLabels and check.
    const diagramId = await createDiagram('Gateway Quadrant Test');
    const start = await addElement(diagramId, 'bpmn:StartEvent', { name: 'Start' });
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Route?' });
    const t1 = await addElement(diagramId, 'bpmn:Task', { name: 'Path A' });
    const t2 = await addElement(diagramId, 'bpmn:Task', { name: 'Path B' });
    const end = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End' });

    await connect(diagramId, start, gw);
    await connect(diagramId, gw, t1);
    await connect(diagramId, gw, t2);
    await connect(diagramId, t1, end);
    await connect(diagramId, t2, end);

    // Run full layout
    await handleLayoutDiagram({ diagramId });

    const diagram = getDiagram(diagramId)!;
    const reg = diagram.modeler.get('elementRegistry') as any;

    const gwEl = reg.get(gw);
    const gwLabel = gwEl.label;
    if (!gwLabel) return; // no label

    // Collect all outgoing flow waypoints from the gateway
    const outgoingConns = (gwEl.outgoing ?? []).map((f: any) => reg.get(f.id));
    const allOutWaypoints = outgoingConns.flatMap((c: any) => c?.waypoints ?? []);

    if (allOutWaypoints.length < 2) return; // not enough data to check

    // The gateway label should not overlap with any outgoing flow paths
    const labelX = gwLabel.x;
    const labelY = gwLabel.y;
    const labelW = gwLabel.width ?? 70;
    const labelH = gwLabel.height ?? 20;

    // Check against each individual connection's waypoints (not all combined)
    for (const conn of outgoingConns) {
      if (!conn?.waypoints?.length) continue;
      const overlaps = labelOverlapsWaypoints(labelX, labelY, labelW, labelH, conn.waypoints);
      if (overlaps) {
        // Report as a soft expectation — we expect this to be false after the fix
        expect(
          overlaps,
          `Gateway label at (${labelX},${labelY},${labelW}x${labelH}) overlaps with ` +
            `outgoing flow ${conn.id} waypoints. Label should be on a flow-free side.`
        ).toBe(false);
      }
    }
  });
});
