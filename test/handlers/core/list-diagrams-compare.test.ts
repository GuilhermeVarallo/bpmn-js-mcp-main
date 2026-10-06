/**
 * Tests for the compareWith parameter on list_bpmn_diagrams.
 * Merges diff_bpmn_diagrams functionality into list_bpmn_diagrams.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { handleListDiagrams } from '../../../src/handlers';
import { TOOL_DEFINITION as LIST_DIAGRAMS_TOOL } from '../../../src/handlers/core/list-diagrams';
import { parseResult, createDiagram, addElement, clearDiagrams } from '../../helpers';

describe('list_bpmn_diagrams with compareWith', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('compareWith returns diff between two diagrams', async () => {
    const idA = await createDiagram();
    const idB = await createDiagram();
    await addElement(idB, 'bpmn:StartEvent', { name: 'Begin' });

    const res = parseResult(await handleListDiagrams({ diagramId: idA, compareWith: idB }));
    expect(res.success).toBe(true);
    expect(res.summary.addedCount).toBe(1);
    expect(res.summary.removedCount).toBe(0);
    expect(res.added[0].type).toBe('bpmn:StartEvent');
  });

  test('compareWith with identical diagrams returns identical=true', async () => {
    const idA = await createDiagram();
    const idB = await createDiagram();

    const res = parseResult(await handleListDiagrams({ diagramId: idA, compareWith: idB }));
    expect(res.success).toBe(true);
    expect(res.summary.identical).toBe(true);
  });

  test('compareWith detects removed elements', async () => {
    const idA = await createDiagram();
    await addElement(idA, 'bpmn:StartEvent', { name: 'Begin' });
    const idB = await createDiagram();

    const res = parseResult(await handleListDiagrams({ diagramId: idA, compareWith: idB }));
    expect(res.summary.removedCount).toBe(1);
    expect(res.removed[0].type).toBe('bpmn:StartEvent');
  });

  test('compareWith uses diagramId as base (A) and compareWith as changed (B)', async () => {
    const idA = await createDiagram();
    const idB = await createDiagram();
    await addElement(idB, 'bpmn:UserTask', { name: 'New Task' });

    const res = parseResult(await handleListDiagrams({ diagramId: idA, compareWith: idB }));
    // idA has no tasks (so the UserTask in idB is "added")
    expect(res.summary.addedCount).toBe(1);
    expect(res.added[0].type).toBe('bpmn:UserTask');
  });

  test('without compareWith, diagramId still returns summary', async () => {
    const id = await createDiagram('MyDiagram');
    await addElement(id, 'bpmn:StartEvent', { name: 'Start' });

    const res = parseResult(await handleListDiagrams({ diagramId: id }));
    // Summary mode — should not have diff fields
    expect(res.summary).toBeUndefined();
    expect(res.diagramName).toBe('MyDiagram');
  });

  test('compareWith fields appear in tool definition schema', () => {
    const props = LIST_DIAGRAMS_TOOL.inputSchema.properties;
    expect(props.compareWith).toBeDefined();
    expect(props.compareWith.type).toBe('string');
  });
});
