import { defineIaCPlugin } from '@repovine/plugin-sdk';
import { samParser } from './parser.js';

/**
 * Built-in plugin: AWS SAM / CloudFormation parser.
 *
 * Owns InfraKind: 'aws-sam', 'cloudformation' (both share the same domain).
 * Emits resourceKind: 'lambda', 'queue', 'topic', 'table', 'api', 'bucket', 'role'.
 * Emits triggerType: 'api', 'sqs', 'schedule', 'event-bus', 'dynamodb-stream', 'kinesis-stream', 'websocket'.
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
  // Lambda has a code handler that stage2 should resolve back to a module.
  resourceKindMeta: [{ kind: 'lambda', meta: { hasCodeHandler: true } }],
  // Trigger-type metadata: drives stage2 stream-edge logic and mcp/handlers entrypoint labels.
  triggerTypeMeta: [
    { type: 'api', meta: { entrypointKind: 'api' } },
    { type: 'websocket', meta: { entrypointKind: 'websocket' } },
    { type: 'sqs', meta: { entrypointKind: 'queue-consumer', isStreamLike: true } },
    { type: 'dynamodb-stream', meta: { entrypointKind: 'queue-consumer', isStreamLike: true } },
    { type: 'kinesis-stream', meta: { entrypointKind: 'queue-consumer', isStreamLike: true } },
    { type: 'schedule', meta: { entrypointKind: 'schedule' } },
    { type: 'event-bus', meta: { entrypointKind: 'queue-consumer' } },
  ],
});

export default samIacPlugin;
