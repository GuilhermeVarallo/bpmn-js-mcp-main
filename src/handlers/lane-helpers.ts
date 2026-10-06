/**
 * Shared lane manipulation helpers.
 *
 * Extracted from multiple collaboration handlers that duplicated these
 * patterns (auto-distribute, assign-elements-to-lane, etc.).
 */

import type { BpmnElement, ElementRegistry } from '../bpmn-types';

/**
 * Remove an element's business object from all lanes' flowNodeRef lists.
 *
 * Uses ID-based comparison instead of reference equality to avoid
 * duplicate lane membership when moddle proxies differ from the
 * objects stored by bpmn-js's internal lane handlers.
 */
export function removeFromAllLanes(elementRegistry: ElementRegistry, elementBo: any): void {
  const elementId = elementBo?.id ?? elementBo;
  const allLanes = (elementRegistry as any).filter((el: BpmnElement) => el.type === 'bpmn:Lane');
  for (const lane of allLanes) {
    const refs = lane.businessObject?.flowNodeRef;
    if (Array.isArray(refs)) {
      for (let i = refs.length - 1; i >= 0; i--) {
        if (refs[i] === elementBo || refs[i]?.id === elementId) {
          refs.splice(i, 1);
        }
      }
    }
  }
}

/**
 * Add an element's business object to a lane's flowNodeRef list.
 *
 * Idempotent: does nothing if the element is already in the lane.
 * Uses ID-based comparison for the idempotency check to avoid
 * duplicates from reference-inequality with moddle proxies.
 */
export function addToLane(lane: BpmnElement, elementBo: any): void {
  const laneBo = lane.businessObject;
  if (!laneBo) return;
  const refs: any[] = (laneBo.flowNodeRef as any[] | undefined) || [];
  if (!laneBo.flowNodeRef) laneBo.flowNodeRef = refs;
  const elementId = elementBo?.id;
  if (!refs.some((r) => r === elementBo || r?.id === elementId)) refs.push(elementBo);
}

/**
 * Get all elements assigned to a specific lane (via flowNodeRef).
 */
export function getLaneElements(lane: BpmnElement): any[] {
  const refs = lane.businessObject?.flowNodeRef;
  return Array.isArray(refs) ? refs : [];
}

/**
 * Get sibling lanes of a given lane (other lanes in the same participant).
 */
export function getSiblingLanes(
  elementRegistry: ElementRegistry,
  lane: BpmnElement
): BpmnElement[] {
  const parentId = lane.parent?.id;
  if (!parentId) return [];
  return (elementRegistry as any).filter(
    (el: BpmnElement) => el.type === 'bpmn:Lane' && el.parent?.id === parentId && el.id !== lane.id
  );
}
