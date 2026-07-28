import type {
  IaCParser,
  InfraAccessMode,
  InfraEnvRef,
  InfraKind,
  SemanticInfraDelta,
  InfraResource,
  InfraResourceKind,
  InfraTrigger,
} from '@repovine/plugin-sdk';
import { hashResourcePayload } from '../../stage1/iac/utils.js';
import { compareCodeUnits } from '../../platform/ordering.js';

const samResourceKindMap: Record<string, InfraResourceKind> = {
  'AWS::Serverless::Function': 'lambda',
  'AWS::Lambda::Function': 'lambda',
  'AWS::SQS::Queue': 'queue',
  'AWS::SNS::Topic': 'topic',
  'AWS::DynamoDB::Table': 'table',
  'AWS::ApiGateway::RestApi': 'api',
  'AWS::ApiGatewayV2::Api': 'api',
  'AWS::S3::Bucket': 'bucket',
  'AWS::IAM::Role': 'role',
  'AWS::SecretsManager::Secret': 'secret',
};

/** SSM parameters are only secrets when SecureString; plain String/StringList params are not. */
function resolveResourceKind(type: string, props: Record<string, unknown>): InfraResourceKind {
  if (type === 'AWS::SSM::Parameter') {
    return props.Type === 'SecureString' ? 'secret' : 'other';
  }
  return samResourceKindMap[type] ?? 'other';
}

interface SamParameterInfo {
  type?: string;
  defaultValue?: unknown;
  allowedPattern?: unknown;
}

const SECRET_PARAM_NAME_RE = /(?:Secret|Secrets)(?:Arn|Name)?$/;
const SECRETS_MANAGER_SIGNAL_RE = /(?:^|[:/])secretsmanager(?:[:/]|$)|arn:[^:\s]+:secretsmanager:/i;

function collectParameterInfos(parameters: unknown): Map<string, SamParameterInfo> {
  const out = new Map<string, SamParameterInfo>();
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return out;
  for (const [name, value] of Object.entries(parameters as Record<string, unknown>)) {
    const raw = value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    out.set(name, {
      type: typeof raw.Type === 'string' ? raw.Type : undefined,
      defaultValue: raw.Default,
      allowedPattern: raw.AllowedPattern,
    });
  }
  return out;
}

function collectStringLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStringLeaves(entry, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) collectStringLeaves(entry, out);
  }
  return out;
}

function valueHasSecretManagerSignal(value: unknown): boolean {
  return collectStringLeaves(value).some(text => SECRETS_MANAGER_SIGNAL_RE.test(text));
}

function parameterLooksLikeSecret(name: string, info: SamParameterInfo | undefined): boolean {
  if (SECRET_PARAM_NAME_RE.test(name)) return true;
  if (info?.type && /SecureString/i.test(info.type)) return true;
  return valueHasSecretManagerSignal(info?.defaultValue) || valueHasSecretManagerSignal(info?.allowedPattern);
}

function stableSecretKey(raw: string): string {
  const noSubBraces = raw.trim().replace(/^\$\{([^}]+)\}$/, '$1');
  const secretArnMarker = ':secret:';
  const arnIdx = noSubBraces.indexOf(secretArnMarker);
  const source = arnIdx >= 0 ? noSubBraces.slice(arnIdx + secretArnMarker.length) : noSubBraces;
  const normalized = source
    .replace(/\$\{([^}]+)\}/g, '$1')
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'external';
}

function ensureSyntheticSecretResource(
  syntheticResources: Map<string, InfraResource>,
  stableKey: string,
  source: string,
  extraAttributes: Record<string, string> = {},
): string {
  const id = `secret:${stableSecretKey(stableKey)}`;
  if (!syntheticResources.has(id)) {
    const attributes = { external: 'true', source, ...extraAttributes };
    syntheticResources.set(id, {
      id,
      kind: 'secret',
      provider: 'aws',
      contentHash: hashResourcePayload({ id, kind: 'secret', provider: 'aws', attributes }),
      attributes,
    });
  }
  return id;
}

