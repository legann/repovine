import { definePlugin } from '@repovine/plugin-sdk';
import { dockerfileParser } from './parser.js';
import { buildLinksProjector } from './projectors/build-links.js';

/** Built-in plugin: Dockerfile / Dockerfile.<variant>. Owns InfraKind: 'dockerfile'. */
export const dockerfileIacPlugin = definePlugin({
  id: 'dockerfile',
  capabilities: {
    projectors: [buildLinksProjector],
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

export { buildLinksProjector } from './projectors/build-links.js';

export default dockerfileIacPlugin;
