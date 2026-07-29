import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ts from 'typescript';

// Law: every closed literal axis in the plugin SDK source tree is owner-reviewed.
//
// The engine owns axes; a plugin declares values. A closed enumeration inverts that — it decides in
// the core which values can be spoken about, and an author whose stack is not on the list cannot add
// it without a release of ours. An OPEN union (`Known… | (string & {})`) is the opposite shape: the
// listed members are autocomplete and an author can extend them, so this law does not judge it.
//
// This is deliberately a source-tree law, not a claim that every matched declaration is reachable
// from a package barrel. It reads exported declarations AND private/local implementation lists. That
// wider scope keeps schema copies and discovery constants from escaping review, while the inventory
// records which side each match came from so the header cannot quietly become a public-surface claim.
//
// The policy is positive and owner-scoped. APPROVED_AXIS_MEMBERS names the neutral vocabulary each
// closed axis may currently use; EXEMPT records legacy product/framework/cloud values with a reason
// and retirement condition. Any new value — including an unknown product absent from a blacklist —
// fails until its declaration owner is reviewed. Pulumi, AWSLambda and Terraform therefore have the
// same answer when introduced on a new closed axis.
//
// A literal list that is not an axis stands in NOT_AN_AXIS under its file + declaration owner. Those
// carve-outs are whole-list exemptions, so every entry carries both why the list is not this law's
// subject and the concrete condition that retires the carve-out.
//
// WHAT THE AST INVENTORY READS
// - string-literal unions on type aliases and interface/type properties;
// - named array constants, with or without `as const` or a type annotation;
// - named `new Set<T>([...])` constants, with or without a type argument;
// - `z.enum([...])`, owned by the containing declaration and object-property path.
//
// Computed/spread lists, function-call results, parameter defaults and unions in return/parameter
// positions are outside this law. TypeScript's parser, rather than source regexes, defines the forms
// above and makes comments, quote style, generic arguments and property ownership unambiguous.

const SDK_SRC = path.join(process.cwd(), 'packages', 'plugin-sdk', 'src');

interface ReviewRecord {
  reason: string;
  retirement: string;
}

interface ExemptionRecord extends ReviewRecord {
  members: ReadonlySet<string>;
}

function members(...values: string[]): ReadonlySet<string> {
  return new Set(values);
}

/**
 * Legacy product/framework/cloud values on closed axes.
 *
 * Identity includes the declaration owner: two properties in one file may carry the same member
 * without sharing an exemption.
 */
const EXEMPT = new Map<string, ExemptionRecord>([]);

/**
 * Literal lists that are implementation data rather than values a plugin chooses on an axis.
 *
 * Identity includes file + owner: a same-named declaration in another module does not inherit the
 * carve-out.
 */
const NOT_AN_AXIS = new Map<string, ReviewRecord>([
  ['source-plugin/discovery-walk.ts::REPOVINE_ENGINE_SCAN_IGNORE_PATTERNS', {
    reason: 'Directory spellings the shared discovery walk must not enter; members classify paths.',
    retirement: 'Remove when the ignore floor is represented as plugin-declared discovery policy.',
  }],
  ['source-plugin/discovery-walk.ts::TEST_LAYOUT_DIRS', {
    reason: 'Directory spellings that classify test-layout paths rather than plugin-declared values.',
    retirement: 'Remove when test-layout conventions move into plugin-declared discovery policy.',
  }],
  ['conformance.ts::MECHANICAL_KEYS', {
    reason: 'Object-key spellings used by the conformance checker to reject engine-owned fields.',
    retirement: 'Remove when the conformance checker derives mechanical keys from a typed contract.',
  }],
  ['conformance.ts::SEMANTIC_KEYS', {
    reason: 'Object-key spellings used by the conformance checker to select producer-owned fields.',
    retirement: 'Remove when the conformance checker derives semantic keys from a typed contract.',
  }],
  ['source-plugin/handler-resolver.ts::COMMON_BUILD_OUTPUT_ROOTS', {
    reason: 'Directory spellings searched while resolving built handler artifacts, not axis values.',
    retirement: 'Remove when build-output roots become producer-declared handler resolver input.',
  }],
  ['iac-plugin/attributes.ts::CONTAINER_PATH_SEGMENTS', {
    reason: 'Directory spellings a grouping label drops; members classify paths rather than name a value.',
    retirement: 'Remove when container segments come from the per-run ecosystem dir table.',
  }],
]);

