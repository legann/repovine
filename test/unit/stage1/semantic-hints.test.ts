/**
 * Tests for SSR markers detection in semantic-hints.
 */
import { Project, ScriptTarget } from 'ts-morph';
import { collectSemanticHints } from '../../../src/source-plugins/typescript/semantic-hints.js';
import { extractTypeScriptFromSfc } from '../../../src/source-plugins/typescript/sfc-extractor.js';

function makeSf(source: string, fileName = '/virtual/file.tsx') {
  const project = new Project({ useInMemoryFileSystem: true, compilerOptions: { target: ScriptTarget.ES2022, jsx: 2 } });
  return project.createSourceFile(fileName, source);
}

describe("SSR markers — 'use server' / 'use client' directives", () => {
  it("detects 'use server' as the first statement", () => {
    const sf = makeSf(`'use server';\nexport async function doIt() {}`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.useServer).toBe(true);
    expect(h?.ssr?.useClient).toBeUndefined();
  });

  it("detects 'use client'", () => {
    const sf = makeSf(`'use client';\nexport function Comp() { return null; }`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.useClient).toBe(true);
  });

  it("tolerates BOM, comments, and shebang before directive", () => {
    const sf = makeSf(`#!/usr/bin/env node\n// banner\n/* multi */\n'use server';\nexport {};`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.useServer).toBe(true);
  });

  it("ignores directive when it is not the first statement", () => {
    const sf = makeSf(`const x = 1;\n'use server';\nexport {};`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.useServer).toBeUndefined();
  });

  it("accepts both single- and double-quoted directives", () => {
    expect(collectSemanticHints(makeSf(`"use server";`))?.ssr?.useServer).toBe(true);
    expect(collectSemanticHints(makeSf(`'use server';`))?.ssr?.useServer).toBe(true);
  });
});

describe('SSR markers — SSR export names', () => {
  it('detects getServerSideProps export (Next.js Pages Router)', () => {
    const sf = makeSf(`export async function getServerSideProps() { return { props: {} }; }`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.getServerSideProps).toBe(true);
  });

  it('detects loader and action exports', () => {
    const sf = makeSf(`export const loader = async () => ({}); export const action = async () => ({});`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.loader).toBe(true);
    expect(h?.ssr?.action).toBe(true);
  });

  it('detects getStaticProps and getInitialProps', () => {
    const sf = makeSf(`export const getStaticProps = async () => ({ props: {} });`);
    expect(collectSemanticHints(sf)?.ssr?.getStaticProps).toBe(true);

    const sf2 = makeSf(`export const getInitialProps = () => ({});`);
    expect(collectSemanticHints(sf2)?.ssr?.getInitialProps).toBe(true);
  });

  it('ignores non-SSR exports', () => {
    const sf = makeSf(`export function add(a: number, b: number) { return a + b; }`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr).toBeUndefined();
  });
});

describe('SSR markers — Qwik macros', () => {
  it('detects routeLoader$ usage', () => {
    const sf = makeSf(`import { routeLoader$ } from '@builder.io/qwik-city';\nexport const useUsers = routeLoader$(async () => [] );`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.qwikServer).toBe(true);
  });

  it('detects server$ macro', () => {
    const sf = makeSf(`import { server$ } from '@builder.io/qwik-city';\nexport const fn = server$(async () => 'ok');`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.qwikServer).toBe(true);
  });
});

describe('SSR markers — combination', () => {
  it('combines directive + export markers', () => {
    const sf = makeSf(`'use server';\nexport const loader = async () => ({});`);
    const h = collectSemanticHints(sf);
    expect(h?.ssr?.useServer).toBe(true);
    expect(h?.ssr?.loader).toBe(true);
  });
});


