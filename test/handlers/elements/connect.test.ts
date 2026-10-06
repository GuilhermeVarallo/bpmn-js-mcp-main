import { describe, test, expect, beforeEach } from 'vitest';
import { handleConnect } from '../../../src/handlers';
import { parseResult, createDiagram, addElement, clearDiagrams } from '../../helpers';

describe('connect_bpmn_elements', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('connects two elements', async () => {
    const diagramId = await createDiagram();
    const aId = await addElement(diagramId, 'bpmn:StartEvent', {
      x: 100,
      y: 100,
    });
    const bId = await addElement(diagramId, 'bpmn:EndEvent', {
      x: 300,
      y: 100,
    });

    const conn = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: aId,
        targetElementId: bId,
        label: 'done',
      })
    );
    expect(conn.success).toBe(true);
    expect(conn.connectionId).toBeDefined();
  });

  test('defaults to SequenceFlow type', async () => {
    const diagramId = await createDiagram();
    const aId = await addElement(diagramId, 'bpmn:StartEvent', {
      x: 100,
      y: 100,
    });
    const bId = await addElement(diagramId, 'bpmn:EndEvent', {
      x: 300,
      y: 100,
    });
    const conn = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: aId,
        targetElementId: bId,
      })
    );
    expect(conn.connectionType).toBe('bpmn:SequenceFlow');
  });

  test('throws when source missing', async () => {
    const diagramId = await createDiagram();
    const bId = await addElement(diagramId, 'bpmn:EndEvent', {
      x: 300,
      y: 100,
    });
    await expect(
      handleConnect({
        diagramId,
        sourceElementId: 'no',
        targetElementId: bId,
      })
    ).rejects.toThrow(/Element not found/);
  });

  test('throws when target missing', async () => {
    const diagramId = await createDiagram();
    const aId = await addElement(diagramId, 'bpmn:StartEvent', {
      x: 100,
      y: 100,
    });
    await expect(
      handleConnect({
        diagramId,
        sourceElementId: aId,
        targetElementId: 'no',
      })
    ).rejects.toThrow(/Element not found/);
  });

  test('rejects EndEvent as source (pair mode)', async () => {
    const diagramId = await createDiagram();
    const endId = await addElement(diagramId, 'bpmn:EndEvent', {
      x: 100,
      y: 100,
    });
    const taskId = await addElement(diagramId, 'bpmn:UserTask', {
      x: 300,
      y: 100,
    });
    await expect(
      handleConnect({
        diagramId,
        sourceElementId: endId,
        targetElementId: taskId,
      })
    ).rejects.toThrow(/EndEvent is a flow sink/);
  });

  test('rejects EndEvent as source in chain mode', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent', {
      x: 100,
      y: 100,
    });
    const endId = await addElement(diagramId, 'bpmn:EndEvent', {
      x: 300,
      y: 100,
    });
    const taskId = await addElement(diagramId, 'bpmn:UserTask', {
      x: 500,
      y: 100,
    });
    await expect(
      handleConnect({
        diagramId,
        elementIds: [startId, endId, taskId],
      })
    ).rejects.toThrow(/EndEvent is a flow sink/);
  });
});

describe('connect_bpmn_elements — isDefault + conditionExpression warning', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('emits a warning when isDefault and conditionExpression are both set', async () => {
    const diagramId = await createDiagram();
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Check?' });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'Approve' });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'Reject' });

    // Connect first branch (normal conditional)
    await handleConnect({
      diagramId,
      sourceElementId: gw,
      targetElementId: taskA,
      conditionExpression: '${valid == true}',
    });

    // Connect second branch with BOTH isDefault AND conditionExpression — should warn
    const res = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: gw,
        targetElementId: taskB,
        conditionExpression: '${valid == false}',
        isDefault: true,
      })
    );

    expect(res.success).toBe(true);
    expect(res.warning).toMatch(/default.*condition|condition.*default/i);
  });

  test('no warning when isDefault is set without conditionExpression', async () => {
    const diagramId = await createDiagram();
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Check?' });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'Approve' });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'Reject' });

    await handleConnect({
      diagramId,
      sourceElementId: gw,
      targetElementId: taskA,
      conditionExpression: '${valid == true}',
    });

    const res = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: gw,
        targetElementId: taskB,
        isDefault: true,
      })
    );

    expect(res.success).toBe(true);
    expect(res.warning).toBeUndefined();
  });
});

describe('connect_bpmn_elements — descriptive flow IDs', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('generates a flow ID from label', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent', {
      name: 'Start',
      x: 100,
      y: 100,
    });
    const endId = await addElement(diagramId, 'bpmn:EndEvent', {
      name: 'End',
      x: 300,
      y: 100,
    });
    const conn = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: startId,
        targetElementId: endId,
        label: 'done',
      })
    );
    // Prefers short 2-part ID on first use
    expect(conn.connectionId).toBe('Flow_Done');
  });

  test('generates a flow ID from source/target names when no label', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent', {
      name: 'Begin',
      x: 100,
      y: 100,
    });
    const endId = await addElement(diagramId, 'bpmn:EndEvent', {
      name: 'Finish',
      x: 300,
      y: 100,
    });
    const conn = parseResult(
      await handleConnect({
        diagramId,
        sourceElementId: startId,
        targetElementId: endId,
      })
    );
    // Prefers short 2-part ID on first use
    expect(conn.connectionId).toBe('Flow_Begin_to_Finish');
  });

  test('skips duplicate: second connect between same pair returns skipped with warning', async () => {
    const diagramId = await createDiagram();
    const aId = await addElement(diagramId, 'bpmn:StartEvent', { x: 100, y: 100 });
    const bId = await addElement(diagramId, 'bpmn:EndEvent', { x: 300, y: 100 });

    // First connect — creates the flow
    const first = parseResult(
      await handleConnect({ diagramId, sourceElementId: aId, targetElementId: bId })
    );
    expect(first.success).toBe(true);
    const existingId = first.connectionId;

    // Second connect — should skip
    const second = parseResult(
      await handleConnect({ diagramId, sourceElementId: aId, targetElementId: bId })
    );
    expect(second.skipped).toBe(true);
    expect(second.existingConnectionId).toBe(existingId);
    expect(second.warning).toMatch(/already exists/i);
  });
});
