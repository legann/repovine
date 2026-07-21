import { defineIaCPlugin } from '@repovine/plugin-sdk';
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

export default terraformIacPlugin;
