import * as path from 'node:path';
import type { IaCParser, SemanticInfraDelta, InfraResource } from '@repovine/plugin-sdk';
import { hashResourcePayload, pathGroupingLabel, toPosixPath } from '@repovine/plugin-sdk';

function parseFirstFrom(content: string): string {
  const line = content.split('\n').find(l => /^\s*FROM\s+/i.test(l));
  if (!line) return '';
  const match = line.match(/\bFROM\s+(?:--platform=\S+\s+)?(\S+)/i);
  return match ? match[1].trim() : '';
}

export const dockerfileParser: IaCParser = {
  kind: 'dockerfile',
  fileMatch: { fileNamePatterns: [/^Dockerfile(\..*)?$/] },
  loaderId: 'text',

  supports(absPath, doc): boolean {
    const base = path.basename(absPath);
    if (base !== 'Dockerfile' && !base.startsWith('Dockerfile.')) return false;
    return typeof doc === 'string';
  },

  parse(absPath, repoRelPath, doc): SemanticInfraDelta | null {
    if (typeof doc !== 'string') return null;
    const content = doc;
    const domainPath = pathGroupingLabel(repoRelPath.replace(/\/Dockerfile.*$/, ''));
    const normalizedRel = toPosixPath(repoRelPath);
    const baseImage = parseFirstFrom(content);
    const attrs: Record<string, string> = { domainPath };
    if (baseImage) attrs.baseImage = baseImage;
    const dockerResourceBody = { id: normalizedRel, kind: 'dockerfile' as const, attributes: attrs };
    const resources: InfraResource[] = [{
      id: normalizedRel,
      kind: 'other',
      provider: 'generic',
      identity: { namespace: 'generic', localKey: normalizedRel },
      contentHash: hashResourcePayload(dockerResourceBody),
      attributes: attrs,
    }];
    return { kind: 'dockerfile', resources };
  },
};
