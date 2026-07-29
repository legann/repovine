import { definePlugin } from '@repovine/plugin-sdk';
import { dockerfileParser } from './parser.js';

/** Built-in plugin: Dockerfile / Dockerfile.<variant>. Owns InfraKind: 'dockerfile'. */
export const dockerfileIacPlugin = definePlugin({
  id: 'dockerfile',
  capabilities: {
    iac: {
      parsers: [dockerfileParser],
      kindDomains: [
        {
          kind: 'dockerfile',
          meta: {
            domainId: 'domain:infra-dockerfile',
            label: 'infra-dockerfile',
            description: 'Domain: infra-dockerfile (Dockerfiles)',
          },
        },
      ],
    },
  },
});

export default dockerfileIacPlugin;