/**
 * Neutral members accepted for each closed axis. The owner key prevents a value reviewed for one
 * meaning from silently authorising the same spelling on an unrelated axis.
 */
const APPROVED_AXIS_MEMBERS = new Map<string, ReadonlySet<string>>([
  ['source-plugin/semantic-hints-schema.ts::zRouteInfo.declaredIn',
    members('code', 'layout')],
  ['source-plugin/semantic-hints-schema.ts::zRouteInfo.syntax',
    members('markup', 'table', 'decorator', 'call')],
  ['source-plugin/semantic-hints-schema.ts::zRouteInfo.kind',
    members('frontend', 'api')],
  ['source-plugin/semantic-hints-schema.ts::zSecuritySignal.kind',
    members(
      'secret-env',
      'public-env',
      'browser-storage',
      'browser-storage-sensitive',
      'cookie-access',
      'validation',
      'authz',
      'source-disclosure',
    )],
  ['source-plugin/semantic-hints-schema.ts::zSsrMarkers.runsOn',
    members('server', 'client')],
  ['source-plugin/types.ts::ScanScope',
    members('all', 'source', 'infra')],
  ['source-plugin/types.ts::SourceDiscoveryLogLevel',
    members('debug', 'warn', 'error')],
  ['types.ts::SymbolKind',
    members('function', 'class', 'interface', 'type', 'const', 'enum', 'component', 'unknown')],
  ['types.ts::MemberInfo.kind',
    members('method', 'property')],
  ['types.ts::MemberInfo.access',
    members('private', 'protected', 'public')],
  ['types.ts::InternalInfo.kind',
    members('function', 'variable', 'destructuring')],
  ['types.ts::RouteDeclarationSite',
    members('code', 'layout')],
  ['types.ts::RouteDeclarationSyntax',
    members('markup', 'table', 'decorator', 'call')],
  ['types.ts::RouteInfo.kind',
    members('frontend', 'api')],
  ['types.ts::UiDataAccess.kind',
    members('fetch', 'http-client', 'query', 'mutation', 'graphql', 'storage', 'api-client')],
  ['types.ts::UiNavigationAction.kind',
    members('navigate', 'router-push', 'redirect', 'history')],
  ['types.ts::UiTimerAction.kind',
    members('timeout', 'interval', 'animation-frame')],
  ['types.ts::UiSubscriptionAction.kind',
    members('event-listener', 'observable', 'websocket', 'realtime')],
  ['types.ts::UiServiceWrapperHint.role',
    members('service', 'client', 'api', 'adapter', 'manager', 'provider')],
  ['types.ts::UiComponentPropHint.kind',
    members('data', 'callback', 'setter', 'state-flag', 'unknown')],
  ['types.ts::UiComponentPropHint.source',
    members('destructured-param', 'props-object', 'type-only', 'unknown')],
  ['types.ts::SecuritySignal.kind',
    members(
      'secret-env',
      'public-env',
      'browser-storage',
      'browser-storage-sensitive',
      'cookie-access',
      'validation',
      'authz',
      'source-disclosure',
    )],
  ['types.ts::SsrMarkers.runsOn',
    members('server', 'client')],
  ['types.ts::InfraAccessMode',
    members('read', 'write', 'read-write')],
  ['types.ts::InfraEnvRef.refType',
    members('ref', 'getatt', 'sub', 'literal')],
  ['types.ts::DOCUMENT_CLAIMS',
    members('shared', 'exclusive')],
  ['types.ts::TRIGGER_ENTRY_KINDS',
    members('api', 'schedule', 'websocket', 'webhook', 'queue-consumer', 'unknown')],
  ['plugin/declarations.ts::ECOSYSTEM_DIR_ROLES',
    members('dependencies', 'build-output', 'tool-output', 'test-layout')],
  ['plugin/descriptor.ts::PLUGIN_CAPABILITY_NAMES',
    members('source', 'iac', 'loaders', 'projectors')],
  ['plugin/projection.ts::PROJECTION_REF_TYPES',
    members('module', 'resource', 'extension')],
  ['plugin/projection.ts::SEMANTIC_LINK_RELATIONS',
    members('publishes', 'consumes', 'binds-to', 'uses-env', 'routes-to')],
  ['plugin/projection.ts::ENTRYPOINT_CONTRIBUTION_KINDS',
    members('api-route', 'file-route', 'ui-route', 'conditional-render', 'resource-trigger')],
  ['plugin/projection-schema.ts::ProjectionRefProblemReason',
    members('unknown-module', 'unknown-resource', 'unknown-extension')],
]);

