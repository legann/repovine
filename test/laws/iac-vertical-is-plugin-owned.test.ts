import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from '@jest/globals';
import { defineIaCParser, defineIaCPlugin } from '@repovine/plugin-sdk';
import type { DocumentLoader, IaCParser, SemanticInfraDelta } from '@repovine/plugin-sdk';
import { collectInfraModules } from '../../src/stage1/infra.js';
import { registerIaCPlugin, resetIaCParsers } from '../../src/stage1/iac/registry.js';
import { resetToBuiltinIaCPlugins } from '../../src/stage1/iac/bootstrap.js';
import { composeRepositoryGraph } from '../../src/stage2/index.js';
import type { RepositoryFactsSnapshot } from '../../src/types.js';
import { samIacPlugin } from '../../packages/plugins/iac-sam/src/index.js';
import { helmIacPlugin } from '../../packages/plugins/iac-helm/src/index.js';
import { kubernetesIacPlugin } from '../../packages/plugins/iac-kubernetes/src/index.js';
import { dockerComposeIacPlugin } from '../../packages/plugins/iac-docker-compose/src/index.js';
import { dockerfileIacPlugin } from '../../packages/plugins/iac-dockerfile/src/index.js';
import { terraformIacPlugin } from '../../packages/plugins/iac-terraform/src/index.js';
import { vercelIacPlugin } from '../../packages/plugins/iac-vercel/src/index.js';

/** The built-in set in bootstrap order, so a test can register it the other way round. */
const BUILTIN_IAC_PLUGINS = [
  samIacPlugin,
  helmIacPlugin,
  kubernetesIacPlugin,
  dockerComposeIacPlugin,
  dockerfileIacPlugin,
  terraformIacPlugin,
  vercelIacPlugin,
];

/**
 * Law: the IaC vertical is owned by plugins.
 *
 * Three things an ecosystem does — name a new kind of object, add a new kind of event, be an
 * ecosystem nobody has heard of — must each be one plugin's change. The engine stores, compares and
 * shows what a plugin emitted; it never reads a provider, kind or trigger name to decide behaviour.
 *
 * The cases below therefore introduce values the engine has no table for and assert that they reach
 * the graph anyway. A green run means the corresponding core switch does not exist: a core that
 * still branched would drop the unknown value rather than carry it.
 */