function synthesizeSecretForParameter(
  parameterName: string,
  parameters: Map<string, SamParameterInfo>,
  syntheticResources: Map<string, InfraResource>,
): string | undefined {
  const info = parameters.get(parameterName);
  if (!info || !parameterLooksLikeSecret(parameterName, info)) return undefined;
  return ensureSyntheticSecretResource(syntheticResources, parameterName, 'param', {
    parameterName,
    ...(info.type ? { parameterType: info.type } : {}),
  });
}

function parameterNameFromSubSource(source: string): string | undefined {
  const exact = source.trim().match(/^\$\{([^}]+)\}$/);
  if (!exact) return undefined;
  return exact[1];
}

function splitDynamicSecretReference(body: string): { service: string; source: string } | undefined {
  const firstColon = body.indexOf(':');
  if (firstColon < 0) return undefined;
  const service = body.slice(0, firstColon).trim();
  const rest = body.slice(firstColon + 1).trim();
  if (!service || !rest) return undefined;
  if (service === 'secretsmanager') {
    const secretStringIdx = rest.indexOf(':SecretString');
    return { service, source: secretStringIdx >= 0 ? rest.slice(0, secretStringIdx) : rest };
  }
  if (service === 'ssm-secure') {
    const versionIdx = rest.indexOf(':');
    return { service, source: versionIdx >= 0 ? rest.slice(0, versionIdx) : rest };
  }
  return undefined;
}

function extractDynamicSecretSource(text: string): { service: string; source: string } | undefined {
  const start = text.indexOf('{{resolve:');
  if (start < 0) return undefined;
  const end = text.indexOf('}}', start);
  if (end < 0) return undefined;
  const body = text.slice(start + '{{resolve:'.length, end);
  return splitDynamicSecretReference(body);
}

function extractDynamicSecretRef(
  value: unknown,
  parameters: Map<string, SamParameterInfo>,
  syntheticResources: Map<string, InfraResource>,
): Omit<InfraEnvRef, 'varName'> | null {
  const flattened = collectStringLeaves(value).join('');
  if (!flattened.includes('{{resolve:')) return null;
  const dynamic = extractDynamicSecretSource(flattened);
  if (!dynamic) return null;
  const paramName = parameterNameFromSubSource(dynamic.source)
    ?? (parameters.has(dynamic.source) ? dynamic.source : undefined);
  const targetLogicalId = paramName
    ? synthesizeSecretForParameter(paramName, parameters, syntheticResources)
      ?? ensureSyntheticSecretResource(syntheticResources, paramName, 'param', { parameterName: paramName })
    : ensureSyntheticSecretResource(syntheticResources, dynamic.source, dynamic.service);
  return { refType: 'sub', targetLogicalId };
}

function findSecretParameterReference(
  value: unknown,
  parameters: Map<string, SamParameterInfo>,
): string | undefined {
  if (typeof value === 'string') {
    if (parameterLooksLikeSecret(value, parameters.get(value))) return value;
    const subRefRe = /\$\{([^}]+)\}/g;
    let match: RegExpExecArray | null;
    while ((match = subRefRe.exec(value)) !== null) {
      const name = match[1].split('.')[0];
      if (parameterLooksLikeSecret(name, parameters.get(name))) return name;
    }
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findSecretParameterReference(entry, parameters);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const directRef = obj.Ref ?? obj['Fn::Ref'];
  if (typeof directRef === 'string' && parameterLooksLikeSecret(directRef, parameters.get(directRef))) {
    return directRef;
  }
  for (const entry of Object.values(obj)) {
    const found = findSecretParameterReference(entry, parameters);
    if (found) return found;
  }
  return undefined;
}

function extractSecretRef(
  value: unknown,
  parameters: Map<string, SamParameterInfo>,
  syntheticResources: Map<string, InfraResource>,
): Omit<InfraEnvRef, 'varName'> | null {
  const dynamic = extractDynamicSecretRef(value, parameters, syntheticResources);
  if (dynamic) return dynamic;
  const paramName = findSecretParameterReference(value, parameters);
  const targetLogicalId = paramName
    ? synthesizeSecretForParameter(paramName, parameters, syntheticResources)
    : undefined;
  return targetLogicalId ? { refType: 'ref', targetLogicalId } : null;
}