type EnumerationKind =
  | 'type-union'
  | 'property-union'
  | 'array-constant'
  | 'set-constant'
  | 'zod-enum';

interface Enumeration {
  where: string;
  owner: string;
  members: string[];
  open: boolean;
  kind: EnumerationKind;
  scope: 'exported-declaration' | 'local-declaration';
}

function sdkSources(): Array<{ rel: string; source: ts.SourceFile }> {
  const out: Array<{ rel: string; source: ts.SourceFile }> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    ))) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.name.endsWith('.ts')) {
        const rel = path.relative(SDK_SRC, abs).split(path.sep).join('/');
        out.push({
          rel,
          source: ts.createSourceFile(
            rel,
            fs.readFileSync(abs, 'utf-8'),
            ts.ScriptTarget.Latest,
            true,
            ts.ScriptKind.TS,
          ),
        });
      }
    }
  };
  walk(SDK_SRC);
  return out;
}

function hasExportModifier(node: ts.Node | undefined): boolean {
  return Boolean(node && ts.canHaveModifiers(node)
    && ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function declarationScope(node: ts.Node): Enumeration['scope'] {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (
      hasExportModifier(current)
      || (ts.isVariableDeclaration(current) && hasExportModifier(current.parent.parent))
    ) {
      return 'exported-declaration';
    }
    current = current.parent;
  }
  return 'local-declaration';
}

function propertyName(node: ts.PropertyName): string {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)
    || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) {
    return node.text;
  }
  return node.getText();
}

function propertyOwner(node: ts.PropertySignature | ts.PropertyDeclaration): string {
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if ((ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)
      || ts.isClassDeclaration(current)) && current.name) {
      return `${current.name.text}.${propertyName(node.name)}`;
    }
    current = current.parent;
  }
  return `<anonymous>.${propertyName(node.name)}`;
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function arrayMembers(node: ts.ArrayLiteralExpression): string[] | null {
  const members: string[] = [];
  for (const element of node.elements) {
    const value = unwrapExpression(element);
    if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) return null;
    members.push(value.text);
  }
  return members.length > 0 ? members : null;
}

function stringUnionMembers(node: ts.UnionTypeNode): string[] {
  return node.types.flatMap(member => (
    ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
      ? [member.literal.text]
      : []
  ));
}

function isOpenStringType(node: ts.TypeNode): boolean {
  const current = ts.isParenthesizedTypeNode(node) ? node.type : node;
  if (!ts.isIntersectionTypeNode(current)) return false;
  const hasString = current.types.some(part => part.kind === ts.SyntaxKind.StringKeyword);
  const hasEmptyObject = current.types.some(part => ts.isTypeLiteralNode(part) && part.members.length === 0);
  return hasString && hasEmptyObject;
}

function zodOwner(call: ts.CallExpression): string {
  const properties: string[] = [];
  let current: ts.Node | undefined = call;
  while (current && !ts.isSourceFile(current)) {
    if (ts.isPropertyAssignment(current)) properties.push(propertyName(current.name));
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return [current.name.text, ...properties.reverse()].join('.');
    }
    current = current.parent;
  }
  const { line, character } = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart());
  return `<inline@${line + 1}:${character + 1}>`;
}

function enumKey(enumeration: Pick<Enumeration, 'where' | 'owner'>): string {
  return `${enumeration.where}::${enumeration.owner}`;
}

function memberKey(enumeration: Pick<Enumeration, 'where' | 'owner'>, member: string): string {
  return `${enumKey(enumeration)}::${member}`;
}