describe('file-based routes', () => {
  it('detects Next.js App Router routes', () => {
    const sf = makeSf(`export default function Page() { return null; }`, '/virtual/app/users/[id]/page.tsx');
    const h = collectSemanticHints(sf, 'app/users/[id]/page.tsx');
    expect(h?.routes).toContainEqual({
      path: '/users/[id]',
      component: '(file-route)',
      source: 'file',
      kind: 'frontend',
      framework: 'nextjs-app',
      fileType: 'page',
    });
  });

  it('detects Next.js App Router routes under src/app', () => {
    const sf = makeSf(`export default function AgentsPage() { return null; }`, '/virtual/src/app/agents/page.tsx');
    const h = collectSemanticHints(sf, 'src/app/agents/page.tsx');
    expect(h?.routes).toContainEqual({
      path: '/agents',
      component: '(file-route)',
      source: 'file',
      kind: 'frontend',
      framework: 'nextjs-app',
      fileType: 'page',
    });
  });

  it('emits one Next.js route handler entry per exported HTTP method', () => {
    const sf = makeSf(
      `export async function GET() {}\nexport const POST = async () => {};`,
      '/virtual/app/api/users/route.ts',
    );
    const h = collectSemanticHints(sf, 'app/api/users/route.ts');
    expect(h?.routes).toEqual([
      {
        path: '/api/users',
        component: '(file-route)',
        source: 'file',
        kind: 'api',
        method: 'GET',
        framework: 'nextjs-app',
        fileType: 'route',
      },
      {
        path: '/api/users',
        component: '(file-route)',
        source: 'file',
        kind: 'api',
        method: 'POST',
        framework: 'nextjs-app',
        fileType: 'route',
      },
    ]);
  });

  it('does not expose Next.js App Router support slots as public routes', () => {
    const sf = makeSf(`export default function Layout() { return null; }`, '/virtual/app/users/layout.tsx');
    const h = collectSemanticHints(sf, 'app/users/layout.tsx');
    expect(h?.routes ?? []).toEqual([]);
  });

  it('detects Next.js App Router routes in monorepo packages', () => {
    const sf = makeSf(`export default function Page() { return null; }`, '/virtual/apps/web/app/dashboard/page.tsx');
    const h = collectSemanticHints(sf, 'apps/web/app/dashboard/page.tsx');
    expect(h?.routes).toContainEqual({
      path: '/dashboard',
      component: '(file-route)',
      source: 'file',
      kind: 'frontend',
      framework: 'nextjs-app',
      fileType: 'page',
    });
  });

  it('does not treat Sentry-shaped static/app/views/.../pages as Next.js Pages Router', () => {
    const sf = makeSf(`export default function AuthPage() { return null; }`, '/virtual/static/app/views/authV2/pages/index.tsx');
    const h = collectSemanticHints(sf, 'static/app/views/authV2/pages/index.tsx');
    expect(h?.routes ?? []).toEqual([]);
  });

  it('does not treat static/app/views/.../page.tsx as Next.js App Router', () => {
    const sf = makeSf(`export default function IssuePage() { return null; }`, '/virtual/static/app/views/issue/page.tsx');
    const h = collectSemanticHints(sf, 'static/app/views/issue/page.tsx');
    expect(h?.routes ?? []).toEqual([]);
  });

  it('does not treat nested Angular user pages as Next.js Pages Router', () => {
    const sf = makeSf(`export class UserListComponent {}`, '/virtual/src/app/users/pages/user-list/user-list.component.ts');
    const h = collectSemanticHints(sf, 'src/app/users/pages/user-list/user-list.component.ts');
    expect(h?.routes ?? []).toEqual([]);
  });

  it('tags React Router JSX routes with react-router framework metadata', () => {
    const sf = makeSf(`
      import { Route } from 'react-router-dom';

      export function HomeRoutes() {
        return <Route path="/" element={<div>Home</div>} />;
      }
    `, '/virtual/static/app/views/home/index.tsx');
    const h = collectSemanticHints(sf, 'static/app/views/home/index.tsx');
    expect(h?.webFramework).toBe('react-router');
    expect(h?.routes).toContainEqual({
      path: '/',
      component: 'div',
      source: 'jsx',
      kind: 'frontend',
      framework: 'react-router',
    });
  });

  it('extracts React Router RouteObject config routes', () => {
    const sf = makeSf(`
      import type {RouteObject} from 'react-router-dom';
      import {makeLazyloadComponent as make} from 'app/makeLazyloadComponent';

      export const authV2Routes: RouteObject = {
        path: 'auth-v2/',
        children: [
          {
            index: true,
            component: make(() => import('app/views/authV2/pages/index')),
          },
        ],
      };

      export function buildRoutes(): RouteObject[] {
        return [
          {
            path: '/accept/:orgId/:memberId/:token/',
            component: make(() => import('app/views/acceptOrganizationInvite')),
          },
          {
            path: '/account/',
            redirectTo: '/settings/account/details/',
          },
        ];
      }
    `, '/virtual/static/app/router/routes.tsx');
    const h = collectSemanticHints(sf, 'static/app/router/routes.tsx');
    expect(h?.webFramework).toBe('react-router');
    expect(h?.routes).toEqual(expect.arrayContaining([
      {
        path: 'auth-v2/',
        component: '(route-config)',
        source: 'config',
        kind: 'frontend',
        framework: 'react-router',
        fileType: 'route',
      },
      {
        path: '/',
        component: 'make',
        source: 'config',
        kind: 'frontend',
        framework: 'react-router',
        fileType: 'index',
      },
      {
        path: '/accept/:orgId/:memberId/:token/',
        component: 'make',
        source: 'config',
        kind: 'frontend',
        framework: 'react-router',
        fileType: 'route',
      },
      {
        path: '/account/',
        component: '(redirect)',
        source: 'config',
        kind: 'frontend',
        framework: 'react-router',
        fileType: 'route',
      },
    ]));
  });

  it('does not treat static/app/stories/layout.tsx as Next.js App Router', () => {
    const sf = makeSf(`export function StoryLayout() { return null; }`, '/virtual/static/app/stories/layout.tsx');
    const h = collectSemanticHints(sf, 'static/app/stories/layout.tsx');
    expect(h?.routes ?? []).toEqual([]);
  });

  it('detects SvelteKit server routes', () => {
    const sf = makeSf(`export const GET = () => new Response('ok');`, '/virtual/src/routes/api/users/+server.ts');
    const h = collectSemanticHints(sf, 'src/routes/api/users/+server.ts');
    expect(h?.routes).toContainEqual({
      path: '/api/users',
      component: '(file-route)',
      source: 'file',
      kind: 'api',
      method: 'GET',
      framework: 'sveltekit',
      fileType: 'server',
    });
  });

  it('only exposes SvelteKit +page.svelte as a page route', () => {
    const page = collectSemanticHints(
      makeSf(`export default class Page {}`, '/virtual/src/routes/dashboard/+page.svelte.ts'),
      'src/routes/dashboard/+page.svelte',
    );
    const load = collectSemanticHints(
      makeSf(`export const load = () => ({});`, '/virtual/src/routes/dashboard/+page.ts'),
      'src/routes/dashboard/+page.ts',
    );
    expect(page?.routes).toEqual([{
      path: '/dashboard',
      component: '(file-route)',
      source: 'file',
      kind: 'frontend',
      framework: 'sveltekit',
      fileType: 'page',
    }]);
    expect(load?.routes ?? []).toEqual([]);
  });

  it('strips a Nuxt method suffix from the URL and preserves the method', () => {
    const h = collectSemanticHints(
      makeSf(`export default defineEventHandler(() => ({}));`, '/virtual/server/api/users/[id].get.ts'),
      'server/api/users/[id].get.ts',
    );
    expect(h?.routes).toEqual([{
      path: '/api/users/[id]',
      component: '(file-route)',
      source: 'file',
      kind: 'api',
      method: 'GET',
      framework: 'nuxt',
      fileType: 'server-api',
    }]);
  });

  // `src/server/api.ts` is an ordinary Express/Nest module, not a Nuxt route: the segment tail after
  // `server/api` is empty. The suffix-stripping branch reads that tail's last element, so an empty
  // tail must return before it, not index into nothing.
  it('treats a bare server/api module as no route rather than throwing', () => {
    const h = collectSemanticHints(
      makeSf(`export function createServer() { return null; }`, '/virtual/src/server/api.ts'),
      'src/server/api.ts',
    );
    expect(h?.routes ?? []).toEqual([]);
  });

  it('does not expose a TanStack root layout as a public route', () => {
    const h = collectSemanticHints(makeSf(`
      import { createRootRoute, createRoute } from '@tanstack/react-router';
      const rootRoute = createRootRoute({ component: RootLayout });
      export const settingsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: '/settings',
        component: SettingsPage,
      });
    `));
    expect(h?.routes).toEqual([{
      path: '/settings',
      component: 'SettingsPage',
      source: 'ast',
      kind: 'frontend',
      framework: 'tanstack-router',
    }]);
  });
});

