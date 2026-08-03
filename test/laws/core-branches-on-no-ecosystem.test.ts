import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import ts from 'typescript';
import { repoRoot, sourceFiles } from './graph-law-helpers.js';

/**
 * Law: the engine compares against no ecosystem's composition vocabulary.
 *
 * `routing-is-plugin-owned` holds this for one ecosystem — it names five Kubernetes literals by
 * hand, because that migration was about Kubernetes. The same property is owed to all nine
 * built-ins and to the tenth plugin nobody has written yet, so the vocabulary here is **derived**
 * from the plugin manifests rather than typed out: a package that declares a provider tomorrow is
 * guarded the day its manifest lands.
 *
 * Which axes count as composition vocabulary, and why only these four:
 *
 * | Axis | Guarded here | Why |
 * |---|---|---|
 * | plugin `id`, `declarations.ecosystem` | yes | a branch on either is a branch by producer |
 * | `resourceKinds[].namespace`, `*.provider` | yes | the engine stores and compares them opaquely |
 * | `declarations.dirs[].name` | no | the per-run `DirLayoutTable` owns layout names; `acceptance-asks-the-layout-table` holds that channel |
 * | `packageMarkers` | no | `discovery-uses-declared-markers` holds that channel |
 * | `resourceKinds[].kind`, `triggerTypes[].type` | no | short forms (`api`, `queue`, `schedule`) collide with the engine's own canonical DTO vocabulary, where they are not ecosystem knowledge |
 *
 * Read through the parser, not the text: a value the engine tests against is a string literal or an
 * identifier. Prose that explains a boundary by naming what sits outside it is documentation, and a
 * law that flagged it would push authors to stop explaining.
 */

interface PluginManifest {
  repovine?: {
    kind?: string;
    id?: string;
    declarations?: {
      ecosystem?: string;
      resourceKinds?: Array<{ namespace?: string; provider?: string }>;
    };
  };
}

/** Every ecosystem name the nine built-in manifests declare, on the four guarded axes. */
function declaredEcosystemVocabulary(root: string): Set<string> {
  const pluginsRoot = path.join(root, 'packages', 'plugins');
  const vocabulary = new Set<string>();
  for (const entry of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(pluginsRoot, entry.name, 'package.json');
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
    const plugin = manifest.repovine;
    if (plugin?.kind !== 'plugin') continue;
    if (plugin.id) vocabulary.add(plugin.id);
    if (plugin.declarations?.ecosystem) vocabulary.add(plugin.declarations.ecosystem);
    for (const kind of plugin.declarations?.resourceKinds ?? []) {
      if (kind.namespace) vocabulary.add(kind.namespace);
      if (kind.provider) vocabulary.add(kind.provider);
    }
  }
  return vocabulary;
}

/**
 * Sites the engine still spells an ecosystem name at, each with the reason it is not a defect yet.
 *
 * An entry is a debt, not a permission: the map is read for staleness below, so a reviewed site that
 * gets cleaned up fails this law until its entry goes with it.
 */
/**
 * Sites the engine still spells an ecosystem name at, each with the reason it is not a defect yet.
 *
 * An entry is a debt, not a permission: the map is read for staleness below, so a reviewed site that
 * gets cleaned up fails this law until its entry goes with it.
 *
 * The map is empty. It held the Docker linking — the engine minted a `dockerfile` node id to link a
 * compose service to its build recipe, and matched container images to Dockerfiles by path token.
 * Both moved into `@repovine/plugin-iac-dockerfile`, which needed two additions to the contract to
 * become expressible at all: a read for the infra documents the graph holds, and a `builds-from`
 * relation. Until those existed the engine kept the code because a plugin had no way to say it.
 */
const REVIEWED = new Map<string, { readonly texts: readonly string[]; readonly why: string }>();

/**
 * The text of any single-line string-shaped token, including the pieces of a template literal.
 *
 * Two decisions, both made after a guard got them wrong:
 *
 *   - `isStringLiteralLike` covers a quoted string and a template with no substitutions, and stops
 *     there. Minting an id is written `` `infra:dockerfile:${path}` ``, whose leading piece is a
 *     `TemplateHead`, so a guard built on `isStringLiteralLike` alone read that as no literal at
 *     all. A kill mutation that wrote exactly that survived, which is how this was found;
 *   - a multi-line token is skipped. The engine embeds whole documents in template literals — agent
 *     instructions, config templates — and those name ecosystems as prose. Reading them flagged 129
 *     sentences. A value the engine compares against or mints is one line; a document is not.
 */
