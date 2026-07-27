import * as path from 'node:path';
import type { IaCParser, SemanticInfraDelta, InfraResource } from '@repovine/plugin-sdk';
import { shortenText } from '@repovine/plugin-sdk';
import { hashResourcePayload } from '../../../stage1/iac/utils.js';

export const helmChartParser: IaCParser = {
  kind: 'helm',
  fileMatch: { fileNames: ['Chart.yaml', 'Chart.yml'] },
  docFormat: 'yaml',

  supports(_filePath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (d.Resources && typeof d.Resources === 'object') return false;
    if (typeof d.apiVersion === 'string' && d.apiVersion.startsWith('v2') && typeof d.name === 'string') return true;
    return false;
  },

  parse(filePath: string, relPath: string, doc: unknown): SemanticInfraDelta | null {
    if (!doc || typeof doc !== 'object') return null;
    const d = doc as { name?: string; version?: string; appVersion?: string; description?: string };
    const name = d.name ?? path.basename(path.dirname(filePath));
    const helmResourceBody = {
      id: name,
      name: d.name,
      version: d.version,
      appVersion: d.appVersion,
    };
    const resources: InfraResource[] = [{
      id: name,
      kind: 'helm-release',
      provider: 'generic',
      contentHash: hashResourcePayload(helmResourceBody),
      attributes: {
        ...(d.version ? { version: String(d.version) } : {}),
        ...(d.appVersion ? { appVersion: String(d.appVersion) } : {}),
        ...(d.description ? { description: shortenText(String(d.description), 200) } : {}),
      },
    }];
    return { kind: 'helm', resources };
  },
};
