/**
 * Tests for elementType parameter on set_bpmn_element_properties.
 * Merges replace_bpmn_element into set_bpmn_element_properties.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import {
  handleSetProperties,
  TOOL_DEFINITION as SET_PROPS_TOOL,
} from '../../../src/handlers/properties/set-properties';
import { handleListElements } from '../../../src/handlers/elements/list-elements';
import { parseResult, createDiagram, addElement, connect, clearDiagrams } from '../../helpers';

describe('set_bpmn_element_properties with elementType', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('elementType replaces element type while preserving connections', async () => {
    const diagramId = await createDiagram();
    const startId = await addElement(diagramId, 'bpmn:StartEvent', { name: 'Start' });
    const taskId = await addElement(diagramId, 'bpmn:Task', { name: 'Do Work', x: 300, y: 100 });
    const endId = await addElement(diagramId, 'bpmn:EndEvent', { name: 'End', x: 500, y: 100 });
    await connect(diagramId, startId, taskId);
    await connect(diagramId, taskId, endId);

    const res = parseResult(
      await handleSetProperties({
        diagramId,
        elementId: taskId,
        properties: {},
        elementType: 'bpmn:UserTask',
      })
    );

    expect(res.success).toBe(true);
    expect(res.newType).toBe('bpmn:UserTask');
    expect(res.oldType).toBe('bpmn:Task');

    const elements = parseResult(await handleListElements({ diagramId }));
    const userTask = elements.elements.find((el: any) => el.type === 'bpmn:UserTask');
    expect(userTask).toBeDefined();
  });

  test('elementType with additional properties sets both type and properties', async () => {
    const diagramId = await createDiagram();
    const taskId = await addElement(diagramId, 'bpmn:Task', { name: 'Work' });

    const res = parseResult(
      await handleSetProperties({
        diagramId,
        elementId: taskId,
        properties: { name: 'Updated Work' },
        elementType: 'bpmn:ServiceTask',
      })
    );

    expect(res.success).toBe(true);
    expect(res.newType).toBe('bpmn:ServiceTask');
  });

  test('elementType no-op when type is same', async () => {
    const diagramId = await createDiagram();
    const taskId = await addElement(diagramId, 'bpmn:UserTask', { name: 'Test' });

    const res = parseResult(
      await handleSetProperties({
        diagramId,
        elementId: taskId,
        properties: {},
        elementType: 'bpmn:UserTask',
      })
    );

    expect(res.success).toBe(true);
    expect(res.message).toContain('no change needed');
  });

  test('elementType appears in tool definition schema', () => {
    const props = SET_PROPS_TOOL.inputSchema.properties;
    expect(props.elementType).toBeDefined();
    expect(props.elementType.type).toBe('string');
  });

  test('without elementType, normal property setting still works', async () => {
    const diagramId = await createDiagram();
    const taskId = await addElement(diagramId, 'bpmn:UserTask', { name: 'Test' });

    const res = parseResult(
      await handleSetProperties({
        diagramId,
        elementId: taskId,
        properties: { name: 'Updated Name' },
      })
    );

    expect(res.success).toBe(true);
  });
});
