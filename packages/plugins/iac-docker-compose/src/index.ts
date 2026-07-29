import { definePlugin } from '@repovine/plugin-sdk';
import { dockerComposeParser } from './parser.js';

/** Built-in plugin: docker-compose / Compose-spec manifests. Owns InfraKind: 'docker-compose'. */
export const dockerComposeIacPlugin = definePlugin({
  id: 'docker-compose',
  capabilities: {
    iac: {
      parsers: [dockerComposeParser],
      kindDomains: [
        {
          kind: 'docker-compose',
          meta: {
            domainId: 'domain:infra-docker-compose',
            label: 'infra-docker-compose',
            description: 'Domain: infra-docker-compose (docker-compose / Compose files)',
          },
        },
      ],
    },
  },
});

export default dockerComposeIacPlugin;
