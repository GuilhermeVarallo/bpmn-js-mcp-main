/**
 * Tests for waypoints parameter on connect_bpmn_elements.
 * Merges set_bpmn_connection_waypoints into connect_bpmn_elements.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { handleConnect } from '../../../src/handlers/elements/connect';
import { TOOL_DEFINITION as CONNECT_TOOL } from '../../../src/handlers/elements/connect-schema';
import { parseResult, createDiagram, addElement, connect, clearDiagrams } from '../../helpers';

describe('connect_bpmn_elements with waypoints', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('connectionId + waypoints sets waypoints on existing connection', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent', { x: 100, y: 200 });
    const taskId = await addElement(diagramId, 'bpmn:Task', {
      name: 'Do something',
      x: 300,
      y: 200,
    });
    const flowId = await connect(diagramId, startId, taskId);

    const waypoints = [
      { x: 136, y: 218 },
      { x: 200, y: 300 },
      { x: 300, y: 240 },
    ];

    const res = parseResult(await handleConnect({ diagramId, connectionId: flowId, waypoints }));

    expect(res.success).toBe(true);
    expect(res.connectionId).toBe(flowId);
    expect(res.newWaypoints).toEqual(waypoints);
    expect(res.waypointCount).toBe(3);
  });

  test('connectionId without waypoints fails with clear error', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent');
    const taskId = await addElement(diagramId, 'bpmn:Task', { name: 'Work' });
    const flowId = await connect(diagramId, startId, taskId);

    const res = parseResult(await handleConnect({ diagramId, connectionId: flowId } as any));

    expect(res.success).toBe(false);
    expect(res.error).toContain('waypoints');
  });

  test('waypoints without connectionId fails with clear error', async () => {
    const diagramId = await createDiagram();
    const waypoints = [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ];

    const res = parseResult(await handleConnect({ diagramId, waypoints } as any));

    expect(res.success).toBe(false);
    expect(res.error).toContain('connectionId');
  });

  test('rejects non-connection element via connectionId', async () => {
    const diagramId = await createDiagram();
    const taskId = await addElement(diagramId, 'bpmn:Task', { name: 'Not a flow' });

    const waypoints = [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ];

    const res = parseResult(await handleConnect({ diagramId, connectionId: taskId, waypoints }));

    expect(res.success).toBe(false);
    expect(res.error).toContain('not a connection');
  });

  test('rejects fewer than 2 waypoints', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent', { x: 100, y: 200 });
    const taskId = await addElement(diagramId, 'bpmn:Task', { x: 300, y: 200 });
    const flowId = await connect(diagramId, startId, taskId);

    const res = parseResult(
      await handleConnect({ diagramId, connectionId: flowId, waypoints: [{ x: 100, y: 100 }] })
    );

    expect(res.success).toBe(false);
    expect(res.error).toContain('at least 2 points');
  });

  test('waypoints and connectionId appear in tool definition schema', () => {
    const props = CONNECT_TOOL.inputSchema.properties;
    expect(props.waypoints).toBeDefined();
    expect(props.connectionId).toBeDefined();
    expect(props.waypoints.type).toBe('array');
  });

  test('normal connect (pair mode) still works', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent');
    const taskId = await addElement(diagramId, 'bpmn:Task', { name: 'Work' });

    const res = parseResult(
      await handleConnect({ diagramId, sourceElementId: startId, targetElementId: taskId })
    );

    expect(res.success).toBe(true);
    expect(res.connectionId).toBeDefined();
  });
});
