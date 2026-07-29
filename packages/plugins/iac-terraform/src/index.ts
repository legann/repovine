import { PLUGIN_API_VERSION, defineIaCPlugin } from '@repovine/plugin-sdk';
import { terraformParser } from './parser.js';

/**
 * Built-in plugin: Terraform / OpenTofu .tf files.
 *
 * Owns InfraKind: 'terraform'. Recognizes AWS/GCP/Azure provider types and maps them onto our
 * generic InfraResourceKind set. Unknown provider types fall through to 'other' — they still
 * appear as services in the graph, just without specialized treatment.
 *
 * Lambda meta is registered here too (in addition to the SAM plugin) so a repo using only
 * Terraform still gets handler→code linking.
 */
export const terraformIacPlugin = defineIaCPlugin({
  id: 'terraform',
  parsers: [terraformParser],
  kindDomains: [
    {
      kind: 'terraform',
      meta: {
        domainId: 'domain:infra-terraform',
        label: 'infra-terraform',
        description: 'Domain: infra-terraform (HCL modules and resources)',
      },
    },
  ],
  resourceKindMeta: [{ kind: 'lambda', meta: { hasCodeHandler: true } }],
});

/**
 * What this package activates, in the shape every bundled plugin package publishes.
 *
 * An installed tarball is probed through this object: the package name it claims, the plugin id it
 * carries and the capability it activates. A package that stopped carrying its implementation is
 * caught by name rather than by a graph that quietly lost a resource kind.
 */
export const builtinPluginPackage = Object.freeze({
  packageName: '@repovine/plugin-iac-terraform',
  pluginId: 'terraform',
  capability: 'iac',
  apiVersion: PLUGIN_API_VERSION,
  activation: 'iac-plugin',
  iacPlugin: terraformIacPlugin,
} as const);

export default builtinPluginPackage;
