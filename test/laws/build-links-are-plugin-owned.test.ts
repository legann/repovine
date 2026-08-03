import { asHostPath, asRepoRelPath } from '@repovine/plugin-sdk';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';
import ts from 'typescript';
import type {
  PluginProjectionBatch,
  ProjectionContributor,
  ReadonlyFactRecord,
  ReadonlyProjectionInput,
  SemanticLinkContribution,
} from '@repovine/plugin-sdk';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { InfraModuleInfo, RepositoryFactsSnapshot, RepositoryGraph } from '../../src/types.js';
import { attachProjectors, restoreBuiltinPlugins } from '../helpers/plugins.js';
import { repoRoot, sourceFiles } from './graph-law-helpers.js';

/**
 * Law: the link from a deployable thing to the recipe it was built from belongs to a plugin.
 *
 * The engine used to own this for Docker: it minted a `dockerfile` node id to connect a compose
 * service to its build file, and matched container image names to Dockerfiles by path token. Both
 * were the last ecosystem vocabulary in `src/**`, and both were unmovable until the contract could
 * express them — a projector had no way to name an infrastructure document, and no relation meant
 * "built from".
 *
 * The ecosystem below exists nowhere but this file. It has its own build-recipe format, its own
 * image spelling and its own matching rule, and it reaches the graph through the same two additions
 * Docker now uses. A green run means the corresponding core branch does not exist.
 */

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

const PLUGIN_ID = 'foundry';
const BLUEPRINT_KIND = 'foundry-blueprint';
const IMAGE_SCHEMA = 'foundry/unit@1';

interface FoundryUnit {
  localKey: string;
  artifact: string;
}

function unitFact(unit: FoundryUnit): ReadonlyFactRecord {
  return {
    schema: IMAGE_SCHEMA,
    subjectRef: { type: 'resource', namespace: 'foundry', localKey: unit.localKey },
    value: { localKey: unit.localKey, artifact: unit.artifact },
  };
}

function blueprintModule(repoRelPath: string): InfraModuleInfo {
  return {
    id: `infra:${BLUEPRINT_KIND}:${repoRelPath}`,
    kind: BLUEPRINT_KIND,
    absPath: asHostPath(`/repo/${repoRelPath}`),
    repoRelPath: asRepoRelPath(repoRelPath),
    contentHash: repoRelPath,
    resources: [],
  };
}

/**
 * The matching rule this ecosystem declares: an artifact name matches the blueprint whose directory
 * carries the same last segment.
 */
const foundryBuildLinks: ProjectionContributor = {
  id: 'foundry-build-links',
  requires: [{ schema: IMAGE_SCHEMA }],
  project(input: ReadonlyProjectionInput): readonly PluginProjectionBatch[] {
    const blueprints = input.facts.infraModules({ kind: BLUEPRINT_KIND });
    const links: SemanticLinkContribution[] = [];
    for (const record of input.facts.select({ schema: IMAGE_SCHEMA })) {
      const unit = record.value as unknown as FoundryUnit;
      const wanted = unit.artifact.split('/').pop()!.split(':')[0];
      const match = blueprints.find(bp => String(bp.repoRelPath).split('/').at(-2) === wanted);
      if (!match) continue;
      links.push({
        from: { type: 'resource', namespace: 'foundry', localKey: unit.localKey },
        to: { type: 'module', moduleId: match.moduleId },
        relation: 'builds-from',
        because: 'the foundry unit names this blueprint',
      });
    }
    return links.length > 0 ? [{ batchId: 'foundry-builds', delta: { links } }] : [];
  },
};

function graphOf(units: FoundryUnit[], blueprintPaths: string[]): RepositoryGraph {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: new Date(0).toISOString(),
    packages: [],
    modules: [],
    infraModules: [
      ...blueprintPaths.map(blueprintModule),
      {
        id: 'infra:foundry:deploy/units.foundry',
        kind: 'foundry',
        absPath: asHostPath('/repo/deploy/units.foundry'),
        repoRelPath: asRepoRelPath('deploy/units.foundry'),
        contentHash: 'units',
        resources: units.map(unit => ({
          id: unit.localKey,
          kind: 'foundry-unit',
          provider: 'foundry',
          identity: { namespace: 'foundry', localKey: unit.localKey },
          contentHash: unit.localKey,
          attributes: { artifact: unit.artifact },
        })),
      },
    ],
    facts: units.map(unitFact),
  };
  attachProjectors(snapshot, PLUGIN_ID, [foundryBuildLinks]);
  return composeRepositoryGraph(snapshot);
}

function buildsFrom(graph: RepositoryGraph, from: string): string[] {
  return (graph.outEdges.get(from) ?? [])
    .filter(edge => edge.kind === 'infra')
    .map(edge => edge.to)
    .sort();
}

