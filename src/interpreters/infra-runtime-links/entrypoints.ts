import type { InterpreterEntrypointContext } from '../../interpreter/types.js';
import { infraTargetIds, nodesOfType } from '../../graph/index.js';
import {
  LAYER_ENTRYPOINT_SLOT_KEY,
  type SlottedEntrypointFragment,
} from '../../stage2/interpreter/entrypoint-slots.js';
import { triggerEntryKind } from '../../stage2/runtime/trigger-entry-kind.js';

export const INFRA_RUNTIME_LINKS_INTERPRETER_ID = 'infra-runtime-links';

/**
 * Owns the service-trigger entrypoints previously assembled inline in the MCP shell. Reads the
 * already-built runtime-resource nodes in byType
 * iteration order and emits one entry per trigger, tagged for legacy-order replay.
 */
export function collectServiceTriggerEntrypoints(ctx: InterpreterEntrypointContext): SlottedEntrypointFragment[] {
  const { graph } = ctx;
  const out: SlottedEntrypointFragment[] = [];

  for (const svcId of nodesOfType(graph, 'runtime-resource')) {
    const node = graph.nodes.get(svcId);
    if (!node || node.type !== 'runtime-resource') continue;
    const [handlerModule] = infraTargetIds(graph, svcId);
    for (const trigger of node.data?.triggers ?? []) {
      const kind = triggerEntryKind(trigger, ctx.snapshot.declarations);
      out.push({
        [LAYER_ENTRYPOINT_SLOT_KEY]: 'service-trigger',
        id: `entrypoint:${kind}:${svcId}:${trigger.name ?? trigger.path ?? trigger.queueRef ?? trigger.schedule ?? 'trigger'}`,
        kind,
        layer: 'backend',
        serviceId: svcId,
        serviceLabel: node.label,
        handler: node.data?.handler,
        handlerModule,
        provider: node.data?.provider,
        runtimeKind: node.data?.kind,
        trigger,
        method: trigger.method,
        path: trigger.path,
        source: node.data?.provider ?? 'runtime',
      });
    }
  }

  return out;
}
