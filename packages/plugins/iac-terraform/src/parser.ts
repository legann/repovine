import * as path from 'node:path';
import type {
  IaCParser,
  InfraEnvRef,
  SemanticInfraDelta,
  InfraResource,
  InfraResourceKind,
} from '@repovine/plugin-sdk';
import { hashResourcePayload } from '@repovine/plugin-sdk';

const TERRAFORM_TYPE_TO_KIND: Record<string, InfraResourceKind> = {
  aws_lambda_function: 'lambda',
  aws_lambda_alias: 'lambda',
  aws_dynamodb_table: 'table',
  aws_sqs_queue: 'queue',
  aws_sns_topic: 'topic',
  aws_s3_bucket: 'bucket',
  aws_api_gateway_rest_api: 'api',
  aws_apigatewayv2_api: 'api',
  aws_iam_role: 'role',
  // Declared secret resources across providers (pattern A). aws_ssm_parameter is handled
  // separately in resolveTerraformKind because it is only a secret when type = "SecureString".
  aws_secretsmanager_secret: 'secret',
  google_secret_manager_secret: 'secret',
  azurerm_key_vault_secret: 'secret',
  vault_generic_secret: 'secret',
  vault_kv_secret: 'secret',
  vault_kv_secret_v2: 'secret',
  kubernetes_secret: 'secret',
  kubernetes_secret_v1: 'secret',
  google_cloudfunctions_function: 'lambda',
  google_cloudfunctions2_function: 'lambda',
  google_storage_bucket: 'bucket',
  google_pubsub_topic: 'topic',
  google_pubsub_subscription: 'queue',
  azurerm_function_app: 'lambda',
  azurerm_linux_function_app: 'lambda',
  azurerm_storage_account: 'bucket',
  azurerm_servicebus_queue: 'queue',
  azurerm_servicebus_topic: 'topic',
};

/** Env-map attributes whose `KEY = <expr>` entries carry runtime env references. */
const TERRAFORM_ENV_MAP_ATTRS = ['variables', 'environment_variables', 'app_settings'];

/** Address prefixes that are not resource/data/module nodes, so they never become env targets. */
const TERRAFORM_NON_RESOURCE_PREFIX = /^(?:var|local|each|count|self|path|terraform)$/;

/**
 * SSM parameters are secrets only when SecureString; plain String/StringList params are config.
 * Other types come from the static map, defaulting to 'other'.
 */
function resolveTerraformKind(terraformType: string | undefined, attrs: Record<string, string>): InfraResourceKind {
  if (!terraformType) return 'other';
  const mapped = TERRAFORM_TYPE_TO_KIND[terraformType];
  if (mapped) return mapped;
  if (terraformType === 'aws_ssm_parameter') {
    return attrs.type === 'SecureString' ? 'secret' : 'other';
  }
  return 'other';
}

/** Return the first offset after an HCL quoted string, preserving escaped quotes. */
function skipQuotedString(content: string, start: number): number {
  let i = start + 1;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === '"') return i + 1;
    i++;
  }
  return i;
}

/** Return the first offset after an HCL heredoc, or undefined when `start` is not a marker. */
function skipHeredoc(content: string, start: number): number | undefined {
  const opening = /^<<(-?)([A-Za-z_][A-Za-z0-9_-]*)[ \t]*\r?\n/.exec(content.slice(start));
  if (!opening) return undefined;

  const allowIndent = opening[1] === '-';
  const delimiter = opening[2];
  let lineStart = start + opening[0].length;
  while (lineStart < content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;
    const rawLine = content.slice(lineStart, lineEnd).replace(/\r$/, '');
    const candidate = allowIndent ? rawLine.trimStart() : rawLine;
    if (candidate.trimEnd() === delimiter) {
      return newline === -1 ? lineEnd : newline + 1;
    }
    if (newline === -1) return content.length;
    lineStart = newline + 1;
  }
  return content.length;
}

function extractTerraformBlocks(content: string): Array<{
  blockType: string;
  args: string[];
  body: string;
}> {
  const out: Array<{ blockType: string; args: string[]; body: string }> = [];
  const headerRe = /^(\s*)(resource|data|module|output|variable|provider|locals)\b([^{]*)\{/gm;
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(content)) !== null) {
    const blockType = m[2];
    const argsRaw = m[3];
    const args: string[] = [];
    for (const a of argsRaw.matchAll(/"([^"]*)"/g)) args.push(a[1]);
    const bodyStart = headerRe.lastIndex;
    let depth = 1;
    let i = bodyStart;
    while (i < content.length && depth > 0) {
      const ch = content[i];
      if (ch === '<') {
        const heredocEnd = skipHeredoc(content, i);
        if (heredocEnd !== undefined) {
          i = heredocEnd;
          continue;
        }
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"') {
        i = skipQuotedString(content, i);
        continue;
      }
      else if (ch === '#') {
        while (i < content.length && content[i] !== '\n') i++;
      }
      i++;
    }
    if (depth === 0) {
      out.push({ blockType, args, body: content.slice(bodyStart, i - 1) });
      headerRe.lastIndex = i;
    } else {
      break;
    }
  }
  return out;
}

function extractTerraformAttrs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*=\s*"([^"]*)"/gim)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