describe('core-laws the IaC vertical is plugin-owned', () => {
  const tmpDirs: string[] = [];

  function repo(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repovine iac-öwned-'));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(dir, ...rel.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    return dir;
  }

  afterEach(() => {
    resetToBuiltinIaCPlugins();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function idsIn(root: string): string[] {
    const { modules, refusals } = collectInfraModules({ repoRoot: root });
    expect(refusals).toEqual([]);
    return modules
      .flatMap(m => m.resources)
      .map(r => `resource:${r.identity.namespace}:${r.identity.localKey}`)
      .sort();
  }

  it('carries a Kubernetes kind no engine table names', () => {
    // `SnowflakeCluster` is not a workload, not a Service, and not in any map the engine holds. It
    // is the shape a CRD arrives in on the day someone installs an operator.
    const root = repo({
      'manifests/cluster.yaml': [
        'apiVersion: warehouse.example.com/v1',
        'kind: SnowflakeCluster',
        'metadata:',
        '  name: analytics',
        '  namespace: data',
      ].join('\n') + '\n',
    });
    expect(idsIn(root)).toEqual(['resource:k8s:data/SnowflakeCluster/analytics']);
  });

  it('teaching SAM a new event is a change inside the SAM package', () => {
    // What a SAM event type means is the SAM plugin's own knowledge, so adding one is an edit to
    // its parser and its trigger declarations — a closed table there is a plugin decision. What
    // this law forbids is a second copy of that knowledge in the engine, which is what would make
    // the same change touch two packages.
    // Only the types that are SAM's alone. `api` and `websocket` are also canonical entrypoint
    // kinds the engine legitimately names, so finding those in `src/` would say nothing.
    const samEventTypes = ['dynamodb-stream', 'kinesis-stream', 'event-bus'];
    const samPackage = fs.readFileSync(
      path.join(process.cwd(), 'packages', 'plugins', 'iac-sam', 'src', 'index.ts'),
      'utf8',
    );
    for (const type of samEventTypes) expect(samPackage).toContain(`'${type}'`);

    const engineFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts')) engineFiles.push(full);
      }
    };
    walk(path.join(process.cwd(), 'src'));
    const naming = engineFiles.filter(file => {
      const text = fs.readFileSync(file, 'utf8');
      return samEventTypes.some(type => text.includes(`'${type}'`));
    });
    expect(naming.map(file => path.relative(process.cwd(), file))).toEqual([]);
  });

  it('carries a trigger type no engine table names', () => {
    registerIaCPlugin(defineIaCPlugin({
      id: 'meshworks-triggers',
      parsers: [defineIaCParser({
        kind: 'mesh',
        fileMatch: { extensions: ['.trigger'] },
        loaderId: 'text',
        supports: (_f, doc) => typeof doc === 'string',
        parse: (): SemanticInfraDelta => ({
          kind: 'mesh',
          resources: [{
            id: 'router',
            kind: 'mesh-node',
            provider: 'meshworks',
            identity: { namespace: 'meshworks', localKey: 'node/router' },
            contentHash: 'mesh-router',
            attributes: {},
            triggers: [{ name: 'FromMesh', type: 'mesh-subscription' }],
          }],
        }),
      })],
    }));
    const root = repo({ 'router.trigger': 'x\n' });
    const { modules } = collectInfraModules({ repoRoot: root });
    const router = modules.flatMap(m => m.resources).find(r => r.id === 'router');
    // The trigger keeps its declared type. What that type means — stream-like, which entrypoint it
    // projects into — is a declaration, and an undeclared type declares nothing rather than being
    // discarded on the way through.
    expect(router?.triggers?.map(t => t.type)).toEqual(['mesh-subscription']);
  });

  it('carries an ecosystem the engine has never heard of, added as a plugin alone', () => {
    const meshLoader: DocumentLoader = {
      id: 'mesh-lines',
      load: ({ content }) => [{
        documentKey: '0',
        value: Buffer.from(content).toString('utf8').trim().split('\n'),
      }],
    };
    const meshParser: IaCParser = defineIaCParser({
      kind: 'mesh',
      fileMatch: { extensions: ['.mesh'] },
      loaderId: 'mesh-lines',
      supports: (_f, doc) => Array.isArray(doc),
      parse: (_f, _rel, doc): SemanticInfraDelta => ({
        kind: 'mesh',
        resources: (doc as string[]).map(name => ({
          id: name,
          kind: 'mesh-node',
          provider: 'meshworks',
          identity: { namespace: 'meshworks', localKey: `node/${name}` },
          contentHash: `mesh-${name}`,
          attributes: { declaredBy: 'mesh' },
        })),
      }),
    });
    registerIaCPlugin(defineIaCPlugin({
      id: 'meshworks',
      parsers: [meshParser],
      loaders: [meshLoader],
    }));

    const root = repo({ 'topology.mesh': 'alpha\nbeta\n' });
    expect(idsIn(root)).toEqual(['resource:meshworks:node/alpha', 'resource:meshworks:node/beta']);

    // …and all the way into the graph, with the provider and kind the plugin chose, unread.
    const { modules } = collectInfraModules({ repoRoot: root });
    const snapshot: RepositoryFactsSnapshot = {
      repoRoot: root,
      timestamp: new Date(0).toISOString(),
      packages: [],
      modules: [],
      infraModules: modules,
    };
    const graph = composeRepositoryGraph(snapshot);
    const node = graph.nodes.get('resource:meshworks:node/alpha');
    expect(node?.type).toBe('runtime-resource');
    const data = node?.type === 'runtime-resource' ? node.data : undefined;
    expect(data?.provider).toBe('meshworks');
    expect(data?.kind).toBe('mesh-node');
  });

  it('gives the same result whichever order the plugins registered in', () => {
    const root = repo({
      'template.yaml': [
        'Transform: AWS::Serverless::2016-10-31',
        'Resources:',
        '  Fn:',
        '    Type: AWS::Serverless::Function',
        '    Properties: { Handler: src/fn.main }',
      ].join('\n') + '\n',
      'manifests/svc.yaml': [
        'apiVersion: v1',
        'kind: Service',
        'metadata: { name: api, namespace: shop }',
      ].join('\n') + '\n',
      'vercel.json': '{"version":2,"crons":[{"path":"/api/tick","schedule":"* * * * *"}]}\n',
      'Dockerfile': 'FROM node:22\n',
    });

    const forward = idsIn(root);

    // The same built-ins, registered back to front. Under the old first-match-wins scan this was
    // precedence: SAM had to register before Kubernetes, or a CloudFormation document was offered
    // to the manifest parser first and the template was read as one.
    resetIaCParsers();
    for (const plugin of [...BUILTIN_IAC_PLUGINS].reverse()) registerIaCPlugin(plugin);
    const reversed = idsIn(root);

    expect(reversed).toEqual(forward);
    // A fixture that produced one resource would pass this whichever way the scan worked.
    expect(forward.length).toBeGreaterThan(3);
    expect(new Set(forward.map(id => id.split(':')[1])).size).toBeGreaterThan(2);
  });
});