/**
 * Resource types an IAM policy grants access to and this parser models as a runtime resource.
 * Roles, APIs and functions are excluded: a grant names them as the subject, not the target.
 *
 * `AWS::KMS::Key` is absent because `samResourceKindMap` does not model KMS, so `kmsdecryptpolicy`
 * stays unreachable until a KMS key becomes a resource node.
 */
const GRANT_TARGET_RESOURCE_TYPES = new Set([
  'AWS::DynamoDB::Table',
  'AWS::S3::Bucket',
  'AWS::SQS::Queue',
  'AWS::SNS::Topic',
  'AWS::SecretsManager::Secret',
  'AWS::SSM::Parameter',
]);

function logicalIdIsGrantTarget(logicalId: string, allResourceTypes: Map<string, string>): boolean {
  const type = allResourceTypes.get(logicalId);
  return type !== undefined && GRANT_TARGET_RESOURCE_TYPES.has(type);
}

function looksLikeResourceReferenceAlias(logicalId: string): boolean {
  return /(TableName|TableArn|QueueUrl|QueueArn|TopicArn|FunctionName|FunctionArn)$/.test(logicalId);
}

/**
 * Logical ids a scalar can name. `CLOUDFORMATION_SAFE_SCHEMA` collapses CFN short tags to their
 * payload, so `!GetAtt Table.Arn` arrives as `"Table.Arn"` and `!Sub "${Table.Arn}"` as the body.
 */
function logicalIdCandidatesFromString(value: string): string[] {
  const out = [value];
  const dot = value.indexOf('.');
  if (dot > 0) out.push(value.slice(0, dot));
  const subRefRe = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = subRefRe.exec(value)) !== null) out.push(match[1].trim().split('.')[0]);
  return out;
}

function collectGrantTargetsInValue(
  node: unknown,
  allResourceTypes: Map<string, string>,
  out: Set<string>,
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    for (const candidate of logicalIdCandidatesFromString(node)) {
      if (logicalIdIsGrantTarget(candidate, allResourceTypes)) out.add(candidate);
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectGrantTargetsInValue(x, allResourceTypes, out);
    return;
  }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if ('Ref' in o && typeof o.Ref === 'string' && logicalIdIsGrantTarget(o.Ref, allResourceTypes)) {
    out.add(o.Ref);
  }
  if ('Fn::GetAtt' in o) {
    const ga = o['Fn::GetAtt'];
    const first = Array.isArray(ga) && typeof ga[0] === 'string' ? ga[0]
      : typeof ga === 'string' ? ga.split('.')[0] : undefined;
    if (first && logicalIdIsGrantTarget(first, allResourceTypes)) out.add(first);
  }
  for (const v of Object.values(o)) collectGrantTargetsInValue(v, allResourceTypes, out);
}

/**
 * SAM policy templates name their access in the template id. The engine maps the id to a mode so a
 * `DynamoDBReadPolicy` grant is reported as read even though the expanded actions never appear in
 * the template file.
 */
const SAM_POLICY_TEMPLATE_ACCESS: Record<string, InfraAccessMode> = {
  dynamodbreadpolicy: 'read',
  dynamodbstreamreadpolicy: 'read',
  dynamodbwritepolicy: 'write',
  dynamodbcrudpolicy: 'read-write',
  dynamodbrestorepolicy: 'write',
  dynamodbreconfigurepolicy: 'write',
  s3readpolicy: 'read',
  s3writepolicy: 'write',
  s3crudpolicy: 'read-write',
  sqspollerpolicy: 'read',
  sqssendmessagepolicy: 'write',
  snspublishmessagepolicy: 'write',
  kmsdecryptpolicy: 'read',
  ssmparameterreadpolicy: 'read',
  secretsmanagergetsecretvaluepolicy: 'read',
};

/** Action verb prefixes that only observe state. Checked before the write list. */
const READ_ACTION_PREFIXES = [
  'batchget', 'get', 'list', 'describe', 'query', 'scan', 'head', 'read', 'select', 'view',
  'conditioncheck', 'receive', 'peek', 'poll', 'search', 'lookup',
];

/** Action verb prefixes that change state. */
const WRITE_ACTION_PREFIXES = [
  'batchwrite', 'put', 'post', 'update', 'delete', 'create', 'write', 'send', 'publish', 'invoke',
  'set', 'add', 'remove', 'modify', 'tag', 'untag', 'purge', 'import', 'restore', 'upload',
  'abort', 'complete', 'copy', 'start', 'stop', 'enable', 'disable', 'attach', 'detach',
];

