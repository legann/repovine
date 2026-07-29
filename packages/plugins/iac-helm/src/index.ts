import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { helmChartParser } from './parsers/chart.js';
import { helmValuesParser } from './parsers/values.js';

/**
 * Built-in plugin: Helm charts.
 *
 * Owns InfraKind: 'helm'. Ships two parsers:
 *  - chart.ts: Chart.yaml (top-level chart manifest)
 *  - values.ts: values.yaml / values-<env>.yaml (image references inside chart values)
 *
 * Parsers register in values-first order so values files are matched before they're considered
 * as plain k8s manifests (k8s parser registers later in bootstrap).
 */
export const helmIacPlugin = defineIaCPlugin({
  id: 'helm',
  parsers: [helmValuesParser, helmChartParser],
  kindDomains: [
    {
      kind: 'helm',
      meta: {
        domainId: 'domain:infra-helm',
        label: 'infra-helm',
        description: 'Domain: infra-helm (Helm charts)',
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
  packageName: '@repovine/plugin-iac-helm',
  pluginId: 'helm',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: helmIacPlugin,
} as const);

export default builtinPluginPackage;
