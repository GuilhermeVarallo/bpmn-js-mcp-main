/**
 * Tests for the bpmn-mcp/disconnected-association-di lint rule.
 *
 * The rule reports an error when a bpmn:Association's BPMNEdge has its
 * first waypoint outside the source element's DI bounds (+ tolerance) or
 * its last waypoint outside the target element's DI bounds (+ tolerance).
 * This catches stale association waypoints that make the edge invisible.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleValidate } from '../../../src/handlers/core/validate';
import { handleImportXml } from '../../../src/handlers';
import { parseResult, createDiagram, addElement, connect, clearDiagrams } from '../../helpers';

describe('bpmnlint rule: disconnected-association-di', () => {
  beforeEach(() => {
    clearDiagrams();
  });

  test('no issues for a normal annotation association with good waypoints', async () => {
    // Build a diagram with a text annotation connected via association
    // using normal API (waypoints will be within bounds)
    const diagramId = await createDiagram('Good association');
    const task = await addElement(diagramId, 'bpmn:Task', { name: 'Do something' });
    const annotation = parseResult(
      await import('../../../src/handlers').then((h) =>
        h.handleAddElement({ diagramId, elementType: 'bpmn:TextAnnotation', name: 'Note' })
      )
    ).elementId;
    await connect(diagramId, task, annotation);

    const res = parseResult(await handleValidate({ diagramId }));
    const issues = res.issues.filter((i: any) => i.rule === 'bpmn-mcp/disconnected-association-di');
    expect(issues).toHaveLength(0);
  });

  test('reports error for association with first waypoint far outside source bounds', async () => {
    // Import BPMN XML with a text annotation association whose first waypoint
    // is at (100, 82) — far from the source element at (433, 200).
    // This reproduces the compensation association stale-waypoints bug.
    const xmlWithStaleAssociation = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:startEvent id="StartEvent_1" />
    <bpmn:task id="Task_Host" name="Host Task" />
    <bpmn:task id="Task_Handler" name="Handler Task" isForCompensation="true" />
    <bpmn:boundaryEvent id="BoundaryEvent_Comp" attachedToRef="Task_Host" cancelActivity="false">
      <bpmn:compensateEventDefinition id="CompDef_1" />
    </bpmn:boundaryEvent>
    <bpmn:association id="Assoc_1" sourceRef="BoundaryEvent_Comp" targetRef="Task_Handler" />
    <bpmn:sequenceFlow id="Flow_1" sourceRef="StartEvent_1" targetRef="Task_Host" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="StartEvent_1_di" bpmnElement="StartEvent_1">
        <dc:Bounds x="152" y="222" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Host_di" bpmnElement="Task_Host">
        <dc:Bounds x="260" y="200" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_Handler_di" bpmnElement="Task_Handler">
        <dc:Bounds x="130" y="340" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="BoundaryEvent_Comp_di" bpmnElement="BoundaryEvent_Comp">
        <dc:Bounds x="433" y="222" width="36" height="36" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNEdge id="Flow_1_di" bpmnElement="Flow_1">
        <di:waypoint x="188" y="240" />
        <di:waypoint x="260" y="240" />
      </bpmndi:BPMNEdge>
      <!-- Stale association: first waypoint at (100,82) is far from source at (433,222) -->
      <bpmndi:BPMNEdge id="Assoc_1_di" bpmnElement="Assoc_1">
        <di:waypoint x="100" y="82" />
        <di:waypoint x="100" y="60" />
        <di:waypoint x="180" y="60" />
        <di:waypoint x="180" y="340" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const importRes = parseResult(
      await handleImportXml({ xml: xmlWithStaleAssociation, autoLayout: false })
    );
    const diagramId = importRes.diagramId;
    expect(diagramId).toBeDefined();

    const res = parseResult(await handleValidate({ diagramId }));
    const issues = res.issues.filter((i: any) => i.rule === 'bpmn-mcp/disconnected-association-di');

    expect(issues.length).toBeGreaterThanOrEqual(1);
    // Should reference the association element ID
    expect(
      issues.some((i: any) => i.elementId === 'Assoc_1' || i.message?.includes('Assoc_1'))
    ).toBe(true);
  });

  test('no issues when association waypoints are within tolerance of source/target bounds', async () => {
    // Import XML where the association waypoint is within 20px of the source element
    const xmlWithGoodAssociation = `<?xml version="1.0" encoding="UTF-8"?>
<bpmn:definitions xmlns:bpmn="http://www.omg.org/spec/BPMN/20100524/MODEL"
                  xmlns:bpmndi="http://www.omg.org/spec/BPMN/20100524/DI"
                  xmlns:dc="http://www.omg.org/spec/DD/20100524/DC"
                  xmlns:di="http://www.omg.org/spec/DD/20100524/DI"
                  id="Definitions_1" targetNamespace="http://bpmn.io/schema/bpmn">
  <bpmn:process id="Process_1" isExecutable="true">
    <bpmn:task id="Task_A" name="Task A" />
    <bpmn:task id="Task_B" name="Task B" isForCompensation="true" />
    <bpmn:boundaryEvent id="BoundaryEvent_1" attachedToRef="Task_A" cancelActivity="false">
      <bpmn:compensateEventDefinition id="CompDef_1" />
    </bpmn:boundaryEvent>
    <bpmn:association id="Assoc_Good" sourceRef="BoundaryEvent_1" targetRef="Task_B" />
  </bpmn:process>
  <bpmndi:BPMNDiagram id="BPMNDiagram_1">
    <bpmndi:BPMNPlane id="BPMNPlane_1" bpmnElement="Process_1">
      <bpmndi:BPMNShape id="Task_A_di" bpmnElement="Task_A">
        <dc:Bounds x="200" y="200" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="Task_B_di" bpmnElement="Task_B">
        <dc:Bounds x="200" y="360" width="100" height="80" />
      </bpmndi:BPMNShape>
      <bpmndi:BPMNShape id="BoundaryEvent_1_di" bpmnElement="BoundaryEvent_1">
        <dc:Bounds x="232" y="262" width="36" height="36" />
      </bpmndi:BPMNShape>
      <!-- Good waypoints: first point (250,280) is within source bounds (232,262,36,36) -->
      <!-- Last point (250,360) is at the top edge of target (200,360,100,80) -->
      <bpmndi:BPMNEdge id="Assoc_Good_di" bpmnElement="Assoc_Good">
        <di:waypoint x="250" y="280" />
        <di:waypoint x="250" y="360" />
      </bpmndi:BPMNEdge>
    </bpmndi:BPMNPlane>
  </bpmndi:BPMNDiagram>
</bpmn:definitions>`;

    const importRes = parseResult(
      await handleImportXml({ xml: xmlWithGoodAssociation, autoLayout: false })
    );
    const diagramId = importRes.diagramId;

    const res = parseResult(await handleValidate({ diagramId }));
    const issues = res.issues.filter((i: any) => i.rule === 'bpmn-mcp/disconnected-association-di');
    expect(issues).toHaveLength(0);
  });
});
