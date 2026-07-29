import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { kubernetesParser } from './parsers/workloads.js';

/**
 * Built-in plugin: Kubernetes manifests (Deployment, Service, Ingress, CronJob, CRDs).
 *
 * Owns InfraKind: 'kubernetes'.
 *
 * Multiple sub-parsers can live under parsers/ — e.g. parsers/networking.ts for ingress routes
 * or parsers/crd-istio.ts for Istio CRDs. Add each to the `parsers` array below.
 */
export const kubernetesIacPlugin = defineIaCPlugin({
  id: 'kubernetes',
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
});

/**
 * What this package activates, in the shape every bundled plugin package publishes.
 *
 * An installed tarball is probed through this object: the package name it claims, the plugin id it
 * carries and the capability it activates. A package that stopped carrying its implementation is
 * caught by name rather than by a graph that quietly lost a resource kind.
 */
export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-iac-kubernetes',
  pluginId: 'kubernetes',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: kubernetesIacPlugin,
} as const);

export default builtinPluginPackage;
