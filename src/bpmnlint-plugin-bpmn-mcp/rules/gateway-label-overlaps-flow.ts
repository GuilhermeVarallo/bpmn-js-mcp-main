/**
 * Custom bpmnlint rule: gateway-label-overlaps-flow
 *
 * Warns when a named gateway's external label bounding box intersects
 * a sequence flow waypoint segment.  This typically indicates that the
 * gateway label was placed on the wrong side of the diamond — the side
 * from which one of its edges exits — making the diagram harder to read.
 *
 * Suggested fix: run `layout_bpmn_diagram` with `labelsOnly: true` to
 * reposition gateway labels onto the flow-free side.
 *
 * Note: the rule only reports when DI (diagram interchange) label bounds
 * are present; diagrams without DI are skipped.
 */

import { isType } from '../utils';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Pixel margin added around the label bounds to catch near-touches. */
const LABEL_EXPAND_PX = 2;

/** Pixel width added around waypoint segments to model "line thickness". */
const SEGMENT_HALF_THICKNESS = 3;

/* ------------------------------------------------------------------ */
/*  Gateway type predicate                                             */
/* ------------------------------------------------------------------ */

const GATEWAY_TYPES = new Set([
  'bpmn:ExclusiveGateway',
  'bpmn:ParallelGateway',
  'bpmn:InclusiveGateway',
  'bpmn:EventBasedGateway',
]);

function isGateway(bpmnType: string): boolean {
  return GATEWAY_TYPES.has(bpmnType);
}

/* ------------------------------------------------------------------ */
/*  Geometry helpers                                                   */
/* ------------------------------------------------------------------ */

/**
 * Return whether an axis-aligned box (expanded by `expand`) intersects
 * the axis-aligned bounding box of the segment [a, b] (expanded by
 * `segThick`).
 */
function labelIntersectsSegment(
  label: Bounds,
  a: Point,
  b: Point,
  expand: number,
  segThick: number
): boolean {
  const lx1 = label.x - expand;
  const ly1 = label.y - expand;
  const lx2 = label.x + label.width + expand;
  const ly2 = label.y + label.height + expand;

  const sx1 = Math.min(a.x, b.x) - segThick;
  const sy1 = Math.min(a.y, b.y) - segThick;
  const sx2 = Math.max(a.x, b.x) + segThick;
  const sy2 = Math.max(a.y, b.y) + segThick;

  return lx1 < sx2 && lx2 > sx1 && ly1 < sy2 && ly2 > sy1;
}

/* ------------------------------------------------------------------ */
/*  Rule implementation                                                */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Collector helpers                                                  */
/* ------------------------------------------------------------------ */

/** Build a map of gateway-id → label Bounds for named gateways. */
function collectGatewayLabelBounds(planeElements: any[]): Map<string, Bounds> {
  // First pass: collect named gateway IDs
  const namedGatewayIds = new Set<string>();
  for (const el of planeElements) {
    if (!isType(el, 'bpmndi:BPMNShape')) continue;
    if (!el.bpmnElement) continue;
    const bpmnType: string = el.bpmnElement.$type || '';
    if (!isGateway(bpmnType)) continue;
    if (!el.bpmnElement.name?.trim()) continue;
    namedGatewayIds.add(el.bpmnElement.id);
  }

  // Second pass: find corresponding label shapes (isLabel=true)
  const result = new Map<string, Bounds>();
  for (const el of planeElements) {
    if (!isType(el, 'bpmndi:BPMNShape')) continue;
    if (!el.isLabel || !el.bpmnElement || !el.bounds) continue;
    const id: string = el.bpmnElement.id;
    if (!namedGatewayIds.has(id)) continue;
    result.set(id, {
      x: el.bounds.x,
      y: el.bounds.y,
      width: el.bounds.width || 36,
      height: el.bounds.height || 14,
    });
  }
  return result;
}

/** Collect all sequence flow edges as id/waypoints/bpmnElement triples. */
function collectSequenceFlowEdges(planeElements: any[]): Array<{
  id: string;
  waypoints: Point[];
  bpmnElement: any;
}> {
  const edges = [];
  for (const el of planeElements) {
    if (!isType(el, 'bpmndi:BPMNEdge')) continue;
    if (!el.bpmnElement) continue;
    if (el.bpmnElement.$type !== 'bpmn:SequenceFlow') continue;
    const wps = el.waypoint;
    if (!wps || wps.length < 2) continue;
    edges.push({
      id: el.bpmnElement.id,
      waypoints: wps.map((wp: any) => ({ x: wp.x, y: wp.y })) as Point[],
      bpmnElement: el.bpmnElement,
    });
  }
  return edges;
}

/** Return the first sequence flow ID whose segments overlap the label bounds. */
function findOverlappingFlowId(
  labelBounds: Bounds,
  edges: Array<{ id: string; waypoints: Point[]; bpmnElement: any }>
): string | undefined {
  for (const edge of edges) {
    const wps = edge.waypoints;
    for (let i = 0; i < wps.length - 1; i++) {
      if (
        labelIntersectsSegment(
          labelBounds,
          wps[i],
          wps[i + 1],
          LABEL_EXPAND_PX,
          SEGMENT_HALF_THICKNESS
        )
      ) {
        return edge.bpmnElement.id;
      }
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/*  Rule entry point                                                   */
/* ------------------------------------------------------------------ */

export default function gatewayLabelOverlapsFlow() {
  function check(node: any, reporter: { report: (id: string, msg: string) => void }) {
    if (!isType(node, 'bpmn:Definitions')) return;

    const diagram = node.diagrams?.[0];
    if (!diagram?.plane?.planeElement) return;
    const planeElements: any[] = diagram.plane.planeElement;

    const gatewayLabelBounds = collectGatewayLabelBounds(planeElements);
    if (gatewayLabelBounds.size === 0) return;

    const edges = collectSequenceFlowEdges(planeElements);

    for (const [gwId, labelBounds] of gatewayLabelBounds) {
      const overlappingFlowId = findOverlappingFlowId(labelBounds, edges);
      if (overlappingFlowId !== undefined) {
        reporter.report(
          gwId,
          `Gateway label overlaps sequence flow "${overlappingFlowId}". ` +
            `Run layout_bpmn_diagram with labelsOnly: true to reposition the label ` +
            `onto the flow-free side of the gateway.`
        );
      }
    }
  }

  return { check };
}