/** Read plus write is read-write; an unknown side leaves the known one standing. */
function mergeAccess(a: InfraAccessMode | undefined, b: InfraAccessMode | undefined): InfraAccessMode | undefined {
  if (!a) return b;
  if (!b) return a;
  return a === b ? a : 'read-write';
}

/** Access one IAM action grants: `dynamodb:GetItem` → read, `dynamodb:*` → read-write. */
function accessForIamAction(action: string): InfraAccessMode | undefined {
  const colon = action.indexOf(':');
  const verb = (colon >= 0 ? action.slice(colon + 1) : action).trim().toLowerCase();
  if (verb === '' || verb === '*') return 'read-write';
  const stem = verb.replace(/\*+$/, '');
  if (READ_ACTION_PREFIXES.some(prefix => stem.startsWith(prefix))) return 'read';
  if (WRITE_ACTION_PREFIXES.some(prefix => stem.startsWith(prefix))) return 'write';
  return undefined;
}

function statementList(document: unknown): Record<string, unknown>[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return [];
  const raw = (document as Record<string, unknown>).Statement;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  return list.filter((s): s is Record<string, unknown> => !!s && typeof s === 'object' && !Array.isArray(s));
}

function accessForStatement(statement: Record<string, unknown>): InfraAccessMode | undefined {
  const raw = statement.Action;
  const actions = (Array.isArray(raw) ? raw : [raw]).filter((a): a is string => typeof a === 'string');
  let access: InfraAccessMode | undefined;
  for (const action of actions) access = mergeAccess(access, accessForIamAction(action));
  return access;
}

/**
 * Read a policy document's `Statement` list into per-target grants. `Deny` statements are skipped:
 * they subtract, and a subtraction the engine cannot evaluate must not widen a reported grant.
 * Returns false when the value carries no statement list, so the caller can try other shapes.
 */
function collectGrantsFromPolicyDocument(
  document: unknown,
  allResourceTypes: Map<string, string>,
  out: Map<string, InfraAccessMode | undefined>,
): boolean {
  const statements = statementList(document);
  if (statements.length === 0) return false;
  for (const statement of statements) {
    if (typeof statement.Effect === 'string' && statement.Effect.toLowerCase() === 'deny') continue;
    const access = accessForStatement(statement);
    const targets = new Set<string>();
    collectGrantTargetsInValue(statement.Resource, allResourceTypes, targets);
    // A statement may name its target through Condition keys or Fn::Sub bodies rather than
    // Resource; widen to the whole statement only when Resource itself named nothing.
    if (targets.size === 0) collectGrantTargetsInValue(statement, allResourceTypes, targets);
    for (const target of targets) out.set(target, mergeAccess(out.get(target), access));
  }
  return true;
}

/**
 * Logical id a `Policies` entry names. Both the object form `{ Ref: X }` and the bare scalar that
 * `!Ref X` collapses to reach here; a scalar naming something other than a managed policy simply
 * finds no document.
 */
function managedPolicyReference(policy: unknown): string | undefined {
  if (typeof policy === 'string') return policy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return undefined;
  const ref = (policy as Record<string, unknown>).Ref;
  return typeof ref === 'string' ? ref : undefined;
}

/** Access declared by a SAM policy-template entry, keyed by the template id it uses. */
function samPolicyTemplateAccess(policy: unknown): InfraAccessMode | undefined {
  if (typeof policy === 'string') return SAM_POLICY_TEMPLATE_ACCESS[policy.toLowerCase()];
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return undefined;
  let access: InfraAccessMode | undefined;
  for (const key of Object.keys(policy as Record<string, unknown>)) {
    access = mergeAccess(access, SAM_POLICY_TEMPLATE_ACCESS[key.toLowerCase()]);
  }
  return access;
}

/**
 * Grants a Lambda's `Policies` list hands to `GRANT_TARGET_RESOURCE_TYPES` resources, as
 * target → access. A target with an `undefined` value was granted by a shape whose verb the engine
 * could not read; the key is still present, so the binding is reported with the access left unread.
 */