function enumerations(sources = sdkSources()): Enumeration[] {
  const found: Enumeration[] = [];

  for (const { rel, source } of sources) {
    const reopenedAliases = new Set<string>();

    const findReopened = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)
        && node.type.types.some(isOpenStringType)) {
        for (const part of node.type.types) {
          if (ts.isTypeReferenceNode(part) && ts.isIdentifier(part.typeName)) {
            reopenedAliases.add(part.typeName.text);
          }
        }
      }
      ts.forEachChild(node, findReopened);
    };
    findReopened(source);

    const visit = (node: ts.Node): void => {
      if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type)) {
        const members = stringUnionMembers(node.type);
        if (members.length > 0) {
          found.push({
            where: rel,
            owner: node.name.text,
            members,
            open: reopenedAliases.has(node.name.text) || node.type.types.some(isOpenStringType),
            kind: 'type-union',
            scope: declarationScope(node),
          });
        }
      } else if (
        (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
        && node.type
        && ts.isUnionTypeNode(node.type)
      ) {
        const members = stringUnionMembers(node.type);
        if (members.length > 0) {
          found.push({
            where: rel,
            owner: propertyOwner(node),
            members,
            open: node.type.types.some(isOpenStringType),
            kind: 'property-union',
            scope: declarationScope(node),
          });
        }
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isArrayLiteralExpression(initializer)) {
          const members = arrayMembers(initializer);
          if (members) {
            found.push({
              where: rel,
              owner: node.name.text,
              members,
              open: false,
              kind: 'array-constant',
              scope: declarationScope(node),
            });
          }
        } else if (
          ts.isNewExpression(initializer)
          && ts.isIdentifier(initializer.expression)
          && initializer.expression.text === 'Set'
          && initializer.arguments?.length === 1
        ) {
          const argument = unwrapExpression(initializer.arguments[0]);
          if (ts.isArrayLiteralExpression(argument)) {
            const members = arrayMembers(argument);
            if (members) {
              found.push({
                where: rel,
                owner: node.name.text,
                members,
                open: false,
                kind: 'set-constant',
                scope: declarationScope(node),
              });
            }
          }
        }
      } else if (
        ts.isCallExpression(node)
        && ts.isPropertyAccessExpression(node.expression)
        && ts.isIdentifier(node.expression.expression)
        && node.expression.expression.text === 'z'
        && node.expression.name.text === 'enum'
        && node.arguments.length === 1
      ) {
        const argument = unwrapExpression(node.arguments[0]);
        if (ts.isArrayLiteralExpression(argument)) {
          const members = arrayMembers(argument);
          if (members) {
            found.push({
              where: rel,
              owner: zodOwner(node),
              members,
              open: false,
              kind: 'zod-enum',
              scope: declarationScope(node),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return found;
}

function invalidRecords(records: Map<string, ReviewRecord>): string[] {
  return [...records.entries()]
    .filter(([, record]) => record.reason.trim().length < 40 || record.retirement.trim().length < 40)
    .map(([key]) => key)
    .sort();
}

function unreviewedAxisMembers(entries: Enumeration[]): string[] {
  const axes = entries
    .filter(enumeration => !enumeration.open)
    .filter(enumeration => !NOT_AN_AXIS.has(enumKey(enumeration)));
  return [...new Set(axes.flatMap(enumeration => {
    const approved = APPROVED_AXIS_MEMBERS.get(enumKey(enumeration)) ?? new Set<string>();
    const exempt = EXEMPT.get(enumKey(enumeration))?.members ?? new Set<string>();
    return enumeration.members
      .filter(member => !approved.has(member) && !exempt.has(member))
      .map(member => memberKey(enumeration, member));
  }))].sort();
}

describe('core-laws every closed SDK literal axis is owner-reviewed', () => {
  const inventory = enumerations();
  const closed = inventory.filter(enumeration => !enumeration.open);
  const axes = closed.filter(enumeration => !NOT_AN_AXIS.has(enumKey(enumeration)));

  it('inventory matches the scope claimed in the header', () => {
    // These are structural witnesses, not a snapshot of every declaration. They turn red if AST
    // coverage loses a promised form or if the law silently narrows to only public or only local.
    const kinds = new Set(inventory.map(enumeration => enumeration.kind));
    expect([...kinds].sort()).toEqual([
      'array-constant',
      'property-union',
      'set-constant',
      'type-union',
      'zod-enum',
    ]);
    expect(inventory.some(enumeration => enumeration.scope === 'exported-declaration')).toBe(true);
    expect(inventory.some(enumeration => enumeration.scope === 'local-declaration')).toBe(true);
    // `InfraResource.provider` used to stand here as the property-union witness. It is an open
    // `Known… | (string & {})` now, so it proves nothing about closed-axis coverage; the witness
    // moved to a property union that is still closed.
    expect(inventory.some(enumeration => (
      enumeration.where === 'types.ts'
      && enumeration.owner === 'InfraEnvRef.refType'
      && enumeration.kind === 'property-union'
    ))).toBe(true);
    expect(inventory.some(enumeration => (
      enumeration.where === 'source-plugin/discovery-walk.ts'
      && enumeration.owner === 'TEST_LAYOUT_DIRS'
      && enumeration.kind === 'set-constant'
    ))).toBe(true);
    expect(inventory.some(enumeration => (
      enumeration.where === 'source-plugin/semantic-hints-schema.ts'
      && enumeration.owner === 'zRouteInfo.syntax'
      && enumeration.scope === 'local-declaration'
      && enumeration.kind === 'zod-enum'
    ))).toBe(true);
  });

  it('supports generic Set syntax and keeps declaration owners distinct', () => {
    const source = ts.createSourceFile(
      'probe.ts',
      [
        "const FIRST: ReadonlySet<string> = new Set<string>(['alpha']);",
        "const SECOND = new Set(['alpha']);",
        "interface One { kind: 'alpha' | 'beta' }",
        "interface Two { kind: 'alpha' | 'beta' }",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const owners: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = unwrapExpression(node.initializer);
        if (ts.isNewExpression(initializer) && initializer.arguments?.[0]
          && ts.isArrayLiteralExpression(unwrapExpression(initializer.arguments[0]))) {
          owners.push(node.name.text);
        }
      }
      if ((ts.isPropertySignature(node) || ts.isPropertyDeclaration(node))
        && node.type && ts.isUnionTypeNode(node.type)) {
        owners.push(propertyOwner(node));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(owners.sort()).toEqual(['FIRST', 'One.kind', 'SECOND', 'Two.kind']);
  });

  it('rejects Pulumi, AWSLambda and Terraform without relying on a product blacklist', () => {
    const source = ts.createSourceFile(
      'product-probe.ts',
      [
        "export interface ProviderProbe { provider: 'pulumi' | 'AWSLambda' | 'terraform' }",
        "export const PROVIDER_SET: ReadonlySet<string> = new Set<string>(['pulumi', 'AWSLambda', 'terraform']);",
      ].join('\n'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const probeInventory = enumerations([{ rel: 'product-probe.ts', source }]);
    expect(unreviewedAxisMembers(probeInventory)).toEqual([
      'product-probe.ts::PROVIDER_SET::AWSLambda',
      'product-probe.ts::PROVIDER_SET::pulumi',
      'product-probe.ts::PROVIDER_SET::terraform',
      'product-probe.ts::ProviderProbe.provider::AWSLambda',
      'product-probe.ts::ProviderProbe.provider::pulumi',
      'product-probe.ts::ProviderProbe.provider::terraform',
    ]);
  });

  it('admits only the reviewed neutral vocabulary or an owner-scoped legacy exemption', () => {
    expect(unreviewedAxisMembers(inventory)).toEqual([]);
  });

  it('keeps every legacy exemption live, owner-scoped and documented', () => {
    const byOwner = new Map(axes.map(enumeration => [enumKey(enumeration), enumeration]));
    const stale = [...EXEMPT.entries()].flatMap(([key, record]) => {
      const enumeration = byOwner.get(key);
      if (!enumeration) return [key];
      const liveMembers = new Set(enumeration.members);
      return [...record.members]
        .filter(member => !liveMembers.has(member))
        .map(member => `${key}::${member}`);
    });
    expect(stale.sort()).toEqual([]);
    expect(invalidRecords(EXEMPT)).toEqual([]);
  });

  it('keeps every non-axis carve-out live, owner-scoped and documented', () => {
    const live = new Set(closed.map(enumKey));
    const keys = [...NOT_AN_AXIS.keys()];
    expect(keys.filter(key => !live.has(key)).sort()).toEqual([]);
    expect(invalidRecords(NOT_AN_AXIS)).toEqual([]);
  });
});