describe('core-laws the build-recipe link is plugin-owned', () => {
  afterEach(async () => {
    await restoreBuiltinPlugins();
  });

  it('links a resource to a build document of an ecosystem the engine has no name for', () => {
    const graph = graphOf(
      [{ localKey: 'checkout', artifact: 'registry.example.com/acme/checkout:1.4' }],
      ['services/checkout/build.foundry', 'services/billing/build.foundry'],
    );

    expect(buildsFrom(graph, 'resource:foundry:checkout'))
      .toEqual(['infra:foundry-blueprint:services/checkout/build.foundry']);
  });

  it('hands the projector the engine-minted id, not one the plugin spelled', () => {
    // The projector never builds `infra:<kind>:<path>` itself. It reads the id beside the path and
    // references what it was given, which is why the id format can change without touching a plugin.
    const source = fs.readFileSync(
      path.join(repoRoot(), 'packages', 'plugins', 'iac-dockerfile', 'src', 'projectors', 'build-links.ts'),
      'utf8',
    );
    expect(source).toContain('infraModules(');
    expect(source).not.toContain('infra:');
  });

  it('resolves the reference rather than dropping the batch', () => {
    // A module reference to an infra document has to resolve against the global index. When it did
    // not, this batch was rejected whole and the link vanished with no refusal a reader would see.
    const graph = graphOf(
      [
        { localKey: 'checkout', artifact: 'acme/checkout' },
        { localKey: 'ghost', artifact: 'acme/nothing-here' },
      ],
      ['services/checkout/build.foundry'],
    );

    expect(buildsFrom(graph, 'resource:foundry:checkout'))
      .toEqual(['infra:foundry-blueprint:services/checkout/build.foundry']);
    // The unmatched unit is still a node; only its link is absent.
    expect(graph.nodes.has('resource:foundry:ghost')).toBe(true);
    expect(buildsFrom(graph, 'resource:foundry:ghost')).toEqual([]);
  });

  it('does not depend on which order the documents were scanned in', () => {
    const forward = graphOf(
      [{ localKey: 'checkout', artifact: 'acme/checkout' }],
      ['services/checkout/build.foundry', 'services/billing/build.foundry'],
    );
    const reversed = graphOf(
      [{ localKey: 'checkout', artifact: 'acme/checkout' }],
      ['services/billing/build.foundry', 'services/checkout/build.foundry'],
    );

    expect(buildsFrom(reversed, 'resource:foundry:checkout'))
      .toEqual(buildsFrom(forward, 'resource:foundry:checkout'));
  });

  it('leaves no Docker vocabulary in engine sources', () => {
    // Read through the parser, so the guard sees what a branch could compare rather than what a
    // sentence mentions. Both spellings: the value and the identifier.
    const literals = new Set(['dockerfile', 'infra:dockerfile:', 'docker-compose']);
    const names = new Set(['dockerfileRoots', 'listDockerfileModuleIds', 'resolveDockerfileModuleId',
      'dockerfilePathTokens', 'linkContainerRuntimeTargets']);
    const offenders: string[] = [];

    for (const file of sourceFiles(path.join(repoRoot(), 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        const text = stringTokenText(node);
        const hit = (text !== undefined && [...literals].find(name => text === name || text.includes(name)))
          || (ts.isIdentifier(node) && names.has(node.text) ? node.text : undefined);
        if (hit) offenders.push(`${path.relative(repoRoot(), file)}: ${hit}`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }

    expect(offenders.sort()).toEqual([]);
  });

  it('keeps the Docker implementation in the plugin that owns Dockerfiles', () => {
    const projector = path.join(
      repoRoot(), 'packages', 'plugins', 'iac-dockerfile', 'src', 'projectors', 'build-links.ts',
    );
    expect(fs.existsSync(projector)).toBe(true);
    const source = fs.readFileSync(projector, 'utf8');
    // One implementation of the matching, and it is here rather than copied into each producer.
    for (const owned of ['imagePathTokens', 'dockerfilePathTokens', 'builds-from']) {
      expect({ owned, present: source.includes(owned) }).toEqual({ owned, present: true });
    }

    // The producers state what their own documents say and stop there.
    const compose = fs.readFileSync(
      path.join(repoRoot(), 'packages', 'plugins', 'iac-docker-compose', 'src', 'parser.ts'), 'utf8',
    );
    expect(compose).toContain('docker-compose/build@1');
    for (const producer of ['iac-kubernetes/src/parsers/workloads.ts', 'iac-helm/src/parsers/values.ts']) {
      const text = fs.readFileSync(path.join(repoRoot(), 'packages', 'plugins', producer), 'utf8');
      expect({ producer, publishes: text.includes('containerImages') })
        .toEqual({ producer, publishes: true });
      // No producer resolves a Dockerfile itself; that question has one owner.
      expect({ producer, resolves: text.includes('dockerfilePathTokens') })
        .toEqual({ producer, resolves: false });
    }
  });
});
