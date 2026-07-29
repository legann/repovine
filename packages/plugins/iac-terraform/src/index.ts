import { definePlugin } from '@repovine/plugin-sdk';
import { terraformParser } from './parser.js';

/**
 * Built-in plugin: Terraform / OpenTofu .tf files.
 *
 * Owns InfraKind: 'terraform'. Recognizes AWS/GCP/Azure provider types and maps them onto our
 * generic InfraResourceKind set. Unknown provider types fall through to 'other' — they still
 * appear as services in the graph, just without specialized treatment.
 *
 * Terraform mints its own identity namespace, so it declares its own lambda metadata in
 * `package.json#repovine.declarations` — a repo using only Terraform still gets handler→code
 * linking, and the declaration does not collide with the SAM plugin's.
 */
export const terraformIacPlugin = definePlugin({
  id: 'terraform',
  capabilities: {
    iac: {
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
    },
  },
});

export default terraformIacPlugin;
