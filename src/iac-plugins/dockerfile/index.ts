import { defineIaCPlugin } from '@repovine/plugin-sdk';
import { dockerfileParser } from './parser.js';

/** Built-in plugin: Dockerfile / Dockerfile.<variant>. Owns InfraKind: 'dockerfile'. */
export const dockerfileIacPlugin = defineIaCPlugin({
  id: 'dockerfile',
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
});

export default dockerfileIacPlugin;