describe('framework API routes', () => {
  it('detects Fastify shorthand HTTP route calls', () => {
    const sf = makeSf(`
      import type { FastifyInstance } from 'fastify';

      export default async function environmentRoutes(fastify: FastifyInstance) {
        fastify.get('/api/environments', async () => []);
        fastify.post('/api/environments', async () => ({ ok: true }));
        fastify.patch('/api/environments/:id', async () => ({ ok: true }));
        fastify.delete('/api/environments/:id', async () => ({ ok: true }));
      }
    `, '/virtual/src/routes/environment.ts');
    const h = collectSemanticHints(sf, 'src/routes/environment.ts');
    expect(h?.webFramework).toBe('fastify');
    expect(h?.routes).toEqual(expect.arrayContaining([
      {
        path: '/api/environments',
        component: 'fastify.get',
        source: 'ast',
        kind: 'api',
        method: 'GET',
      },
      {
        path: '/api/environments',
        component: 'fastify.post',
        source: 'ast',
        kind: 'api',
        method: 'POST',
      },
      {
        path: '/api/environments/:id',
        component: 'fastify.patch',
        source: 'ast',
        kind: 'api',
        method: 'PATCH',
      },
      {
        path: '/api/environments/:id',
        component: 'fastify.delete',
        source: 'ast',
        kind: 'api',
        method: 'DELETE',
      },
    ]));
  });

  it('detects Fastify route object calls', () => {
    const sf = makeSf(`
      import Fastify from 'fastify';

      const app = Fastify();
      app.route({
        method: 'POST',
        url: '/api/tasks',
        handler: async () => ({ ok: true }),
      });
    `, '/virtual/src/server.ts');
    const h = collectSemanticHints(sf, 'src/server.ts');
    expect(h?.webFramework).toBe('fastify');
    expect(h?.routes).toContainEqual({
      path: '/api/tasks',
      component: 'app.route',
      source: 'ast',
      kind: 'api',
      method: 'POST',
    });
  });
});

