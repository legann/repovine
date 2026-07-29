import { definePlugin } from '@repovine/plugin-sdk';
import { vercelParser } from './parser.js';

/**
 * Built-in plugin: Vercel project config (vercel.json).
 *
 * Owns InfraKind: 'vercel'. Emits resourceKind: 'vercel-function', 'vercel-cron', 'vercel-route'.
 * Crons emit schedule triggers; the declaration in `package.json#repovine` carries the Vercel
 * provider, so it answers for Vercel resources whether or not the SAM plugin is loaded.
 */
export const vercelIacPlugin = definePlugin({
  id: 'vercel',
  capabilities: {
    iac: {
      parsers: [vercelParser],
      kindDomains: [
        {
          kind: 'vercel',
          meta: {
            domainId: 'domain:infra-vercel',
            label: 'infra-vercel',
            description: 'Domain: infra-vercel (Vercel project configuration)',
          },
        },
      ],
    },
  },
});

export default vercelIacPlugin;
