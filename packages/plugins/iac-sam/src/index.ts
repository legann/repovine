import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { samParser } from './parser.js';

export {
  AWS_KIND_NAMESPACES,
  GRANT_TARGET_RESOURCE_TYPES,
  SAM_POLICY_TEMPLATE_ACCESS,
  SAM_RESOURCE_KINDS,
  samParser,
} from './parser.js';

/**
 * Built-in plugin: AWS SAM / CloudFormation parser.
 *
 * Owns InfraKind: 'aws-sam', 'cloudformation' (both share the same domain).
 * Emits resourceKind: 'lambda', 'queue', 'topic', 'table', 'api', 'bucket', 'role'.
 * Emits triggerType: 'api', 'sqs', 'schedule', 'event-bus', 'dynamodb-stream', 'kinesis-stream', 'websocket'.
 *
 * What those kinds, triggers and AWS SDK calls mean to the host is declared in
 * `package.json#repovine.declarations`, not here: it is data the host reads before this file runs.
 */
// SAM and plain CloudFormation share infra-sam for graph layout.
const samDomain = {
  domainId: 'domain:infra-sam',
  label: 'infra-sam',
  description: 'Domain: infra-sam (IaC SAM/CloudFormation)',
};

export const samIacPlugin = defineIaCPlugin({
  id: 'sam',
  parsers: [samParser],
  kindDomains: [
    { kind: 'aws-sam', meta: samDomain },
    { kind: 'cloudformation', meta: samDomain },
  ],
});

/**
 * What this package activates, in the shape every bundled plugin package publishes.
 *
 * An installed tarball is probed through this object: the package name it claims, the plugin id it
 * carries and the capability it activates. A package that stopped carrying its implementation is
 * caught by name rather than by a graph that quietly lost a resource kind.
 */
export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-iac-sam',
  pluginId: 'sam',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: samIacPlugin,
} as const);

export default builtinPluginPackage;
