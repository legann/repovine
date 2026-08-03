import * as path from 'node:path';
import { describe, expect, it } from '@jest/globals';
import { collectInfraModules } from '../../src/stage1/infra.js';
import { makeRuntimeResourceId } from '../../src/graph/make-runtime-resource-id.js';

/**
 * Law: a runtime-resource id minted before identity moved into the plugins still reads the same.
 *
 * Annotations are keyed on these strings. An id that shifts does not break a build — it silently
 * orphans every note attached to the resource and re-registers it as something new. The identity
 * components are now the plugin's to compute and the encoding is the host's, so a change on either
 * side of that seam can move an id without any other test noticing.
 *
 * The list below is pinned by hand from a build of the tree before the migration. It is deliberately
 * not derived from anything the code under test produces: an expectation computed by the current
 * minter would agree with whatever the minter now does, which is the one thing this law must not do.
 * A fixture that legitimately gains or loses a resource updates the list; an id that changes spelling
 * for a resource that did not change is the failure this exists for.
 */
const FIXTURE_ROOT = path.join(process.cwd(), 'test', 'fixtures');

/** Fixtures chosen to cover every namespace the built-in plugins mint into. */
const FIXTURES = [
  'sam-lambda-app',
  'lambda-monorepo',
  'k8s-statefulset',
  'k8s-cronjob',
  'k8s-operator',
  'helm-images',
  'terraform-app',
  'docker-compose-app',
  'nextjs-app-router',
];

const BASELINE_IDS = [
  'resource:aws-lambda:ApiFunction',
  'resource:aws:DbSecret',
  'resource:aws:secret:/demo/token',
  'resource:aws:secret:GoogleSecretsArn',
  'resource:generic:Dockerfile',
  'resource:generic:Dockerfile',
  'resource:generic:Dockerfile',
  'resource:generic:api',
  'resource:generic:api_token',
  'resource:generic:app',
  'resource:generic:db_password',
  'resource:generic:demo-chart',
  'resource:generic:helm/demo-chart/Dockerfile',
  'resource:generic:postgres',
  'resource:generic:secret:.env.production',
  'resource:generic:secret:app-db-credentials',
  'resource:generic:services/api/Dockerfile',
  'resource:k8s:_/CronJob/demo-scheduler',
  'resource:k8s:_/Ingress/demo-worker-ingress',
  'resource:k8s:_/Service/demo-worker',
  'resource:k8s:_/StatefulSet/demo-worker',
  'resource:k8s:demo-system/Deployment/demo-operator',
  'resource:k8s:demo-system/Secret/operator-certs',
  'resource:k8s:demo-system/Secret/operator-env',
  'resource:k8s:demo-system/Secret/operator-secrets',
  'resource:terraform:api_key',
  'resource:terraform:current',
  'resource:terraform:db_password',
  'resource:terraform:events',
  'resource:terraform:gcp_key',
  'resource:terraform:lambda_role',
  'resource:terraform:log_level',
  'resource:terraform:uploads',
  'resource:terraform:users',
  'resource:terraform:users_api',
  'resource:terraform:vpc',
  'resource:vercel:cron:/api/users',
  'resource:vercel:function:app/api/users/route.ts',
  'resource:vercel:project',
  'resource:vercel:rewrite:/legacy-users',
  'resource:vercel:secret:database-url',
];

describe('core-laws pre-migration runtime-resource ids still read the same', () => {
  function mintedIds(): string[] {
    const ids: string[] = [];
    for (const fixture of FIXTURES) {
      const { modules, refusals } = collectInfraModules({
        repoRoot: path.join(FIXTURE_ROOT, fixture),
      });
      expect({ fixture, refusals: refusals.map(r => r.kind) }).toEqual({ fixture, refusals: [] });
      for (const infraModule of modules) {
        for (const resource of infraModule.resources) ids.push(makeRuntimeResourceId(resource));
      }
    }
    return ids.sort();
  }

  it('mints exactly the pinned ids', () => {
    expect(mintedIds()).toEqual([...BASELINE_IDS].sort());
  });

  it('covers every namespace the built-in plugins mint into', () => {
    // Without this the list could shrink to one fixture and still pass the check above. A namespace
    // that stops appearing means its plugin stopped emitting, which is exactly the silent loss the
    // pinned list is here to catch.
    const namespaces = new Set(mintedIds().map(id => id.split(':')[1]));
    expect([...namespaces].sort()).toEqual(['aws', 'aws-lambda', 'generic', 'k8s', 'terraform', 'vercel']);
  });
});
