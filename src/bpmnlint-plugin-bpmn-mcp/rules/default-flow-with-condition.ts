/**
 * Custom bpmnlint rule: default-flow-with-condition
 *
 * Warns when a sequence flow is marked as the gateway's default flow AND
 * also carries a conditionExpression. The condition on a default flow is
 * ignored at runtime by the Camunda 7 / Operaton engine — having one is
 * misleading and signals a modeling error.
 *
 * Applies to ExclusiveGateway and InclusiveGateway.
 */

import { isType } from '../utils';

function ruleFactory() {
  function check(node: any, reporter: any) {
    if (!isType(node, 'bpmn:ExclusiveGateway') && !isType(node, 'bpmn:InclusiveGateway')) {
      return;
    }

    const defaultFlow = node.default;
    if (!defaultFlow) return;

    if (defaultFlow.conditionExpression) {
      reporter.report(
        node.id,
        'Default flow has a condition expression — the condition is ignored at runtime. ' +
          'Remove the condition from the default flow or change it to a non-default flow.'
      );
    }
  }

  return { check };
}

export default ruleFactory;