function collectPolicyGrants(
  policies: unknown,
  managedPolicyDocuments: Map<string, unknown>,
  allResourceTypes: Map<string, string>,
): Map<string, InfraAccessMode | undefined> {
  const out = new Map<string, InfraAccessMode | undefined>();
  if (!Array.isArray(policies)) return out;

  for (const policy of policies) {
    // Inline policy document: statements carry both the target and the verb.
    if (collectGrantsFromPolicyDocument(policy, allResourceTypes, out)) continue;

    // `!Ref SomeManagedPolicy`: the statements live on the referenced resource.
    const managedPolicyId = managedPolicyReference(policy);
    if (managedPolicyId !== undefined
      && collectGrantsFromPolicyDocument(managedPolicyDocuments.get(managedPolicyId), allResourceTypes, out)) {
      continue;
    }

    // SAM policy template (`{ DynamoDBCrudPolicy: { TableName: !Ref Table } }`) or an
    // unrecognized shape: the target still resolves, the verb only when the template is known.
    const templateAccess = samPolicyTemplateAccess(policy);
    const targets = new Set<string>();
    collectGrantTargetsInValue(policy, allResourceTypes, targets);
    for (const target of targets) out.set(target, mergeAccess(out.get(target), templateAccess));
  }
  return out;
}

/**
 * Stamp parsed grants onto the env refs that already name the target, then add one ref per
 * grant-only target. A target named by both an env var and a policy keeps its single ref and gains
 * the access — the grant is the same fact whichever way the template surfaced the id.
 */
function applyPolicyGrantsToEnvRefs(
  grants: Map<string, InfraAccessMode | undefined>,
  envRefs: InfraEnvRef[],
): void {
  const alreadyReferenced = new Set<string>();
  for (const ref of envRefs) {
    if (!ref.targetLogicalId || !grants.has(ref.targetLogicalId)) continue;
    alreadyReferenced.add(ref.targetLogicalId);
    const access = grants.get(ref.targetLogicalId);
    if (access) ref.access = access;
  }
  for (const [targetLogicalId, access] of grants) {
    if (alreadyReferenced.has(targetLogicalId)) continue;
    envRefs.push({
      varName: `iamPolicy:${targetLogicalId}`,
      refType: 'ref',
      targetLogicalId,
      ...(access ? { access } : {}),
    });
  }
}

function extractRef(
  value: unknown,
  allResourceTypes: Map<string, string>,
): Omit<InfraEnvRef, 'varName'> | null {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const ref = extractRef(entry, allResourceTypes);
      if (ref) return ref;
    }
    return null;
  }
  if (typeof value === 'string') {
    if (allResourceTypes.has(value) || looksLikeResourceReferenceAlias(value)) {
      return { refType: 'ref', targetLogicalId: value };
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  if ('Ref' in obj && typeof obj.Ref === 'string') {
    const ref = obj.Ref;
    if (allResourceTypes.has(ref) || looksLikeResourceReferenceAlias(ref)) return { refType: 'ref', targetLogicalId: ref };
    return null;
  }

  if ('Fn::GetAtt' in obj) {
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
      return allResourceTypes.has(getAtt[0]) ? { refType: 'getatt', targetLogicalId: getAtt[0] } : null;
    }
    if (typeof getAtt === 'string') {
      const [logId] = getAtt.split('.');
      return allResourceTypes.has(logId) ? { refType: 'getatt', targetLogicalId: logId } : null;
    }
  }

  if ('Fn::Sub' in obj) {
    return { refType: 'sub' };
  }

  return null;
}

function logicalIdFromRefValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if ('Ref' in obj && typeof obj.Ref === 'string') return obj.Ref;
  if ('Fn::Ref' in obj && typeof obj['Fn::Ref'] === 'string') return obj['Fn::Ref'] as string;
  if ('Fn::GetAtt' in obj) {
    const ga = obj['Fn::GetAtt'];
    if (Array.isArray(ga) && typeof ga[0] === 'string') return ga[0];
    if (typeof ga === 'string') return ga.split('.')[0];
  }
  return undefined;
}

