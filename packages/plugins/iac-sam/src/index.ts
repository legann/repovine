import { definePlugin } from '@repovine/plugin-sdk';
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

export const samIacPlugin = definePlugin({
  id: 'sam',
  capabilities: {
    iac: {
      parsers: [samParser],
      kindDomains: [
        { kind: 'aws-sam', meta: samDomain },
        { kind: 'cloudformation', meta: samDomain },
      ],
    },
  },
});

export default samIacPlugin;
