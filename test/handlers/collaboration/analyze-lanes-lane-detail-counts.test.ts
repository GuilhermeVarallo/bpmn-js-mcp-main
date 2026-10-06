/**
 * Tests for Issue H — BoundaryEvents and compensation handlers should NOT be
 * counted in totalFlowNodes, laneDetails.elementCount, or currentLanes.elementCount,
 * and must not appear in suggest-mode suggestion elementIds.
 *
 * Sub-issues:
 *   H1: suggest mode totalFlowNodes includes BoundaryEvents (should exclude them)
 *   H2: suggest mode suggestions include BoundaryEvent IDs in elementIds (misleading)
 *   H3: validate mode laneDetails.elementCount includes BoundaryEvents and comp. handlers
 *   H4: suggest mode currentLanes.elementCount is inflated by BoundaryEvents/comp. handlers
 */

import { describe, test, expect, beforeEach } from 'vitest';
import { handleAnalyzeLanes } from '../../../src/handlers/collaboration/analyze-lanes';
import {
  handleAddElement,
  handleConnect,
  handleCreateLanes,
  handleCreateParticipant,
  handleSetProperties,
} from '../../../src/handlers';
import { createDiagram, addElement, clearDiagrams, parseResult } from '../../helpers';

describe('Issue H — lane detail counts exclude BoundaryEvents and compensation handlers', () => {
  beforeEach(() => clearDiagrams());

  // ── H1: suggest mode totalFlowNodes ────────────────────────────────────────

  describe('H1 — suggest mode totalFlowNodes excludes BoundaryEvents', () => {
    test('adding a timer BoundaryEvent does not increase suggest totalFlowNodes', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Test Pool', height: 400 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Agent' }, { name: 'System' }],
        })
      );
      const agentLaneId = lanesRes.laneIds[0] as string;

      // Add one UserTask to the lane
      const taskId = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Handle Request',
        laneId: agentLaneId,
      });

      // Baseline: suggest with just the task
      const baselineRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );
      const baselineCount = baselineRes.totalFlowNodes as number;

      // Add a timer BoundaryEvent on the task
      const beRes = parseResult(
        await handleAddElement({
          diagramId,
          elementType: 'bpmn:BoundaryEvent',
          hostElementId: taskId,
          name: 'SLA Timer',
          eventDefinitionType: 'bpmn:TimerEventDefinition',
          eventDefinitionProperties: { timeDuration: 'PT1H' },
        })
      );
      const boundaryEventId = beRes.elementId as string;

      const afterRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );

      // H1: totalFlowNodes must NOT increase after adding a BoundaryEvent
      expect(afterRes.totalFlowNodes).toBe(baselineCount);
      // Sanity: baseline is 1 (just the UserTask — start/end events are flow-control)
      // For a pool with no connections, baseline should be small
      expect(afterRes.totalFlowNodes).toBeLessThanOrEqual(baselineCount);

      // H2: BoundaryEvent ID must not appear in any suggestion's elementIds
      const allSuggestedIds: string[] = (afterRes.suggestions as any[]).flatMap(
        (s: any) => s.elementIds as string[]
      );
      expect(allSuggestedIds).not.toContain(boundaryEventId);
    });

    test('suggest totalFlowNodes matches validate totalFlowNodes even with BoundaryEvents', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Ticket Process', height: 400 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Customer' }, { name: 'Support' }, { name: 'System' }],
        })
      );
      const customerLane = lanesRes.laneIds[0] as string;
      const supportLane = lanesRes.laneIds[1] as string;
      const systemLane = lanesRes.laneIds[2] as string;

      // Build a realistic diagram with boundary events (like Diagram 6)
      const start = await addElement(diagramId, 'bpmn:StartEvent', {
        name: 'Start',
        laneId: customerLane,
      });
      const task1 = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Triage',
        laneId: supportLane,
      });
      const svc = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Auto-Process',
        laneId: systemLane,
      });
      const end = await addElement(diagramId, 'bpmn:EndEvent', {
        name: 'Done',
        laneId: customerLane,
      });

      await handleConnect({ diagramId, sourceElementId: start, targetElementId: task1 });
      await handleConnect({ diagramId, sourceElementId: task1, targetElementId: svc });
      await handleConnect({ diagramId, sourceElementId: svc, targetElementId: end });

      // Add timer boundary event on task1
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: task1,
        name: 'Escalation Timer',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
        eventDefinitionProperties: { timeDuration: 'PT4H' },
      });

      // Add error boundary event on svc
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: svc,
        name: 'Service Error',
        eventDefinitionType: 'bpmn:ErrorEventDefinition',
        errorRef: { id: 'Error_SvcFailed', name: 'Service Failed' },
      });

      const suggestRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );
      const validateRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'validate', participantId })
      );

      // H1: suggest and validate totalFlowNodes must agree
      expect(suggestRes.totalFlowNodes).toBe(validateRes.totalFlowNodes);
    });
  });

  // ── H2: BoundaryEvent IDs in suggestion elementIds ────────────────────────
  // Note: H2 only manifests with ROLE-BASED grouping (≥2 distinct candidateGroups)
  // because role-based suggestions run assignFlowControlToLanesSuggest which uses
  // outgoing flows from boundary events to vote them into a lane, then
  // appendFlowControlToSuggestions adds them to the suggestion elementIds.

  describe('H2 — suggest mode suggestions do not include BoundaryEvent IDs', () => {
    test('BoundaryEvent IDs absent from role-based suggestion elementIds (with candidateGroups)', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Process', height: 400 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Agent' }, { name: 'System' }],
        })
      );
      const agentLane = lanesRes.laneIds[0] as string;
      const systemLane = lanesRes.laneIds[1] as string;

      const agentTask = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Review',
        laneId: agentLane,
      });
      // Set candidateGroups to trigger role-based grouping (need ≥2 distinct roles)
      await handleSetProperties({
        diagramId,
        elementId: agentTask,
        properties: { 'camunda:candidateGroups': 'agent' },
      });

      const svcTask = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Process',
        laneId: systemLane,
      });
      await handleConnect({ diagramId, sourceElementId: agentTask, targetElementId: svcTask });

      // Add timer boundary event on agentTask and connect it to an escalation handler
      // (connection triggers role-voting which adds boundary event to suggestions)
      const timerBE = parseResult(
        await handleAddElement({
          diagramId,
          elementType: 'bpmn:BoundaryEvent',
          hostElementId: agentTask,
          name: 'Reminder',
          eventDefinitionType: 'bpmn:TimerEventDefinition',
          eventDefinitionProperties: { timeDuration: 'PT2H' },
        })
      );
      const timerBeId = timerBE.elementId as string;

      const escalateTask = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Escalate',
        laneId: agentLane,
      });
      await handleSetProperties({
        diagramId,
        elementId: escalateTask,
        properties: { 'camunda:candidateGroups': 'manager' },
      });
      // Connect boundary event to escalation handler — this gives it a vote in role assignment
      await handleConnect({ diagramId, sourceElementId: timerBeId, targetElementId: escalateTask });

      const res = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );

      // Must use role-based grouping
      expect(res.groupingStrategy).toBe('role');

      const allIds: string[] = (res.suggestions as any[]).flatMap(
        (s: any) => s.elementIds as string[]
      );
      // H2: BoundaryEvent IDs must NOT appear in any suggestion's elementIds
      expect(allIds).not.toContain(timerBeId);
    });

    test('BoundaryEvent IDs absent from nextSteps args.elementIds in role-based grouping', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Process', height: 300 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Worker' }, { name: 'Manager' }],
        })
      );
      const workerLane = lanesRes.laneIds[0] as string;
      const managerLane = lanesRes.laneIds[1] as string;

      const task1 = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Do Work',
        laneId: workerLane,
      });
      await handleSetProperties({
        diagramId,
        elementId: task1,
        properties: { 'camunda:candidateGroups': 'worker' },
      });

      const task2 = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Approve',
        laneId: managerLane,
      });
      await handleSetProperties({
        diagramId,
        elementId: task2,
        properties: { 'camunda:candidateGroups': 'manager' },
      });
      await handleConnect({ diagramId, sourceElementId: task1, targetElementId: task2 });

      // Add boundary event on task1 and connect to an escalation
      const beRes = parseResult(
        await handleAddElement({
          diagramId,
          elementType: 'bpmn:BoundaryEvent',
          hostElementId: task1,
          name: 'Timeout',
          eventDefinitionType: 'bpmn:TimerEventDefinition',
          eventDefinitionProperties: { timeDuration: 'PT30M' },
        })
      );
      const beId = beRes.elementId as string;

      const escalate = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Escalate',
        laneId: managerLane,
      });
      await handleSetProperties({
        diagramId,
        elementId: escalate,
        properties: { 'camunda:candidateGroups': 'manager' },
      });
      await handleConnect({ diagramId, sourceElementId: beId, targetElementId: escalate });

      const res = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );

      // Must use role-based grouping
      expect(res.groupingStrategy).toBe('role');

      const allNextStepIds: string[] = (res.nextSteps as any[]).flatMap(
        (step: any) => (step.args?.elementIds as string[]) ?? []
      );
      // H2: BoundaryEvent IDs must NOT appear in any nextStep's elementIds
      expect(allNextStepIds).not.toContain(beId);
    });
  });

  // ── H3: validate mode laneDetails.elementCount ───────────────────────────

  describe('H3 — validate mode laneDetails.elementCount excludes BoundaryEvents and compensation handlers', () => {
    test('laneDetails.elementCount does not count BoundaryEvent attached to task in lane', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Process', height: 300 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Worker' }, { name: 'System' }],
        })
      );
      const workerLane = lanesRes.laneIds[0] as string;

      const task = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Main Task',
        laneId: workerLane,
      });

      // Baseline count
      const baselineRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'validate', participantId })
      );
      const baselineDetail = (baselineRes.laneDetails as any[]).find(
        (d: any) => d.laneId === workerLane
      );
      const baselineCount = baselineDetail?.elementCount ?? 0;

      // Add boundary event on the task
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: task,
        name: 'Timer',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
        eventDefinitionProperties: { timeDuration: 'PT1H' },
      });

      const afterRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'validate', participantId })
      );
      const afterDetail = (afterRes.laneDetails as any[]).find((d: any) => d.laneId === workerLane);
      const afterCount = afterDetail?.elementCount ?? 0;

      // H3: elementCount must NOT increase after adding a BoundaryEvent
      expect(afterCount).toBe(baselineCount);
    });

    test('laneDetails.elementCount does not count compensation handler (isForCompensation=true)', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Process', height: 300 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'System' }, { name: 'Finance' }],
        })
      );
      const systemLane = lanesRes.laneIds[0] as string;

      // Add normal ServiceTask
      const normalSvc = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Process Payment',
        laneId: systemLane,
      });

      // Add compensation handler task (isForCompensation=true)
      const compHandler = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Refund Payment',
        laneId: systemLane,
      });
      await handleSetProperties({
        diagramId,
        elementId: compHandler,
        properties: { isForCompensation: true },
      });

      // Add compensation boundary event linking them
      const compBERes = parseResult(
        await handleAddElement({
          diagramId,
          elementType: 'bpmn:BoundaryEvent',
          hostElementId: normalSvc,
          name: 'Compensate',
          eventDefinitionType: 'bpmn:CompensateEventDefinition',
        })
      );
      await handleConnect({
        diagramId,
        sourceElementId: compBERes.elementId,
        targetElementId: compHandler,
        connectionType: 'bpmn:Association',
      });

      const res = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'validate', participantId })
      );

      const systemDetail = (res.laneDetails as any[]).find((d: any) => d.laneName === 'System');

      // H3: elementCount should be 1 (only normalSvc — not compBE, not compHandler)
      expect(systemDetail?.elementCount).toBe(1);

      // Sanity: totalFlowNodes also should be 1
      expect(res.totalFlowNodes).toBe(1);
    });

    test('sum of laneDetail elementCounts equals totalFlowNodes', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Mixed Process', height: 450 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Customer' }, { name: 'Agent' }, { name: 'System' }],
        })
      );
      const customerLane = lanesRes.laneIds[0] as string;
      const agentLane = lanesRes.laneIds[1] as string;
      const systemLane = lanesRes.laneIds[2] as string;

      // Build diagram like Diagram 7 (compensation + error boundary events)
      const start = await addElement(diagramId, 'bpmn:StartEvent', {
        name: 'Start',
        laneId: customerLane,
      });
      const entry = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Enter Details',
        laneId: customerLane,
      });
      const svc1 = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Reserve',
        laneId: systemLane,
      });
      const svc2 = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Charge',
        laneId: systemLane,
      });
      const review = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Review',
        laneId: agentLane,
      });
      const end = await addElement(diagramId, 'bpmn:EndEvent', {
        name: 'End',
        laneId: customerLane,
      });

      await handleConnect({ diagramId, sourceElementId: start, targetElementId: entry });
      await handleConnect({ diagramId, sourceElementId: entry, targetElementId: svc1 });
      await handleConnect({ diagramId, sourceElementId: svc1, targetElementId: svc2 });
      await handleConnect({ diagramId, sourceElementId: svc2, targetElementId: end });

      // Add compensation boundary event + handler
      const compBERes = parseResult(
        await handleAddElement({
          diagramId,
          elementType: 'bpmn:BoundaryEvent',
          hostElementId: svc1,
          name: 'Compensate Reserve',
          eventDefinitionType: 'bpmn:CompensateEventDefinition',
        })
      );
      const compHandler = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Release Funds',
        laneId: systemLane,
      });
      await handleSetProperties({
        diagramId,
        elementId: compHandler,
        properties: { isForCompensation: true },
      });
      await handleConnect({
        diagramId,
        sourceElementId: compBERes.elementId,
        targetElementId: compHandler,
        connectionType: 'bpmn:Association',
      });

      // Add error boundary event on svc2
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: svc2,
        name: 'Charge Error',
        eventDefinitionType: 'bpmn:ErrorEventDefinition',
        errorRef: { id: 'Error_ChargeFailed2', name: 'Charge Failed' },
      });

      await handleConnect({ diagramId, sourceElementId: svc2, targetElementId: review });
      await handleConnect({ diagramId, sourceElementId: review, targetElementId: end });

      const res = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'validate', participantId })
      );

      // H3: sum of laneDetail elementCounts must equal totalFlowNodes
      const laneSum = (res.laneDetails as any[]).reduce(
        (acc: number, d: any) => acc + (d.elementCount as number),
        0
      );
      expect(laneSum).toBe(res.totalFlowNodes as number);
    });
  });

  // ── H4: suggest mode currentLanes.elementCount ───────────────────────────

  describe('H4 — suggest mode currentLanes.elementCount excludes BoundaryEvents and compensation handlers', () => {
    test('currentLanes.elementCount does not count BoundaryEvents', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Process', height: 300 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Agent' }, { name: 'System' }],
        })
      );
      const agentLane = lanesRes.laneIds[0] as string;

      const task = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Handle Request',
        laneId: agentLane,
      });

      // Add timer boundary event on the task
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: task,
        name: 'SLA',
        eventDefinitionType: 'bpmn:TimerEventDefinition',
        eventDefinitionProperties: { timeDuration: 'PT1H' },
      });

      const res = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );

      // currentLanes must be present (lane already has elements)
      expect(res.currentLanes).toBeDefined();
      const agentDetail = (res.currentLanes as any[]).find((d: any) => d.name === 'Agent');

      // H4: elementCount should be 1 (only the UserTask, not the BoundaryEvent)
      expect(agentDetail?.elementCount).toBe(1);
    });

    test('currentLanes.elementCount matches validate laneDetails.elementCount for same lane', async () => {
      const diagramId = await createDiagram();
      const poolRes = parseResult(
        await handleCreateParticipant({ diagramId, name: 'Process', height: 400 })
      );
      const participantId = poolRes.participantId as string;
      const lanesRes = parseResult(
        await handleCreateLanes({
          diagramId,
          participantId,
          lanes: [{ name: 'Customer' }, { name: 'System' }],
        })
      );
      const customerLane = lanesRes.laneIds[0] as string;
      const systemLane = lanesRes.laneIds[1] as string;

      const start = await addElement(diagramId, 'bpmn:StartEvent', {
        name: 'Start',
        laneId: customerLane,
      });
      const task = await addElement(diagramId, 'bpmn:UserTask', {
        name: 'Order',
        laneId: customerLane,
      });
      const svc = await addElement(diagramId, 'bpmn:ServiceTask', {
        name: 'Process',
        laneId: systemLane,
      });
      const end = await addElement(diagramId, 'bpmn:EndEvent', {
        name: 'End',
        laneId: customerLane,
      });
      await handleConnect({ diagramId, sourceElementId: start, targetElementId: task });
      await handleConnect({ diagramId, sourceElementId: task, targetElementId: svc });
      await handleConnect({ diagramId, sourceElementId: svc, targetElementId: end });

      // Add boundary event on svc
      await handleAddElement({
        diagramId,
        elementType: 'bpmn:BoundaryEvent',
        hostElementId: svc,
        name: 'Error',
        eventDefinitionType: 'bpmn:ErrorEventDefinition',
        errorRef: { id: 'Error_Svc3', name: 'Service Error' },
      });

      const suggestRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'suggest', participantId })
      );
      const validateRes = parseResult(
        await handleAnalyzeLanes({ diagramId, mode: 'validate', participantId })
      );

      // H4: currentLanes[System].elementCount must match validate laneDetails[System].elementCount
      const suggestSystem = (suggestRes.currentLanes as any[]).find(
        (d: any) => d.name === 'System'
      );
      const validateSystem = (validateRes.laneDetails as any[]).find(
        (d: any) => d.laneName === 'System'
      );

      expect(suggestSystem?.elementCount).toBe(validateSystem?.elementCount);
    });
  });
});
