import { describe, test, expect, beforeEach } from 'vitest';
import { handleValidate, handleSetProperties } from '../../../src/handlers';
import { parseResult, createDiagram, addElement, clearDiagrams, connect } from '../../helpers';

describe('bpmn-mcp/default-flow-with-condition rule', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('warns when default flow also has a conditionExpression', async () => {
    const diagramId = await createDiagram('Default With Condition');
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Valid?' });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'Approve' });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'Reject' });

    await connect(diagramId, gw, taskA, { conditionExpression: '${valid == true}' });
    const flowB = await connect(diagramId, gw, taskB, {
      conditionExpression: '${valid == false}',
    });

    // Mark flowB as the default AND give it a condition (the bad case)
    await handleSetProperties({
      diagramId,
      elementId: gw,
      properties: { default: flowB },
    });

    const res = parseResult(
      await handleValidate({
        diagramId,
        config: {
          rules: { 'bpmn-mcp/default-flow-with-condition': 'warn' },
        },
      })
    );

    const issues = res.issues.filter((i: any) => i.rule === 'bpmn-mcp/default-flow-with-condition');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].message).toMatch(/default.*condition|condition.*default/i);
  });

  test('does not warn when default flow has no condition', async () => {
    const diagramId = await createDiagram('Default No Condition');
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Valid?' });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'Approve' });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'Reject' });

    await connect(diagramId, gw, taskA, { conditionExpression: '${valid == true}' });
    const flowB = await connect(diagramId, gw, taskB);

    // Mark flowB as default — no condition on it (valid case)
    await handleSetProperties({
      diagramId,
      elementId: gw,
      properties: { default: flowB },
    });

    const res = parseResult(
      await handleValidate({
        diagramId,
        config: {
          rules: { 'bpmn-mcp/default-flow-with-condition': 'warn' },
        },
      })
    );

    const issues = res.issues.filter((i: any) => i.rule === 'bpmn-mcp/default-flow-with-condition');
    expect(issues.length).toBe(0);
  });

  test('does not warn when no default flow is set', async () => {
    const diagramId = await createDiagram('No Default');
    const gw = await addElement(diagramId, 'bpmn:ExclusiveGateway', { name: 'Check?' });
    const taskA = await addElement(diagramId, 'bpmn:Task', { name: 'A' });
    const taskB = await addElement(diagramId, 'bpmn:Task', { name: 'B' });
    await connect(diagramId, gw, taskA, { conditionExpression: '${x}' });
    await connect(diagramId, gw, taskB, { conditionExpression: '${!x}' });

    const res = parseResult(
      await handleValidate({
        diagramId,
        config: {
          rules: { 'bpmn-mcp/default-flow-with-condition': 'warn' },
        },
      })
    );

    const issues = res.issues.filter((i: any) => i.rule === 'bpmn-mcp/default-flow-with-condition');
    expect(issues.length).toBe(0);
  });
});