function stringTokenText(node: ts.Node): string | undefined {
  const text = ts.isStringLiteralLike(node)
    || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ? node.text
    : undefined;
  return text === undefined || text.includes('\n') ? undefined : text;
}

interface Offender {
  readonly where: string;
  readonly text: string;
}

/**
 * Whether an identifier names an ecosystem as a whole camelCase word.
 *
 * The boundary is load-bearing rather than pedantic: `sam` is a plugin id and a prefix of `sample`
 * and `same`, so a plain `startsWith` reported nineteen ordinary engine identifiers as ecosystem
 * knowledge. Splitting on the case boundary asks the question a reader would — is this word the
 * ecosystem's name — and `dockerfileRoots` still answers yes.
 */
function namesEcosystem(identifier: string, name: string): boolean {
  const words = identifier.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  return words === name
    || words.startsWith(`${name}-`)
    || words.endsWith(`-${name}`)
    || words.includes(`-${name}-`);
}

function scanEngineSources(root: string, vocabulary: ReadonlySet<string>): Offender[] {
  const offenders: Offender[] = [];
  const srcRoot = path.join(root, 'src');
  if (!fs.existsSync(srcRoot)) return offenders;
  for (const file of sourceFiles(srcRoot)) {
    const text = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
    const where = path.relative(root, file).split(path.sep).join('/');
    const visit = (node: ts.Node): void => {
      const text = stringTokenText(node);
      if (text !== undefined) {
        // A prefix literal carries the name it is a prefix of: `infra:dockerfile:` is the same
        // knowledge as `dockerfile`, spelled so a bare-name match would miss it.
        const hit = [...vocabulary].find(name => text === name || text.includes(`:${name}:`));
        if (hit !== undefined) offenders.push({ where, text });
      }
      // Identifiers too, and this half was added because the first edition missed a real site: the
      // config key `dockerfileRoots` named an ecosystem without ever writing it as a string, so a
      // literal-only scan reported the engine clean while a Docker-shaped knob sat in its schema.
      if (ts.isIdentifier(node)) {
        const hit = [...vocabulary].find(name => namesEcosystem(node.text, name));
        if (hit !== undefined) offenders.push({ where, text: node.text });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return offenders;
}

function unreviewed(offenders: readonly Offender[]): string[] {
  return offenders
    .filter(offender => !REVIEWED.get(offender.where)?.texts.includes(offender.text))
    .map(offender => `${offender.where}: "${offender.text}"`)
    .sort();
}

describe('core-laws the engine branches on no ecosystem vocabulary', () => {
  it('derives the guarded vocabulary from the plugin manifests, not from a hand-written list', () => {
    const vocabulary = declaredEcosystemVocabulary(repoRoot());

    // Positive control: a law over an empty vocabulary sweeps nothing clean. The nine ids are the
    // floor, and the derivation must also reach past `id` into the declared axes.
    expect([...vocabulary].sort()).toEqual(expect.arrayContaining([
      'docker-compose', 'dockerfile', 'helm', 'kubernetes', 'python', 'sam', 'terraform',
      'typescript', 'vercel',
    ]));
    expect([...vocabulary].sort()).toEqual(expect.arrayContaining(['aws', 'aws-lambda', 'aws-sam']));
  });

  it('names no ecosystem outside the reviewed sites', () => {
    const vocabulary = declaredEcosystemVocabulary(repoRoot());
    expect(unreviewed(scanEngineSources(repoRoot(), vocabulary))).toEqual([]);
  });

  it('carries no reviewed debt, and turns red when a stale entry is left behind', () => {
    // The registry is empty, and that is the statement: no engine file spells an ecosystem. The
    // staleness sweep below stays because an entry added later must go when its site is cleaned up.
    expect([...REVIEWED.keys()]).toEqual([]);

    const vocabulary = declaredEcosystemVocabulary(repoRoot());
    const offenders = scanEngineSources(repoRoot(), vocabulary);
    const stale: string[] = [];
    for (const [where, entry] of REVIEWED) {
      for (const text of entry.texts) {
        const present = offenders.some(offender => offender.where === where && offender.text === text);
        if (!present) stale.push(`${where}: "${text}"`);
      }
      expect(entry.why.length).toBeGreaterThan(80);
    }
    expect(stale.sort()).toEqual([]);
  });

  it('turns red when a core file branches on a plugin id (kill mutation)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine core-branch ünï-'));
    try {
      const mutation = path.join(tmpRoot, 'src', '__kill_ecosystem_branch.ts');
      fs.mkdirSync(path.dirname(mutation), { recursive: true });
      fs.writeFileSync(
        mutation,
        'export function isPython(pluginId: string): boolean {\n  return pluginId === \'python\';\n}\n',
      );
      // The vocabulary still comes from the real manifests: the mutation moves the engine, not the
      // list it is measured against.
      const vocabulary = declaredEcosystemVocabulary(repoRoot());

      // Two hits, not one: the branch value and the mutant's own name. Both are the law reading a
      // form it is meant to read, so both are asserted rather than one being filtered away.
      expect(unreviewed(scanEngineSources(tmpRoot, vocabulary)))
        .toEqual([
          'src/__kill_ecosystem_branch.ts: "isPython"',
          'src/__kill_ecosystem_branch.ts: "python"',
        ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('turns red when a core file reaches an ecosystem through an id prefix (kill mutation)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine core-prefix ünï-'));
    try {
      const mutation = path.join(tmpRoot, 'src', '__kill_prefix_branch.ts');
      fs.mkdirSync(path.dirname(mutation), { recursive: true });
      // Spelled as a prefix rather than a bare name: the form the reviewed Docker site uses, and the
      // one a bare-equality guard would wave through.
      fs.writeFileSync(
        mutation,
        'export function isHelmNode(id: string): boolean {\n  return id.startsWith(\'infra:helm:\');\n}\n',
      );
      const vocabulary = declaredEcosystemVocabulary(repoRoot());

      expect(unreviewed(scanEngineSources(tmpRoot, vocabulary)))
        .toEqual([
          'src/__kill_prefix_branch.ts: "infra:helm:"',
          'src/__kill_prefix_branch.ts: "isHelmNode"',
        ]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Law: no interpreter is handed the set of plugins that produced its input.
 *
 * The gate is the facts a repository carries, never their producer, and the engine used to compute
 * the producer set and pass it to every interpreter anyway. Nothing read it — which is exactly why
 * it needed removing rather than watching: an unused channel is a branch nobody has taken yet.
 */
describe('core-laws no interpreter receives a producer set', () => {
  const CONTEXT_TYPES = ['InterpreterGraphContext', 'InterpreterEntrypointContext'] as const;

  function contextMembers(): Map<string, string[]> {
    const file = path.join(repoRoot(), 'src', 'interpreter', 'types.ts');
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const found = new Map<string, string[]>();
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && CONTEXT_TYPES.includes(node.name.text as typeof CONTEXT_TYPES[number])) {
        found.set(
          node.name.text,
          node.members
            .map(member => (member.name && ts.isIdentifier(member.name) ? member.name.text : ''))
            .filter(name => name.length > 0),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('declares both interpreter contexts and neither carries a producer set', () => {
    const members = contextMembers();

    // Read the declarations rather than trusting a name search: a context type that was renamed away
    // would make a name-only guard green over nothing.
    expect([...members.keys()].sort()).toEqual([...CONTEXT_TYPES].sort());
    for (const [type, names] of members) {
      expect({ type, producerFields: names.filter(name => /sourcePlugin|pluginIds|producer/i.test(name)) })
        .toEqual({ type, producerFields: [] });
      // The fields that do remain are the ones a fact-gated interpreter needs, so an empty interface
      // cannot satisfy this law either.
      expect(names).toContain('snapshot');
    }
  });

  it('leaves no producer aggregate anywhere in the engine', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(repoRoot(), 'src'))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && /^(?:sourcePluginIds|collectSourcePluginIds)$/.test(node.text)) {
          offenders.push(`${path.relative(repoRoot(), file).split(path.sep).join('/')}: ${node.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(offenders.sort()).toEqual([]);
  });
});