const CFN_PSEUDO_PARAMS = new Set([
  'AWS::Region', 'AWS::AccountId', 'AWS::Partition', 'AWS::StackName',
  'AWS::StackId', 'AWS::URLSuffix', 'AWS::NoValue', 'AWS::NotificationARNs',
]);
function logicalIdFromSubString(template: string, allResourceTypes: Map<string, string>): string | undefined {
  const re = /\$\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) {
    const inner = m[1].trim();
    if (CFN_PSEUDO_PARAMS.has(inner)) continue;
    const logicalId = inner.split('.')[0];
    if (allResourceTypes.has(logicalId)) return logicalId;
  }
  return undefined;
}

function logicalIdFromAnyExpression(value: unknown, allResourceTypes: Map<string, string>): string | undefined {
  const direct = logicalIdFromRefValue(value);
  if (direct && allResourceTypes.has(direct)) return direct;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sub = obj['Fn::Sub'] ?? (obj as { '!Sub'?: unknown })['!Sub'];
    if (typeof sub === 'string') return logicalIdFromSubString(sub, allResourceTypes);
    if (Array.isArray(sub) && typeof sub[0] === 'string') {
      return logicalIdFromSubString(sub[0], allResourceTypes);
    }
  }
  if (typeof value === 'string') {
    const dotIdx = value.indexOf('.');
    if (dotIdx > 0) {
      const head = value.slice(0, dotIdx);
      if (allResourceTypes.has(head)) return head;
    }
    if (value.includes('${')) return logicalIdFromSubString(value, allResourceTypes);
    if (allResourceTypes.has(value)) return value;
  }
  return undefined;
}

function collectStandaloneTriggers(
  resources: Record<string, Record<string, unknown>>,
  allResourceTypes: Map<string, string>,
): Map<string, InfraTrigger[]> {
  const out = new Map<string, InfraTrigger[]>();
  const push = (lambdaId: string, trigger: InfraTrigger): void => {
    const list = out.get(lambdaId) ?? [];
    list.push(trigger);
    out.set(lambdaId, list);
  };

  const integrationToLambda = new Map<string, { lambdaId: string; apiId: string | undefined }>();
  for (const [logicalId, res] of Object.entries(resources)) {
    if ((res?.Type as string) !== 'AWS::ApiGatewayV2::Integration') continue;
    const props = (res?.Properties ?? {}) as Record<string, unknown>;
    const lambdaId = logicalIdFromAnyExpression(props.IntegrationUri, allResourceTypes);
    if (!lambdaId) continue;
    const lambdaType = allResourceTypes.get(lambdaId);
    if (lambdaType !== 'AWS::Serverless::Function' && lambdaType !== 'AWS::Lambda::Function') continue;
    const apiId = logicalIdFromRefValue(props.ApiId);
    integrationToLambda.set(logicalId, { lambdaId, apiId });
  }

  for (const [logicalId, res] of Object.entries(resources)) {
    const type = (res?.Type as string) ?? '';
    const props = (res?.Properties ?? {}) as Record<string, unknown>;

    if (type === 'AWS::Events::Rule') {
      const targets = Array.isArray(props.Targets) ? props.Targets : [];
      const schedule = typeof props.ScheduleExpression === 'string' ? props.ScheduleExpression : undefined;
      const hasPattern = props.EventPattern != null;
      for (const t of targets) {
        if (!t || typeof t !== 'object') continue;
        const target = t as Record<string, unknown>;
        const targetLambda = logicalIdFromAnyExpression(target.Arn, allResourceTypes);
        if (!targetLambda) continue;
        const lambdaType = allResourceTypes.get(targetLambda);
        if (lambdaType !== 'AWS::Serverless::Function' && lambdaType !== 'AWS::Lambda::Function') continue;
        const name = (typeof target.Id === 'string' ? target.Id : undefined) ?? logicalId;
        if (schedule) {
          push(targetLambda, { name, type: 'schedule', schedule, queueRef: logicalId });
        } else if (hasPattern) {
          push(targetLambda, { name, type: 'event-bus', queueRef: logicalId });
        }
      }
      continue;
    }

    if (type === 'AWS::Lambda::EventSourceMapping') {
      const targetLambda = logicalIdFromAnyExpression(props.FunctionName, allResourceTypes);
      if (!targetLambda) continue;
      const lambdaType = allResourceTypes.get(targetLambda);
      if (lambdaType !== 'AWS::Serverless::Function' && lambdaType !== 'AWS::Lambda::Function') continue;
      const sourceId = logicalIdFromAnyExpression(props.EventSourceArn, allResourceTypes);
      const sourceType = sourceId ? allResourceTypes.get(sourceId) : undefined;
      let triggerType: InfraTrigger['type'] = 'sqs';
      if (sourceType === 'AWS::DynamoDB::Table') triggerType = 'dynamodb-stream';
      else if (sourceType === 'AWS::Kinesis::Stream') triggerType = 'kinesis-stream';
      else if (sourceType === 'AWS::SQS::Queue') triggerType = 'sqs';
      else if (!sourceType) continue;
      push(targetLambda, { name: logicalId, type: triggerType, queueRef: sourceId });
      continue;
    }

    if (type === 'AWS::ApiGatewayV2::Route') {
      const routeKey = typeof props.RouteKey === 'string' ? props.RouteKey : undefined;
      const target = props.Target;
      let integrationRaw: unknown = target;
      if (typeof target === 'string' && target.startsWith('integrations/')) {
        integrationRaw = target.slice('integrations/'.length);
      }
      let integrationId: string | undefined;
      if (typeof integrationRaw === 'string' && !integrationRaw.includes('${') && allResourceTypes.has(integrationRaw)) {
        integrationId = integrationRaw;
      } else {
        integrationId = logicalIdFromAnyExpression(integrationRaw, allResourceTypes);
      }
      if (!integrationId) continue;
      const integration = integrationToLambda.get(integrationId);
      if (!integration) continue;
      const restMatch = routeKey?.match(/^([A-Z]+)\s+(\/\S*)$/);
      if (restMatch) {
        push(integration.lambdaId, {
          name: logicalId,
          type: 'api',
          method: restMatch[1],
          path: restMatch[2],
          queueRef: integration.apiId,
        });
      } else {
        push(integration.lambdaId, {
          name: logicalId,
          type: 'websocket',
          path: routeKey,
          queueRef: integration.apiId,
        });
      }
      continue;
    }
  }

  return out;
}

