/**
 * semanticHints v1 schema (`zSemanticHints`), the non-JS-routes acceptance gate, and the
 * framework-general `ssr` markers populated by the TS writer.
 */
import { Project, ScriptTarget } from 'ts-morph';
import {
  SEMANTIC_HINTS_VERSION,
  zSemanticHints,
  validateSemanticHints,
} from '@repovine/plugin-sdk';
import { collectSemanticHints } from '../../../packages/plugins/source-typescript/src/semantic-hints.js';
import { frameworkHintsFromRaw } from '../../../packages/plugins/source-python/src/framework-hints.js';
import type { SemanticHints } from '@repovine/plugin-sdk';

function makeSf(source: string, fileName = '/virtual/file.tsx') {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ES2022, jsx: 2 } });
  return project.createSourceFile(fileName, source);
}

describe('SEMANTIC_HINTS_VERSION', () => {
  it('is the single schema version (not per-slot, not embedded per-object)', () => {
    expect(SEMANTIC_HINTS_VERSION).toBe('1');
  });
});

describe('zSemanticHints — built-in (trusted) output matches the schema with no loss', () => {
  it('round-trips a rich TS writer output unchanged', () => {
    const sf = makeSf(
      `'use client';
       import { z } from 'zod';
       export const schema = z.object({});
       export function App() {
         const url = process.env.NEXT_PUBLIC_API_URL;
         const secret = process.env.STRIPE_SECRET_KEY;
         return <Route path="/home" element={<Home />} />;
       }`,
      '/virtual/app/page.tsx',
    );
    const hints = collectSemanticHints(sf, 'app/page.tsx');
    expect(hints).toBeDefined();
    expect(hints?.routes?.find(route => route.declaredIn === 'layout')).toMatchObject({
      framework: 'nextjs-app',
      fileType: 'page',
    });
    const parsed = zSemanticHints.safeParse(hints);
    expect(parsed.success).toBe(true);
    // .passthrough() preserves every field the built-in emitted — zero loss.
    expect(parsed.success && parsed.data).toEqual(hints);
  });

  it('round-trips Python framework-hints output unchanged', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'fastapi',
      routes: [{ path: 'users', method: 'get', component: 'get_users' }],
    });
    expect(hints).toBeDefined();
    const parsed = zSemanticHints.safeParse(hints);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(hints);
  });
});

describe('zSemanticHints — open webFramework + forward-compatible passthrough', () => {
  it('accepts an arbitrary webFramework string without a core-type change', () => {
    const parsed = zSemanticHints.safeParse({ webFramework: 'spring' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.webFramework).toBe('spring');
  });

  it('preserves an unknown top-level slot (an interpreter reads it before core knows it)', () => {
    const value = { graphql: { resolvers: ['Query.me'] } };
    const parsed = zSemanticHints.safeParse(value);
    expect(parsed.success).toBe(true);
    expect(parsed.success && (parsed.data as Record<string, unknown>).graphql).toEqual({ resolvers: ['Query.me'] });
  });
});

describe('zSemanticHints — drops structurally-broken known slots', () => {
  it.each([
    ['routes not an array', { routes: 'oops' }],
    ['envVars not strings', { envVars: [1, 2] }],
    ['ssr not an object', { ssr: 'server' }],
    ['route missing component', { routes: [{ path: '/x' }] }],
    ['runtimeAction unknown action', { runtimeActions: [{ action: 'fs.write' }] }],
  ])('rejects %s', (_label, value) => {
    expect(zSemanticHints.safeParse(value).success).toBe(false);
    expect(validateSemanticHints(value).ok).toBe(false);
  });
});

describe('acceptance — non-JS/Python routes surface with no core-type change', () => {
  it('a synthetic Spring route (webFramework + routes + neutral ssr) passes the schema and round-trips', () => {
    // Emulates what a future Spring source plugin would emit: framework specifics normalized to the
    // framework-general `routes` slot, an open `webFramework` string, and the neutral `runsOn`
    // marker — none of which required editing the core SemanticHints type.
    const springHints: SemanticHints = {
      hasRoutes: true,
      webFramework: 'spring',
      routes: [
        { path: '/users/{id}', component: 'UserController.getUser', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'GET' },
      ],
      ssr: { runsOn: 'server' },
    };
    const parsed = zSemanticHints.safeParse(springHints);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).toEqual(springHints);

    // And it passes semanticHints v1 validation intact.
    const v = validateSemanticHints(springHints);
    expect(v.ok).toBe(true);
    const out = v.ok ? v.value : undefined;
    expect(out?.webFramework).toBe('spring');
    expect(out?.routes?.[0].method).toBe('GET');
    expect(out?.ssr?.runsOn).toBe('server');
  });
});

describe('TS writer derives framework-general ssr markers (additive, useServer/useClient intact)', () => {
  it("'use server' → runsOn 'server', no dataLoader", () => {
    const h = collectSemanticHints(makeSf(`'use server';\nexport async function doIt() {}`));
    expect(h?.ssr?.useServer).toBe(true);
    expect(h?.ssr?.runsOn).toBe('server');
    expect(h?.ssr?.dataLoader).toBeUndefined();
  });

  it("'use client' → runsOn 'client'", () => {
    const h = collectSemanticHints(makeSf(`'use client';\nexport function Comp() { return null; }`));
    expect(h?.ssr?.useClient).toBe(true);
    expect(h?.ssr?.runsOn).toBe('client');
  });

  it('getServerSideProps export → dataLoader true, runsOn omitted (no directive)', () => {
    const h = collectSemanticHints(makeSf(`export async function getServerSideProps() { return { props: {} }; }`));
    expect(h?.ssr?.getServerSideProps).toBe(true);
    expect(h?.ssr?.dataLoader).toBe(true);
    expect(h?.ssr?.runsOn).toBeUndefined();
  });

  it('action-only export is a mutation, not a data loader → dataLoader omitted', () => {
    const h = collectSemanticHints(makeSf(`export const action = async () => ({});`));
    expect(h?.ssr?.action).toBe(true);
    expect(h?.ssr?.dataLoader).toBeUndefined();
  });
});
