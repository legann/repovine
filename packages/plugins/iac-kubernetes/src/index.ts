import { definePlugin } from '@repovine/plugin-sdk';
import { kubernetesParser } from './parsers/workloads.js';

/**
 * Built-in plugin: Kubernetes manifests (Deployment, Service, Ingress, CronJob, CRDs).
 *
 * Owns InfraKind: 'kubernetes'.
 *
 * Multiple sub-parsers can live under parsers/ — e.g. parsers/networking.ts for ingress routes
 * or parsers/crd-istio.ts for Istio CRDs. Add each to the `parsers` array below.
 */
export const kubernetesIacPlugin = definePlugin({
  id: 'kubernetes',
  capabilities: {
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

export default kubernetesIacPlugin;