describe('runtime actions', () => {
  it('detects SQS publish intent near an env var binding', () => {
    const sf = makeSf(`
      import { SendMessageCommand } from '@aws-sdk/client-sqs';
      export async function handler() {
        return client.send(new SendMessageCommand({ QueueUrl: process.env.USER_QUEUE_URL }));
      }
    `);
    const h = collectSemanticHints(sf);
    expect(h?.runtimeActions?.[0]).toMatchObject({ action: 'sqs.sendMessage', envVar: 'USER_QUEUE_URL' });
  });

  it('resolves QueueUrl variable aliases back to process.env names', () => {
    const sf = makeSf(`
      import { SendMessageCommand } from '@aws-sdk/client-sqs';
      export async function handler() {
        const webhookQueueUrl = process.env.MONDAY_QUEUE_URL;
        return client.send(new SendMessageCommand({ QueueUrl: webhookQueueUrl }));
      }
    `);
    const h = collectSemanticHints(sf);
    expect(h?.runtimeActions?.[0]).toMatchObject({ action: 'sqs.sendMessage', envVar: 'MONDAY_QUEUE_URL' });
  });

  it('detects SQS batch sends', () => {
    const sf = makeSf(`
      import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
      const QUEUE_URL = process.env.BATCH_QUEUE_URL || '';
      export async function handler() {
        return client.send(new SendMessageBatchCommand({ QueueUrl: QUEUE_URL, Entries: [] }));
      }
    `);
    const h = collectSemanticHints(sf);
    expect(h?.runtimeActions?.[0]).toMatchObject({ action: 'sqs.sendMessage', envVar: 'BATCH_QUEUE_URL' });
  });

  it('ignores runtime action tokens inside type literal unions', () => {
    const sf = makeSf(`
      export interface RuntimeAction {
        action: 'sqs.sendMessage' | 'sns.publish' | 'eventbridge.putEvents' | 'lambda.invoke';
      }
    `, '/virtual/src/types.ts');
    const h = collectSemanticHints(sf);
    expect(h?.runtimeActions).toBeUndefined();
  });

  it('still detects SNS publish in executable code', () => {
    const sf = makeSf(`
      export async function handler() {
        await sns.publish({ Message: 'hi' });
      }
    `);
    const h = collectSemanticHints(sf);
    expect(h?.runtimeActions?.some(a => a.action === 'sns.publish')).toBe(true);
  });

  it('ignores invoke tokens in block comments', () => {
    const sf = makeSf(`
      /**
       * When absent, the parser is invoked for every infra candidate file.
       */
      export interface Foo {}
    `);
    expect(collectSemanticHints(sf)?.runtimeActions).toBeUndefined();
  });

  it('ignores runtime action tokens when JSDoc apostrophes would corrupt quote tracking', () => {
    const sf = makeSf(`
      /**
       * Union of all registered parsers' fileMatch entries.
       */
      export interface RuntimeAction {
        action: 'sqs.sendMessage' | 'sns.publish' | 'eventbridge.putEvents' | 'lambda.invoke';
      }
    `, '/virtual/src/types.ts');
    expect(collectSemanticHints(sf)?.runtimeActions).toBeUndefined();
  });
});

