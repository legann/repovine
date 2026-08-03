import { describe, expect, it } from '@jest/globals';
import {
  AWS_KIND_NAMESPACES,
  GRANT_TARGET_RESOURCE_TYPES,
  SAM_POLICY_TEMPLATE_ACCESS,
  SAM_RESOURCE_KINDS,
} from '../../packages/plugins/iac-sam/src/index.js';

/**
 * Law: the SAM plugin's four tables agree with each other.
 *
 * A SAM template is read through a chain of lookups: a CloudFormation type becomes a resource kind,
 * a kind becomes an identity namespace, an IAM grant names a type it can target, and a policy
 * template name becomes an access mode. Each table is the SAM plugin's own knowledge and closed on
 * purpose. What they cannot be is closed at different places — a type that is a grant target but not
 * a modelled resource produces a binding to a resource that was never emitted, and a policy template
 * that grants access to a service the plugin does not model can never fire.
 *
 * These are not coverage counts. Each case names a pair of tables and the concrete symptom of them
 * disagreeing, so a table that grows without its partner says which reading broke.
 */
describe('core-laws the SAM plugin tables are total against each other', () => {
  /** Services the policy-template names refer to, taken from the name rather than a second list. */
  function serviceOfPolicyTemplate(name: string): string {
    return name.replace(/(read|write|crud|stream|restore|reconfigure|poller|sendmessage|publishmessage|getsecretvalue|parameterread|decrypt).*policy$/, '');
  }

  it('names every grant target type the parser does not turn into a resource', () => {
    // A grant names a logical id; the env-ref that carries it points at a runtime-resource node. A
    // target type absent from the kind map yields a ref stage 2 resolves to nothing, so the grant is
    // read and then goes nowhere. That is survivable and it is not free, so each such type is listed
    // here by name: `AWS::SSM::Parameter` is a grant target because SAM templates grant it, and the
    // parser does not model a Parameter as a resource. Modelling one adds nodes to every template
    // that declares one, which is a decision, not a table edit.
    const unmodelled = [...GRANT_TARGET_RESOURCE_TYPES]
      .filter(type => !(type in SAM_RESOURCE_KINDS))
      .sort();
    expect(unmodelled).toEqual(['AWS::SSM::Parameter']);
  });

  it('every modelled resource kind has an identity namespace decision', () => {
    // Absent from the namespace table is not a gap: those kinds fall back to the account-wide `aws`
    // namespace deliberately. What the law forbids is the reverse — a namespace declared for a kind
    // no CloudFormation type maps to, which is a namespace nothing can ever be minted into.
    const kinds = new Set(Object.values(SAM_RESOURCE_KINDS));
    const unreachable = Object.keys(AWS_KIND_NAMESPACES)
      .filter(kind => !kinds.has(kind))
      .sort();
    expect(unreachable).toEqual([]);
  });

  it('every policy template names a service the parser can grant access to', () => {
    // `kmsdecryptpolicy` is the standing exception and the reason this law exists: KMS keys are not
    // modelled, so the entry can never produce a binding. It is kept because a SAM author writes it
    // and the parser should read the access mode rather than fail; the law records that the entry is
    // inert, so a second such entry has to be a decision rather than an oversight.
    const grantableServices = new Set(
      [...GRANT_TARGET_RESOURCE_TYPES].map(type => type.split('::')[1].toLowerCase()),
    );
    const inert = Object.keys(SAM_POLICY_TEMPLATE_ACCESS)
      .filter(name => ![...grantableServices].some(service => name.startsWith(service)))
      .sort();
    expect(inert).toEqual(['kmsdecryptpolicy']);
  });

  it('every policy template resolves to an access mode the contract defines', () => {
    const modes = new Set(Object.values(SAM_POLICY_TEMPLATE_ACCESS));
    expect([...modes].sort()).toEqual(['read', 'read-write', 'write']);
    // A name that reads as a template but carries no mode would silently report "granted, mode
    // unread" for a grant the plugin does understand.
    const modeless = Object.entries(SAM_POLICY_TEMPLATE_ACCESS)
      .filter(([, mode]) => mode === undefined)
      .map(([name]) => name);
    expect(modeless).toEqual([]);
  });

  it('the tables are non-empty, so a cleared table cannot pass the checks above', () => {
    // Every assertion above is a "no offenders" shape, and an empty table has none. These bounds
    // are the floor that keeps a deleted table from reading as a clean sweep.
    expect(Object.keys(SAM_RESOURCE_KINDS).length).toBeGreaterThanOrEqual(10);
    expect(GRANT_TARGET_RESOURCE_TYPES.size).toBeGreaterThanOrEqual(6);
    expect(Object.keys(SAM_POLICY_TEMPLATE_ACCESS).length).toBeGreaterThanOrEqual(15);
    expect(Object.keys(AWS_KIND_NAMESPACES).length).toBeGreaterThanOrEqual(6);
    // Derived from the names, not restated: a service list written out here would be a fifth table
    // to keep in step with the four under test.
    expect(serviceOfPolicyTemplate('dynamodbcrudpolicy')).toBe('dynamodb');
  });
});
