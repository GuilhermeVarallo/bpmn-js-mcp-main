/**
 * Custom bpmnlint rule: naming-convention
 *
 * Warns when BPMN elements don't follow naming best practices:
 * - Activities (tasks, subprocesses): verb-object pattern ("Process Order" not "Order Processing")
 * - Events: object-participle or noun-state pattern ("Order Created", "Payment Received")
 * - Gateways: yes/no question ending with "?" ("Order valid?")
 */

import { isType } from '../utils';

/** Common verbs that indicate verb-object naming (good pattern for activities). */
const ACTIVITY_VERBS = new Set([
  'accept',
  'acknowledge',
  'add',
  'adjust',
  'allocate',
  'analyse',
  'analyze',
  'apply',
  'approve',
  'archive',
  'assess',
  'assign',
  'audit',
  'authorize',
  'bill',
  'book',
  'broadcast',
  'calculate',
  'call',
  'cancel',
  'capture',
  'categorize',
  'change',
  'charge',
  'check',
  'claim',
  'clarify',
  'classify',
  'clean',
  'close',
  'collect',
  'communicate',
  'compare',
  'complete',
  'compose',
  'compute',
  'conduct',
  'configure',
  'confirm',
  'connect',
  'consolidate',
  'convert',
  'copy',
  'create',
  'credit',
  'debit',
  'decide',
  'decline',
  'define',
  'delete',
  'deliver',
  'deploy',
  'design',
  'determine',
  'develop',
  'disburse',
  'diagnose',
  'disable',
  'dispatch',
  'distribute',
  'do',
  'download',
  'draft',
  'edit',
  'email',
  'enable',
  'enrich',
  'enroll',
  'enter',
  'escalate',
  'estimate',
  'evaluate',
  'examine',
  'execute',
  'export',
  'extract',
  'fetch',
  'file',
  'fill',
  'filter',
  'find',
  'fix',
  'forward',
  'fulfill',
  'generate',
  'get',
  'grant',
  'handle',
  'identify',
  'implement',
  'import',
  'inform',
  'initiate',
  'input',
  'insert',
  'inspect',
  'install',
  'investigate',
  'invoke',
  'issue',
  'load',
  'log',
  'maintain',
  'make',
  'manage',
  'map',
  'match',
  'measure',
  'merge',
  'migrate',
  'modify',
  'monitor',
  'move',
  'negotiate',
  'normalize',
  'notify',
  'obtain',
  'onboard',
  'open',
  'order',
  'output',
  'pack',
  'parse',
  'pay',
  'perform',
  'place',
  'plan',
  'post',
  'prepare',
  'print',
  'prioritize',
  'process',
  'produce',
  'promote',
  'provide',
  'publish',
  'purchase',
  'put',
  'qualify',
  'query',
  'read',
  'reassign',
  'receive',
  'reconcile',
  'record',
  'refund',
  'register',
  'reject',
  'release',
  'remove',
  'render',
  'repair',
  'replace',
  'report',
  'request',
  'resolve',
  'respond',
  'restart',
  'retrieve',
  'return',
  'review',
  'revise',
  'revoke',
  'route',
  'run',
  'save',
  'scan',
  'schedule',
  'screen',
  'search',
  'select',
  'send',
  'set',
  'setup',
  'ship',
  'sign',
  'sort',
  'specify',
  'start',
  'stop',
  'store',
  'submit',
  'summarize',
  'suspend',
  'sync',
  'synchronize',
  'take',
  'terminate',
  'test',
  'track',
  'transfer',
  'transform',
  'translate',
  'triage',
  'trigger',
  'unblock',
  'update',
  'upgrade',
  'upload',
  'validate',
  'verify',
  'wait',
  'withdraw',
  'write',
]);

/**
 * Detect labels that look like technical/code identifiers rather than
 * human-readable business names.
 *
 * Catches: camelCase (`processOrder`), PascalCase with mixed case
 * (`ProcessOrder`), snake_case (`process_order`), and auto-generated
 * IDs (`ServiceTask_0x1f`, `Activity_0m4w27p`).
 */
function isTechnicalName(name: string): boolean {
  // Auto-generated ID pattern: TypePrefix_hexOrAlnum (e.g. ServiceTask_0x1f, Activity_0m4w27p)
  if (/^[A-Z][a-zA-Z]*_[0-9a-z]{4,}$/.test(name)) return true;

  // snake_case: two or more lowercase words joined by underscores
  if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(name)) return true;

  // camelCase: starts lowercase, has uppercase letter(s), no spaces
  if (/^[a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*$/.test(name) && !name.includes(' ')) return true;

  // PascalCase with no spaces: starts uppercase, has at least one more uppercase letter
  // after a lowercase letter (e.g. ProcessOrder), but not all-caps or single words
  if (/^[A-Z][a-z]+[A-Z][a-zA-Z0-9]*$/.test(name) && !name.includes(' ')) {
    return true;
  }

  return false;
}

function ruleFactory() {
  function check(node: any, reporter: any) {
    // Skip extension elements (e.g. camunda:InputParameter, camunda:OutputParameter)
    // which have `name` attributes but are not BPMN model elements with labels
    if (node.$type && node.$type.startsWith('camunda:')) return;
    if (!node.id) return;

    const name = node.name;
    if (!name || !name.trim()) return; // No name — label-required handles that

    const trimmed = name.trim();
    const firstWord = trimmed.split(/\s+/)[0]?.toLowerCase();

    // Check for technical/code-style names on any named element
    if (
      isTechnicalName(trimmed) &&
      !isType(node, 'bpmn:SequenceFlow') // flows often have short labels like "Yes"/"No"
    ) {
      reporter.report(
        node.id,
        `Label "${trimmed}" looks like a technical identifier — ` +
          `use human-readable business language (e.g. "Process Order" instead of "processOrder")`
      );
      return; // Don't double-report naming issues
    }

    // Check activities: should start with a verb
    if (
      isType(node, 'bpmn:Task') ||
      isType(node, 'bpmn:SubProcess') ||
      isType(node, 'bpmn:CallActivity')
    ) {
      if (firstWord && !ACTIVITY_VERBS.has(firstWord)) {
        reporter.report(
          node.id,
          `Activity name should use verb-object pattern (e.g. "Process Order"), ` +
            `but starts with "${firstWord}"`
        );
      }
    }

    // Check gateways: should end with "?"
    // Skip merge gateways (multiple incoming, ≤1 outgoing) — they don't need question labels
    if (isType(node, 'bpmn:ExclusiveGateway') || isType(node, 'bpmn:InclusiveGateway')) {
      const incoming = node.incoming || [];
      const outgoing = node.outgoing || [];
      const isMergeGateway = incoming.length > 1 && outgoing.length <= 1;
      if (!isMergeGateway && !trimmed.endsWith('?')) {
        reporter.report(
          node.id,
          `Gateway label should be a yes/no question ending with "?" (e.g. "Order valid?")`
        );
      }
    }
  }

  return { check };
}

export default ruleFactory;