describe('security hints', () => {
  it('classifies secret-like and public env vars without reading values', () => {
    const sf = makeSf(`
      export const secret = process.env.STRIPE_SECRET_KEY;
      export const publicUrl = process.env.NEXT_PUBLIC_API_URL;
    `);
    const h = collectSemanticHints(sf);
    expect(h?.security).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'secret-env', name: 'STRIPE_SECRET_KEY' }),
      expect.objectContaining({ kind: 'public-env', name: 'NEXT_PUBLIC_API_URL' }),
    ]));
  });

  it('tolerates template-literal import specifiers without throwing', () => {
    const sf = makeSf(`
      import { z } from \`zod\`;
      export const schema = z.object({ ok: z.boolean() });
    `);
    expect(() => collectSemanticHints(sf)).not.toThrow();
    expect(collectSemanticHints(sf)?.security).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'validation', name: 'zod' }),
    ]));
  });

  it('detects validation, authz, sensitive browser storage, and source disclosure surfaces', () => {
    const sf = makeSf(`
      import { z } from 'zod';
      import { authorize } from './permissions/policy';
      const schema = z.object({ token: z.string() });

      export async function inspectNode() {
        authorize('admin');
        schema.safeParse({});
        localStorage.setItem('access_token', 'token');
        return fs.readFile(filePath, 'utf-8');
      }
    `, '/virtual/src/mcp/handlers.ts');
    const h = collectSemanticHints(sf, 'src/mcp/handlers.ts');
    expect(h?.security).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'validation' }),
      expect.objectContaining({ kind: 'authz' }),
      expect.objectContaining({ kind: 'browser-storage-sensitive', target: 'access_token' }),
      expect.objectContaining({ kind: 'source-disclosure' }),
    ]));
  });
});

