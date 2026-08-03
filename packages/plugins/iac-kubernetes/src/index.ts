import { definePlugin } from '@repovine/plugin-sdk';
import { kubernetesParser } from './parsers/workloads.js';
import { ingressRoutesProjector } from './projectors/ingress-routes.js';

/**
 * Built-in plugin: Kubernetes manifests (Deployment, Service, Ingress, CronJob, CRDs).
 *
 * Owns InfraKind: 'kubernetes'.
 *
 * The parser reads one document at a time and publishes what it says; the projector reads those
 * facts across every document and states the relations between them. Multiple sub-parsers can live
 * under parsers/ — e.g. parsers/crd-istio.ts for Istio CRDs — and each is added to `parsers` below.
 */
export const kubernetesIacPlugin = definePlugin({
  id: 'kubernetes',
  capabilities: {
    projectors: [ingressRoutesProjector],
    iac: {
      parsers: [kubernetesParser],
      kindDomains: [
        {
          kind: 'kubernetes',
          meta: {
            domainId: 'domain:infra-k8s',
            label: 'infra-k8s',
            description: 'Domain: infra-k8s (Kubernetes / k3d manifests)',
          },
        },
      ],
    },
  },
});

export { ingressRoutesProjector } from './projectors/ingress-routes.js';
export { K8S_OBJECT_SCHEMA, k8sRefScope } from './parsers/workloads.js';

export default kubernetesIacPlugin;
