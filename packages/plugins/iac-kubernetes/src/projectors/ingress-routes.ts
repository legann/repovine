import type {
  PluginProjectionBatch,
  ProjectionContributor,
  ReadonlyProjectionInput,
  SemanticLinkContribution,
} from '@repovine/plugin-sdk';
import { K8S_OBJECT_SCHEMA } from '../parsers/workloads.js';

/** The identity namespace every Kubernetes object of this plugin is minted under. */
const IDENTITY_NAMESPACE = 'k8s';

/** The manifest kind a backend reference names. An Ingress is never another Ingress's backend. */
const SERVICE_KIND = 'Service';

interface K8sObjectFact {
  localKey: string;
  manifestKind: string;
  name: string;
  refScope: string;
  backends: readonly string[];
}

function asObjectFact(value: unknown): K8sObjectFact | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { localKey, manifestKind, name, refScope } = record;
  if (typeof localKey !== 'string' || typeof manifestKind !== 'string') return undefined;
  if (typeof name !== 'string' || typeof refScope !== 'string') return undefined;
  const backends = Array.isArray(record.backends)
    ? record.backends.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return { localKey, manifestKind, name, refScope, backends };
}

/** The key a backend reference is looked up by: a Service name is unique inside one namespace. */
function serviceKey(refScope: string, name: string): string {
  return `${refScope} ${name}`;
}

/**
 * Ingress-to-Service routing, projected from what the manifests declared.
 *
 * An Ingress names its backends by bare Service name, and that name reaches its own namespace only.
 * Both ends of the relation are resources the IaC pass already minted, so this contributes no
 * resource of its own: it points at what the graph holds and states the relation between them.
 */
export const ingressRoutesProjector: ProjectionContributor = {
  id: 'ingress-routes',
  requires: [{ schema: K8S_OBJECT_SCHEMA }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const facts: K8sObjectFact[] = [];
    for (const record of input.facts.select({ schema: K8S_OBJECT_SCHEMA })) {
      const fact = asObjectFact(record.value);
      if (fact) facts.push(fact);
    }

    const servicesByName = new Map<string, K8sObjectFact>();
    for (const fact of facts) {
      if (fact.manifestKind !== SERVICE_KIND) continue;
      const key = serviceKey(fact.refScope, fact.name);
      if (!servicesByName.has(key)) servicesByName.set(key, fact);
    }

    const batches: PluginProjectionBatch[] = [];
    for (const ingress of facts) {
      if (ingress.backends.length === 0) continue;
      // A resource the repository's own configuration excluded is not in the graph, and a reference
      // that resolves to nothing takes the whole batch with it. Ask first, lose the link only.
      if (!input.facts.hasResource({ namespace: IDENTITY_NAMESPACE, localKey: ingress.localKey })) continue;

      const links: SemanticLinkContribution[] = [];
      for (const backend of ingress.backends) {
        const service = servicesByName.get(serviceKey(ingress.refScope, backend));
        if (!service || service.localKey === ingress.localKey) continue;
        if (!input.facts.hasResource({ namespace: IDENTITY_NAMESPACE, localKey: service.localKey })) continue;
        links.push({
          from: { type: 'resource', namespace: IDENTITY_NAMESPACE, localKey: ingress.localKey },
          to: { type: 'resource', namespace: IDENTITY_NAMESPACE, localKey: service.localKey },
          relation: 'routes-to',
          because: 'the ingress names this service as a backend',
        });
      }
      if (links.length === 0) continue;
      batches.push({ batchId: `ingress:${ingress.localKey}`, delta: { links } });
    }

    return batches;
  },
};