function parseSamEvent(
  name: string,
  type: string,
  props: Record<string, unknown>,
  allResourceTypes: Map<string, string>,
): InfraTrigger | null {
  const typeLower = type.toLowerCase();
  if (typeLower === 'api') {
    return {
      name,
      type: 'api',
      method: props.Method ? String(props.Method) : undefined,
      path: props.Path ? String(props.Path) : undefined,
    };
  }
  if (typeLower === 'sqs') {
    let queueRef: string | undefined;
    const queue = props.Queue;
    if (queue && typeof queue === 'object') {
      const qObj = queue as Record<string, unknown>;
      if ('Fn::GetAtt' in qObj) {
        const getAtt = qObj['Fn::GetAtt'];
        if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') queueRef = getAtt[0];
        else if (typeof getAtt === 'string') queueRef = getAtt.split('.')[0];
      }
    }
    if (!queueRef && typeof queue === 'string' && (allResourceTypes.has(queue) || looksLikeResourceReferenceAlias(queue))) {
      queueRef = queue;
    }
    return { name, type: 'sqs', queueRef };
  }
  if (typeLower === 'schedule') {
    return {
      name,
      type: 'schedule',
      schedule: props.Schedule ? String(props.Schedule) : undefined,
    };
  }
  if (typeLower === 'websocket') {
    return { name, type: 'websocket' };
  }
  return null;
}

