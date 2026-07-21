import { defineIaCPlugin } from '@repovine/plugin-sdk';
import { dockerComposeParser } from './parser.js';

/** Built-in plugin: docker-compose / Compose-spec manifests. Owns InfraKind: 'docker-compose'. */
export const dockerComposeIacPlugin = defineIaCPlugin({
  id: 'docker-compose',
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
});

export default dockerComposeIacPlugin;
