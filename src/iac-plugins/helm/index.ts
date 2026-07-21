import { defineIaCPlugin } from '@repovine/plugin-sdk';
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

export default helmIacPlugin;