export const samParser: IaCParser = {
  kind: 'aws-sam',
  fileMatch: { extensions: ['.yaml', '.yml', '.json'] },
  docFormat: 'yaml',

  supports(_filePath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const root = doc as { Transform?: unknown; Resources?: unknown };
    if (typeof root.Transform === 'string' && root.Transform.startsWith('AWS::Serverless::')) {
      return true;
    }
    if (root.Resources && typeof root.Resources === 'object') {
      return true;
    }
    return false;
  },

  parse(filePath, relPath, doc): SemanticInfraDelta | null {
    if (!doc || typeof doc !== 'object') return null;
    const root = doc as {
      Transform?: unknown;
      Globals?: Record<string, unknown>;
      Parameters?: Record<string, unknown>;
      Resources?: Record<string, Record<string, unknown>>;
    };

    const resources: InfraResource[] = [];
    const syntheticResources = new Map<string, InfraResource>();
    const allResourceTypes = new Map<string, string>();
    const parameters = collectParameterInfos(root.Parameters);

    const globalFunc = root.Globals?.Function as Record<string, unknown> | undefined;
    const globalVariables = (globalFunc?.Environment as Record<string, unknown> | undefined)?.Variables as
      | Record<string, unknown>
      | undefined;

    if (root.Resources && typeof root.Resources === 'object') {
      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = (res?.Type as string) ?? 'other';
        allResourceTypes.set(logicalId, type);
      }

      const managedPolicyDocuments = new Map<string, unknown>();
      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = (res?.Type as string) ?? 'other';
        if (type !== 'AWS::IAM::ManagedPolicy') continue;
        const mpProps = (res?.Properties ?? {}) as Record<string, unknown>;
        managedPolicyDocuments.set(logicalId, mpProps.PolicyDocument);
      }

      const standaloneTriggers = collectStandaloneTriggers(root.Resources, allResourceTypes);

      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = (res?.Type as string) ?? 'other';
        const props = (res?.Properties ?? {}) as Record<string, unknown>;
        const kind: InfraResourceKind = resolveResourceKind(type, props);

        const attributes: Record<string, string> = {};
        if (props.FunctionName) attributes.functionName = String(props.FunctionName);
        if (props.Handler) attributes.handler = String(props.Handler);
        if (typeof props.CodeUri === 'string') attributes.codeUri = props.CodeUri;

        const envVars: string[] = [];
        const envRefs: InfraEnvRef[] = [];
        const funcEnv = (props.Environment as Record<string, unknown> | undefined)
          ?.Variables as Record<string, unknown> | undefined;
        const mergedEnv: Record<string, unknown> | undefined =
          globalVariables && typeof globalVariables === 'object'
            ? { ...globalVariables, ...(funcEnv && typeof funcEnv === 'object' ? funcEnv : {}) }
            : funcEnv && typeof funcEnv === 'object'
              ? funcEnv
              : undefined;
        if (mergedEnv && typeof mergedEnv === 'object') {
          for (const [key, val] of Object.entries(mergedEnv)) {
            envVars.push(key);
            const ref = extractSecretRef(val, parameters, syntheticResources)
              ?? extractRef(val, allResourceTypes);
            if (ref) {
              envRefs.push({ varName: key, ...ref });
            }
          }
        }

        if (kind === 'lambda') {
          applyPolicyGrantsToEnvRefs(
            collectPolicyGrants(props.Policies, managedPolicyDocuments, allResourceTypes),
            envRefs,
          );
        }

        const triggers: InfraTrigger[] = [];
        const events = props.Events as Record<string, Record<string, unknown>> | undefined;
        if (events && typeof events === 'object') {
          for (const [evtName, evt] of Object.entries(events)) {
            const evtType = (evt?.Type as string) ?? '';
            const evtProps = (evt?.Properties ?? {}) as Record<string, unknown>;
            const trigger = parseSamEvent(evtName, evtType, evtProps, allResourceTypes);
            if (trigger) triggers.push(trigger);
          }
        }
        const synthetics = kind === 'lambda' ? standaloneTriggers.get(logicalId) : undefined;
        if (synthetics) triggers.push(...synthetics);

        const resourceContentHash = hashResourcePayload(res);

        resources.push({
          id: logicalId,
          kind,
          provider: 'aws',
          contentHash: resourceContentHash,
          attributes,
          envVars: envVars.length > 0 ? envVars : undefined,
          triggers: triggers.length > 0 ? triggers : undefined,
          envRefs: envRefs.length > 0 ? envRefs : undefined,
        });
      }

      if (syntheticResources.size > 0) {
        resources.push(...[...syntheticResources.values()].sort((a, b) => compareCodeUnits(a.id, b.id)));
      }
    }

    if (resources.length === 0) return null;

    const isSam = typeof root.Transform === 'string' && root.Transform.startsWith('AWS::Serverless::');
    const kind: InfraKind = isSam ? 'aws-sam' : 'cloudformation';

    return { kind, resources };
  },
};