describe('frontend hints', () => {
  it('collects React effects, data access, navigation, timers, and state', () => {
    const sf = makeSf(`
      import { useEffect, useState } from 'react';
      import { useNavigate } from 'react-router-dom';

      export function OrdersPage() {
        const [orders, setOrders] = useState([]);
        const navigate = useNavigate();
        useEffect(() => {
          fetch('/api/orders');
          setTimeout(() => navigate('/done'), 100);
          window.addEventListener('focus', () => {});
        }, []);
        return <div>{orders.length}</div>;
      }
    `, '/virtual/src/features/orders/OrdersPage.tsx');

    const h = collectSemanticHints(sf, 'src/features/orders/OrdersPage.tsx');
    expect(h?.ui?.framework).toBe('react');
    expect(h?.ui?.state?.some(item => item.kind === 'react-state')).toBe(true);
    expect(h?.ui?.dataAccess?.[0]).toMatchObject({ kind: 'fetch', target: '/api/orders' });
    expect(h?.ui?.navigation?.[0]).toMatchObject({ kind: 'navigate', target: '/done' });
    expect(h?.ui?.timers?.[0]).toMatchObject({ kind: 'timeout' });
    expect(h?.ui?.subscriptions?.[0]).toMatchObject({ kind: 'event-listener' });
    expect(h?.ui?.lifecycleEffects?.[0]).toMatchObject({
      kind: 'react-effect',
      dataAccessCount: 1,
      navigationCount: 1,
      timerCount: 1,
      subscriptionCount: 1,
    });
  });

  it('collects React component prop-flow hints', () => {
    const sf = makeSf(`
      import { useEffect, useState } from 'react';
      import { OrderForm } from './OrderForm';
      import { AuditPanel } from './AuditPanel';
      import { SummaryCard } from './SummaryCard';

      export function OrdersContainer({ order, selectedOrder, isLoading, onSubmit, onCancel, setDraftMode, errorMessage }: Props) {
        const [draft, setDraft] = useState(order);
        useEffect(() => {
          validateOrder(draft);
        }, [draft]);
        return (
          <>
            <OrderForm order={order} selectedOrder={selectedOrder} onSubmit={(payload) => onSubmit(payload)} setDraftMode={setDraftMode} />
            <AuditPanel order={order} onCancel={onCancel} errorMessage={errorMessage} />
            <SummaryCard order={order} isLoading={isLoading} />
          </>
        );
      }
    `, '/virtual/src/features/orders/OrdersContainer.tsx');

    const h = collectSemanticHints(sf, 'src/features/orders/OrdersContainer.tsx');
    const component = h?.ui?.components?.find(item => item.name === 'OrdersContainer');
    expect(component).toBeDefined();
    expect(component?.props.map(prop => prop.name)).toEqual(expect.arrayContaining(['order', 'onSubmit', 'onCancel', 'setDraftMode', 'isLoading']));
    expect(component?.props.find(prop => prop.name === 'onSubmit')).toMatchObject({ kind: 'callback' });
    expect(component?.props.find(prop => prop.name === 'setDraftMode')).toMatchObject({ kind: 'setter' });
    expect(component?.childComponents.map(child => child.componentName)).toEqual(expect.arrayContaining(['OrderForm', 'AuditPanel', 'SummaryCard']));
    expect(component?.childComponents.flatMap(child => child.forwardedProps)).toEqual(expect.arrayContaining(['order', 'onSubmit', 'onCancel', 'setDraftMode']));
    expect(component?.localSignals.effects).toBe(1);
    expect(component?.localSignals.localState).toBe(1);
    expect(component?.localSignals.validationOrMapping).toBeGreaterThanOrEqual(1);
  });

  it('collects Vue/Nuxt lifecycle and query hints from framework-neutral fields', () => {
    const sf = makeSf(`
      import { watchEffect, ref } from 'vue';
      const product = ref(null);
      watchEffect(() => {
        useFetch('/api/products');
      });
    `, '/virtual/pages/products.vue.ts');

    const h = collectSemanticHints(sf, 'pages/products.vue');
    expect(h?.ui?.framework).toBe('nuxt');
    expect(h?.ui?.state?.some(item => item.kind === 'vue-ref')).toBe(true);
    expect(h?.ui?.lifecycleEffects?.[0]).toMatchObject({ kind: 'vue-watch', dataAccessCount: 1 });
    expect(h?.ui?.dataAccess?.[0]).toMatchObject({ kind: 'query', target: '/api/products' });
  });

  it('collects Vue component prop-flow hints from SFC script and template', () => {
    const sfc = `
      <template>
        <OrderForm :order="order" :is-loading="isLoading" @submit="onSubmit" v-bind="extraProps" />
        <AuditPanel :order="order" @cancel="onCancel" />
      </template>
      <script setup lang="ts">
        import { ref, watchEffect } from 'vue';
        import OrderForm from './OrderForm.vue';
        import AuditPanel from './AuditPanel.vue';
        const { order, isLoading, onSubmit, onCancel, extraProps } = defineProps<{
          order: Order;
          isLoading: boolean;
          onSubmit: (payload: Order) => void;
          onCancel: () => void;
          extraProps: Record<string, unknown>;
        }>();
        const draft = ref(order);
        watchEffect(() => validateOrder(draft.value));
      </script>
    `;
    const extracted = extractTypeScriptFromSfc('/virtual/OrdersContainer.vue', sfc);
    const sf = makeSf(extracted?.ts ?? '', '/virtual/OrdersContainer.vue.ts');

    const h = collectSemanticHints(sf, 'src/features/orders/OrdersContainer.vue');
    const component = h?.ui?.components?.find(item => item.name === 'OrdersContainer');
    expect(component).toBeDefined();
    expect(component?.framework).toBe('vue');
    expect(component?.props.map(prop => prop.name)).toEqual(expect.arrayContaining(['order', 'isLoading', 'onSubmit', 'onCancel', 'extraProps']));
    expect(component?.childComponents.map(child => child.componentName)).toEqual(expect.arrayContaining(['OrderForm', 'AuditPanel']));
    expect(component?.childComponents.flatMap(child => child.forwardedProps)).toEqual(expect.arrayContaining(['order', 'isLoading', 'onSubmit', 'onCancel', 'extraProps']));
    expect(component?.childComponents.flatMap(child => child.spreadProps)).toContain('extraProps');
    expect(component?.localSignals.localState).toBe(1);
    expect(component?.localSignals.effects).toBe(1);
    expect(component?.localSignals.validationOrMapping).toBeGreaterThanOrEqual(1);
  });

  it('collects Svelte component prop-flow hints from SFC exports and template', () => {
    const sfc = `
      <script lang="ts">
        import { onMount } from 'svelte';
        import { writable } from 'svelte/store';
        export let order: Order;
        export let isLoading = false;
        export let onSubmit: (payload: Order) => void;
        export let onCancel: () => void;
        const draft = writable(order);
        onMount(() => validateOrder(order));
      </script>
      <OrderForm {order} on:submit={onSubmit} />
      <OrderToolbar isLoading={isLoading} on:cancel={onCancel} />
    `;
    const extracted = extractTypeScriptFromSfc('/virtual/OrdersContainer.svelte', sfc);
    const sf = makeSf(extracted?.ts ?? '', '/virtual/OrdersContainer.svelte.ts');

    const h = collectSemanticHints(sf, 'src/features/orders/OrdersContainer.svelte');
    const component = h?.ui?.components?.find(item => item.name === 'OrdersContainer');
    expect(component).toBeDefined();
    expect(component?.framework).toBe('svelte');
    expect(component?.props.map(prop => prop.name)).toEqual(expect.arrayContaining(['order', 'isLoading', 'onSubmit', 'onCancel']));
    expect(component?.childComponents.map(child => child.componentName)).toEqual(expect.arrayContaining(['OrderForm', 'OrderToolbar']));
    expect(component?.childComponents.flatMap(child => child.forwardedProps)).toEqual(expect.arrayContaining(['order', 'isLoading', 'onSubmit', 'onCancel']));
    expect(component?.localSignals.localState).toBe(1);
    expect(component?.localSignals.effects).toBe(1);
    expect(component?.localSignals.validationOrMapping).toBeGreaterThanOrEqual(1);
  });

  it('collects Angular component prop-flow hints from inputs, outputs, and inline template', () => {
    const sf = makeSf(`
      import { Component, Input, Output, EventEmitter } from '@angular/core';

      @Component({
        selector: 'orders-container',
        template: \`
          <order-form [order]="order" [isLoading]="isLoading" (submit)="submit.emit($event)"></order-form>
          <order-toolbar (cancel)="cancel.emit()"></order-toolbar>
        \`
      })
      export class OrdersContainerComponent {
        @Input() order!: Order;
        @Input() isLoading = false;
        @Output() submit = new EventEmitter<Order>();
        @Output() cancel = new EventEmitter<void>();

        ngOnInit() {
          validateOrder(this.order);
        }
      }
    `, '/virtual/src/app/orders/orders-container.component.ts');

    const h = collectSemanticHints(sf, 'src/app/orders/orders-container.component.ts');
    const component = h?.ui?.components?.find(item => item.name === 'OrdersContainerComponent');
    expect(component).toBeDefined();
    expect(component?.framework).toBe('angular');
    expect(component?.props.map(prop => prop.name)).toEqual(expect.arrayContaining(['order', 'isLoading', 'submit', 'cancel']));
    expect(component?.props.find(prop => prop.name === 'submit')).toMatchObject({ kind: 'callback' });
    expect(component?.childComponents.map(child => child.componentName)).toEqual(expect.arrayContaining(['OrderForm', 'OrderToolbar']));
    expect(component?.childComponents.flatMap(child => child.forwardedProps)).toEqual(expect.arrayContaining(['order', 'isLoading', 'submit', 'cancel']));
    expect(component?.localSignals.effects).toBe(1);
    expect(component?.localSignals.validationOrMapping).toBeGreaterThanOrEqual(1);
  });
});