/** Return the `{ ... }` bodies of each `<attrName> = { ... }` map found in `body` (brace-balanced). */
function findMapBlockBodies(body: string, attrName: string): string[] {
  const out: string[] = [];
  const headerRe = new RegExp(`\\b${attrName}\\s*=\\s*\\{`, 'g');
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(body)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < body.length && depth > 0) {
      const ch = body[i];
      if (ch === '<') {
        const heredocEnd = skipHeredoc(body, i);
        if (heredocEnd !== undefined) {
          i = heredocEnd;
          continue;
        }
      }
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === '"') {
        i = skipQuotedString(body, i);
        continue;
      }
      i++;
    }
    if (depth === 0) {
      out.push(body.slice(start, i - 1));
      headerRe.lastIndex = i;
    } else {
      break;
    }
  }
  return out;
}

/**
 * Resolve a Terraform expression to the logical name of the resource/data/module it references,
 * matching the node label the parser assigns (`blk.args[1]` for resource/data, `blk.args[0]` for
 * module). Returns undefined for literals and non-resource refs (var/local/...).
 */
function referenceTargetName(expr: string): string | undefined {
  let candidate = expr.trim();
  const interp = candidate.match(/\$\{([^}]+)\}/);
  if (interp) {
    candidate = interp[1].trim();
  } else if (/^".*"$/.test(candidate)) {
    return undefined; // plain quoted string literal, not a reference
  }
  const m = candidate.match(/^((?:data\.|module\.)?[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_-]+)+)/);
  if (!m) return undefined;
  const tokens = m[1].split('.');
  if (tokens[0] === 'data') return tokens.length >= 3 ? tokens[2] : undefined;
  if (tokens[0] === 'module') return tokens.length >= 2 ? tokens[1] : undefined;
  if (TERRAFORM_NON_RESOURCE_PREFIX.test(tokens[0])) return undefined;
  return tokens.length >= 2 ? tokens[1] : undefined;
}

/**
 * Extract env vars and resource references from a resource body's env maps
 * (`environment { variables = {...} }`, `environment_variables = {...}`, `app_settings = {...}`).
 * Each `KEY = <type>.<name>.<attr>` becomes an envRef the runtime-link layer resolves to a node
 * (secret-ness is read later from the target node's kind, no extra edge logic here).
 */
function extractTerraformEnv(body: string): { envVars: string[]; envRefs: InfraEnvRef[] } {
  const envVars: string[] = [];
  const envRefs: InfraEnvRef[] = [];
  const seenVar = new Set<string>();
  const seenRef = new Set<string>();
  for (const attrName of TERRAFORM_ENV_MAP_ATTRS) {
    for (const mapBody of findMapBlockBodies(body, attrName)) {
      for (const line of mapBody.split('\n')) {
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq).trim().replace(/^"(.*)"$/, '$1');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        const expr = line.slice(eq + 1).trim().replace(/,$/, '').trim();
        if (!seenVar.has(key)) {
          seenVar.add(key);
          envVars.push(key);
        }
        const target = referenceTargetName(expr);
        if (!target) continue;
        const refKey = `${key}:${target}`;
        if (seenRef.has(refKey)) continue;
        seenRef.add(refKey);
        envRefs.push({
          varName: key,
          refType: expr.includes('${') ? 'sub' : 'getatt',
          targetLogicalId: target,
        });
      }
    }
  }
  return { envVars, envRefs };
}

export const terraformParser: IaCParser = {
  kind: 'terraform',
  fileMatch: { extensions: ['.tf'] },
  loaderId: 'text',

  supports(filePath: string, doc: unknown): boolean {
    if (path.extname(filePath).toLowerCase() !== '.tf') return false;
    return typeof doc === 'string';
  },

  parse(filePath: string, relPath: string, doc: unknown): SemanticInfraDelta | null {
    if (typeof doc !== 'string') return null;
    const content = doc;

    const blocks = extractTerraformBlocks(content);
    const resources: InfraResource[] = [];

    for (const blk of blocks) {
      if (blk.blockType !== 'resource' && blk.blockType !== 'data' && blk.blockType !== 'module') {
        continue;
      }
      const attrs = extractTerraformAttrs(blk.body);
      let id: string;
      let terraformType: string | undefined;
      let resKind: InfraResourceKind = 'other';
      if (blk.blockType === 'resource' || blk.blockType === 'data') {
        if (blk.args.length < 2) continue;
        terraformType = blk.args[0];
        id = blk.args[1];
        resKind = resolveTerraformKind(terraformType, attrs);
      } else {
        if (blk.args.length < 1) continue;
        id = blk.args[0];
        terraformType = 'module';
      }
      const { envVars, envRefs } = extractTerraformEnv(blk.body);
      const tfBlockBody = {
        id,
        blockType: blk.blockType,
        terraformType,
        attributes: attrs,
      };
      resources.push({
        id,
        kind: resKind,
        provider: 'terraform',
        identity: { namespace: 'terraform', localKey: id },
        contentHash: hashResourcePayload(tfBlockBody),
        attributes: {
          terraformBlockType: blk.blockType,
          ...(terraformType ? { terraformType } : {}),
          ...attrs,
        },
        envVars: envVars.length > 0 ? envVars : undefined,
        envRefs: envRefs.length > 0 ? envRefs : undefined,
      });
    }

    return { kind: 'terraform', resources };
  },
};
