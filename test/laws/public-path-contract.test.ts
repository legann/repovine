import { describe, expect, it } from '@jest/globals';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import {
  asHostPath,
  asPkgRelPath,
  asRepoRelPath,
} from '@repovine/plugin-sdk';
import type {
  HostPath,
  PkgRelPath,
  RepoRelPath,
} from '@repovine/plugin-sdk';
import { createFactView } from '../../src/stage2/projection/fact-view.js';
import type { RepositoryFactsSnapshot } from '../../src/types.js';
import { guardedRoots, repoRoot, sourceFiles } from './graph-law-helpers.js';

/**
 * Law: every public path says both where it is measured from and how it is spelled.
 *
 * Host paths preserve the filesystem spelling. Repository- and package-relative paths are separate
 * POSIX identities: a package-relative `src/index.ts` is not the repository-relative
 * `packages/app/src/index.ts`. The three brands make an accidental substitution a compile error;
 * the inventory below makes a newly published, unclassified path a test failure.
 */

function normalizeType(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function publicPathInventory(): string[] {
  const sdkRoot = path.join(repoRoot(), 'packages', 'plugin-sdk', 'src');
  const entries: string[] = [];

  for (const file of sourceFiles(sdkRoot)) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.type) {
            const type = normalizeType(member.type.getText(source));
            if (/\b(?:HostPath|RepoRelPath|PkgRelPath)\b/.test(type)) {
              entries.push(`${node.name.text}.${member.name.getText(source)}: ${type}`);
            }
          }
          if (ts.isMethodSignature(member)) {
            for (const parameter of member.parameters) {
              if (!parameter.type) continue;
              const type = normalizeType(parameter.type.getText(source));
              if (/\b(?:HostPath|RepoRelPath|PkgRelPath)\b/.test(type)) {
                entries.push(
                  `${node.name.text}.${member.name.getText(source)}(${parameter.name.getText(source)}: ${type})`,
                );
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  return entries.sort();
}

const EXPECTED_PUBLIC_PATHS = [
  'DocumentLoadInput.repoRelPath: RepoRelPath',
  'HandlerResolveContext.infraRepoRelPath: RepoRelPath',
  'HandlerResolveContext.repoRelArtifactRoot: RepoRelPath',
  'HandlerResolveContext.repoRelHandlerPathMap: Readonly<Record<string, RepoRelPath>>',
  'HandlerResolveContext.repoRelSearchRoots: readonly RepoRelPath[]',
  'HandlerResolveContext.resolveModuleByRepoRelPath(candidate: RepoRelPath)',
  'IaCParser.parse(absPath: HostPath)',
  'IaCParser.parse(repoRelPath: RepoRelPath)',
  'IaCParser.supports(absPath: HostPath)',
  'InfraModuleInfo.absPath: HostPath',
  'InfraModuleInfo.repoRelPath: RepoRelPath',
  'ModuleInfo.absPath: HostPath',
  'ModuleInfo.pkgRelPath: PkgRelPath',
  'PackageInfo.repoRelDir: RepoRelPath',
  'PendingModuleDraft.absPath: HostPath',
  'PendingModuleDraft.pkgRelPath: PkgRelPath',
  'PendingModuleDraft.virtualAbsPath: HostPath',
  'PluginConformanceInput.repoRoot: HostPath',
  'PrunedDir.repoRelPath: RepoRelPath',
  'ReadonlyInfraModuleFact.repoRelPath: RepoRelPath',
  'ReadonlyModuleFact.repoRelPath: RepoRelPath',
  'ReadonlyProjectionInput.repoRoot: HostPath',
  'SourceDiscoveryResult.pendingByAbsPath: Map<HostPath, PendingModuleDraft>',
  'SourceExtractInput.absPathToId: Map<HostPath, string>',
  'SourceExtractInput.prevByAbsPath: Map<HostPath, ModuleInfo>',
  'SourceExtractInput.repoRoot: HostPath',
  'SourcePlugin.discover(repoRoot: HostPath)',
  'WalkRepositoryOptions.repoRoot: HostPath',
  'WalkedFile.absPath: HostPath',
  'WalkedFile.repoRelPath: RepoRelPath',
].sort();

function iacParserParameters(): Array<{ file: string; method: string; parameters: string[] }> {
  const root = repoRoot();
  const pluginsRoot = path.join(root, 'packages', 'plugins');
  const entries: Array<{ file: string; method: string; parameters: string[] }> = [];

  for (const dirent of fs.readdirSync(pluginsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.startsWith('iac-')) continue;
    for (const file of sourceFiles(path.join(pluginsRoot, dirent.name, 'src'))) {
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isMethodDeclaration(node)
          && ts.isIdentifier(node.name)
          && (node.name.text === 'supports' || node.name.text === 'parse')
        ) {
          entries.push({
            file: path.relative(root, file).replace(/\\/g, '/'),
            method: node.name.text,
            parameters: node.parameters.map(parameter => parameter.name.getText(source).replace(/^_/, '')),
          });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }

  return entries;
}

describe('core-laws public path contract', () => {
  it('keeps host, repository-relative and package-relative paths nominally distinct', () => {
    const host = asHostPath('/repo/packages/app/src/index.ts');
    const repo = asRepoRelPath('packages/app/src/index.ts');
    const pkg = asPkgRelPath('src/index.ts');

    const hostOk: HostPath = host;
    const repoOk: RepoRelPath = repo;
    const pkgOk: PkgRelPath = pkg;
    // @ts-expect-error A repository-relative POSIX path is not an absolute host path.
    const hostFromRepo: HostPath = repo;
    // @ts-expect-error A package-relative POSIX path is not a repository-relative path.
    const repoFromPkg: RepoRelPath = pkg;
    // @ts-expect-error An absolute host path is not a package-relative POSIX path.
    const pkgFromHost: PkgRelPath = host;

    // Brands are compile-only: workers, caches and JSON still receive strings byte-for-byte.
    expect([hostOk, repoOk, pkgOk, hostFromRepo, repoFromPkg, pkgFromHost]).toEqual([
      '/repo/packages/app/src/index.ts',
      'packages/app/src/index.ts',
      'src/index.ts',
      'packages/app/src/index.ts',
      'src/index.ts',
      '/repo/packages/app/src/index.ts',
    ]);
  });

  it('publishes no path field without an explicit base', () => {
    expect(publicPathInventory()).toEqual(EXPECTED_PUBLIC_PATHS);
  });

  it('asserts path bases only through the three named SDK constructors', () => {
    const assertions: string[] = [];
    for (const { root, dir } of guardedRoots()) {
      for (const file of sourceFiles(dir)) {
        const rel = path.relative(root, file).replace(/\\/g, '/');
        fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
          if (/\bas (?:HostPath|RepoRelPath|PkgRelPath)\b/.test(line)) {
            assertions.push(`${rel}:${index + 1}:${line.trim()}`);
          }
        });
      }
    }
    expect(assertions.map(line => line.replace(/:\d+:/, ':<line>:'))).toEqual([
      'packages/plugin-sdk/src/path-contract.ts:<line>:return value as HostPath;',
      'packages/plugin-sdk/src/path-contract.ts:<line>:return value as RepoRelPath;',
      'packages/plugin-sdk/src/path-contract.ts:<line>:return value as PkgRelPath;',
    ]);
  });

  it('derives a projector-visible module path from the repository root, not the package root', () => {
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: '/repo',
      timestamp: '2026-07-29T00:00:00.000Z',
      packages: [{
        name: '@scope/app',
        repoRelDir: asRepoRelPath('packages/app'),
        sourcePluginId: 'typescript',
      }],
      modules: [{
        id: 'mod:@scope/app/src/index',
        packageName: '@scope/app',
        absPath: asHostPath('/repo/packages/app/src/index.ts'),
        pkgRelPath: asPkgRelPath('src/index.ts'),
        contentHash: 'fixture',
        imports: [],
        exports: [],
        sourcePluginId: 'typescript',
      }],
    };

    expect(createFactView({ snapshot }).module('mod:@scope/app/src/index')).toEqual({
      moduleId: 'mod:@scope/app/src/index',
      packageName: '@scope/app',
      repoRelPath: 'packages/app/src/index.ts',
    });
  });

  it('labels the snapshot dump with the repository-relative base it writes', () => {
    const dumpSource = fs.readFileSync(path.join(repoRoot(), 'src', 'index.ts'), 'utf8');
    expect(/\bfilePath\s*:/.test(dumpSource)).toBe(false);
    expect(dumpSource).toMatch(
      /repoRelPath\s*:\s*repoRelativePosix\(\s*repoRoot\s*,\s*m\.absPath\s*\)/,
    );
  });

  it('uses the same parameter vocabulary in every built-in IaC parser', () => {
    const parsers = iacParserParameters();
    const supports = parsers.filter(entry => entry.method === 'supports');
    const parse = parsers.filter(entry => entry.method === 'parse');
    expect(supports).toHaveLength(8);
    expect(parse).toHaveLength(8);
    expect(supports.filter(entry => entry.parameters[0] !== 'absPath')).toEqual([]);
    expect(parse.filter(entry =>
      entry.parameters[0] !== 'absPath' || entry.parameters[1] !== 'repoRelPath',
    )).toEqual([]);
    expect(new Set(parsers.map(entry => entry.file.split('/')[2]))).toEqual(new Set([
      'iac-docker-compose',
      'iac-dockerfile',
      'iac-helm',
      'iac-kubernetes',
      'iac-sam',
      'iac-terraform',
      'iac-vercel',
    ]));
  });

  it('keeps both external canaries on the frozen path vocabulary', () => {
    const fixtureRoot = path.join(repoRoot(), 'test', 'fixtures', 'canary-plugins');
    for (const canary of ['go-source', 'orbit-iac']) {
      const text = fs.readFileSync(path.join(fixtureRoot, canary, 'src', 'index.ts'), 'utf8');
      expect({ canary, oldNames: /\bpendingByPath\b|\brelativeFilePath\b|\bfilePath\s*:|\brelPath\s*:/.test(text) })
        .toEqual({ canary, oldNames: false });
      for (const name of ['repoRelDir', 'pendingByAbsPath', 'absPath', 'pkgRelPath']) {
        expect({ canary, name, present: new RegExp(`\\b${name}\\b`).test(text) })
          .toEqual({ canary, name, present: true });
      }
      expect({ canary, canonicalWriteKey: /pendingByAbsPath\.set\(\s*hostPathKey\(absPath\)/.test(text) })
        .toEqual({ canary, canonicalWriteKey: true });
    }
  });

  it('publishes no example or standalone fixture in the pre-contract vocabulary', () => {
    const surfaces = [
      'docs/plugin-authoring.md',
      'examples/repovine-plugin-go/index.js',
      'examples/repovine-plugin-iac/index.js',
      'examples/repovine-plugin-iac/run.mjs',
      'scripts/smoke-sdk-standalone.mjs',
    ];
    const oldName = /\bpendingByPath\b|\brelativeFilePath\b|\bfilePath\b|\brelPath\b|\brelFromRoot\b/;
    for (const surface of surfaces) {
      const text = fs.readFileSync(path.join(repoRoot(), surface), 'utf8');
      expect({ surface, oldNames: oldName.test(text) }).toEqual({ surface, oldNames: false });
      expect({ surface, namesTheNewContract: /\b(?:absPath|repoRelPath|pkgRelPath|repoRelDir|pendingByAbsPath)\b/.test(text) })
        .toEqual({ surface, namesTheNewContract: true });
    }
  });

  it('runs the sample path contract and packed external plugins on every native CI host', () => {
    const ci = fs.readFileSync(path.join(repoRoot(), '.github', 'workflows', 'ci.yml'), 'utf8');
    const nativeStart = ci.indexOf('  core-native:');
    const nativeEnd = ci.indexOf('  harness-linux:', nativeStart);
    expect(nativeStart).toBeGreaterThan(-1);
    expect(nativeEnd).toBeGreaterThan(nativeStart);

    const nativeJob = ci.slice(nativeStart, nativeEnd);
    for (const command of [
      'node examples/repovine-plugin-go/run.mjs',
      'node examples/repovine-plugin-iac/run.mjs',
      'node scripts/smoke-canary-plugins.mjs',
    ]) {
      expect({ command, inNativeMatrix: nativeJob.includes(command) })
        .toEqual({ command, inNativeMatrix: true });
    }

    expect(nativeJob).toContain('os: windows-latest');
    expect(nativeJob).toContain('os: macos-15');
  });
});
