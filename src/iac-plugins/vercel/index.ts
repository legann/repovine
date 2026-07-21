import { defineIaCPlugin } from '@repovine/plugin-sdk';
import { vercelParser } from './parser.js';

/**
 * Built-in plugin: Vercel project config (vercel.json).
 *
 * Owns InfraKind: 'vercel'. Emits resourceKind: 'vercel-function', 'vercel-cron', 'vercel-route'.
 * Crons emit schedule triggers — registers schedule meta in case SAM isn't loaded.
 */
export const vercelIacPlugin = defineIaCPlugin({
  id: 'vercel',
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
  resourceKindMeta: [{ kind: 'vercel-function', meta: { hasCodeHandler: true } }],
  // Vercel emits schedule triggers via crons; SAM also registers this — idempotent overwrite.
  triggerTypeMeta: [{ type: 'schedule', meta: { entrypointKind: 'schedule' } }],
});

export default vercelIacPlugin;
