import * as fs from 'node:fs';
import * as path from 'node:path';
import { Node, Project, SyntaxKind } from 'ts-morph';
import { EDGE_KINDS, NODE_TYPES } from '../../src/types.js';

export const CORE_NODE_TYPES = [
  'root',
  'package',
  'module',
  'export-symbol',
  'runtime-resource',
  'domain',
  'template',
] as const satisfies typeof NODE_TYPES;

export const CORE_EDGE_KINDS = [
  'contains',
  'imports',
  'reexports',
  'tagged',
  'implements',
  'publishes',
  'consumes',
  'binds_to',
  'uses_env',
  'infra',
  'routes_to',
  'renders',
  'extends',
  'includes',
] as const satisfies typeof EDGE_KINDS;

export function findRepovineRoot(): string {
  const candidates = [
    process.cwd(),
    path.join(process.cwd(), 'repovine'),
  ];
  const root = candidates.find(candidate =>
    fs.existsSync(path.join(candidate, 'package.json')) &&
    fs.existsSync(path.join(candidate, 'src', 'types.ts')),
  );
  if (!root) throw new Error(`Could not find repovine root. Tried: ${candidates.join(', ')}`);
  return root;
}

export function makeProject(root = findRepovineRoot()): Project {
  return new Project({
    tsConfigFilePath: path.join(root, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  });
}

export interface ProducerScan {
  edgeKinds: Map<string, string[]>;
  nodeTypes: Map<string, string[]>;
  nonLiteralEdgeCalls: string[];
  nonLiteralNodeCalls: string[];
}

export function scanLiteralGraphProducers(root = findRepovineRoot()): ProducerScan {
  const project = makeProject(root);
  const sourceFiles = project.addSourceFilesAtPaths(path.join(root, 'src/**/*.ts').replace(/\\/g, '/'));
  const scan: ProducerScan = {
    edgeKinds: new Map(),
    nodeTypes: new Map(),
    nonLiteralEdgeCalls: [],
    nonLiteralNodeCalls: [],
  };

  for (const sourceFile of sourceFiles) {
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee)) continue;

      if (callee.getText() === 'addEdge') {
        const kindArg = call.getArguments()[3];
        if (Node.isStringLiteral(kindArg)) {
          addMapEntry(scan.edgeKinds, kindArg.getLiteralText(), formatLocation(call, root));
        } else {
          scan.nonLiteralEdgeCalls.push(formatLocation(call, root));
        }
      }

      if (callee.getText() === 'addNode') {
        const nodeArg = call.getArguments()[1];
        const typeValue = readNodeTypeLiteral(nodeArg);
        if (typeValue) {
          addMapEntry(scan.nodeTypes, typeValue, formatLocation(call, root));
        } else {
          scan.nonLiteralNodeCalls.push(formatLocation(call, root));
        }
      }
    }
  }

  return scan;
}

function readNodeTypeLiteral(node: Node | undefined): string | undefined {
  if (!Node.isObjectLiteralExpression(node)) return undefined;
  const typeProperty = node.getProperty('type');
  if (!Node.isPropertyAssignment(typeProperty)) return undefined;
  const initializer = typeProperty.getInitializer();
  return Node.isStringLiteral(initializer) ? initializer.getLiteralText() : undefined;
}

function addMapEntry(map: Map<string, string[]>, key: string, location: string): void {
  const entries = map.get(key) ?? [];
  entries.push(location);
  map.set(key, entries);
}

function formatLocation(node: Node, root = findRepovineRoot()): string {
  const sourceFile = node.getSourceFile();
  const relPath = path.relative(root, sourceFile.getFilePath()).replace(/\\/g, '/');
  const line = sourceFile.getLineAndColumnAtPos(node.getStart()).line;
  return `${relPath}:${line}`;
}
