import { asRepoRelPath } from '@repovine/plugin-sdk';
import { asHostPath, asPkgRelPath } from '@repovine/plugin-sdk';
import { describe, expect, it } from '@jest/globals';
import { Project, ScriptTarget } from 'ts-morph';
import { createEmptyGraph } from '../../../src/graph/index.js';
import { collectUiRouteEntrypoints } from '../../../src/interpreters/ui-entrypoints/entrypoints.js';
import { collectBackendRouteEntrypoints } from '../../../src/interpreters/server-entrypoints/entrypoints.js';
import type { InterpreterEntrypointContext } from '../../../src/interpreter/types.js';
import { collectSemanticHints } from '../../../packages/plugins/source-typescript/src/semantic-hints.js';
import type { ModuleInfo, RepositoryFactsSnapshot } from '../../../src/types.js';

function makeSf(source: string, fileName: string) {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { target: ScriptTarget.ES2022 },
  });
  return project.createSourceFile(fileName, source);
}

function mod(id: string, semanticHints?: ModuleInfo['semanticHints']): ModuleInfo {
  return {
    id,
    packageName: 'angular-nest-fixture',
    absPath: asHostPath(`/repo/${id}.ts`),
    pkgRelPath: asPkgRelPath(`${id}.ts`),
    contentHash: id,
    imports: [],
    exports: [],
    sourcePluginId: 'typescript',
    semanticHints,
  };
}

function ctxFor(modules: ModuleInfo[]): InterpreterEntrypointContext {
  const snapshot: RepositoryFactsSnapshot = {
    repoRoot: '/repo',
    timestamp: '2026-06-18T00:00:00.000Z',
    packages: [{ name: 'angular-nest-fixture', repoRelDir: asRepoRelPath('.'), sourcePluginId: 'typescript' }],
    modules,
  };
  return {
    graph: createEmptyGraph(),
    snapshot,
    modulesById: new Map(modules.map(m => [m.id, m])),
    sourcePluginIds: ['typescript'],
    log: () => undefined,
  };
}

describe('Angular RouterModule routes', () => {
  it('extracts a typed Routes const with nesting, lazy loadChildren, and a wildcard', () => {
    const sf = makeSf(`
      import { Routes, RouterModule } from '@angular/router';
      const routes: Routes = [
        { path: '', component: HomeComponent },
        {
          path: 'users',
          children: [
            { path: '', component: UserListComponent },
            { path: ':id', component: UserDetailComponent },
          ],
        },
        { path: 'admin', loadChildren: () => import('./admin/admin.module').then(m => m.AdminModule) },
        { path: '', redirectTo: 'home', pathMatch: 'full' },
        { path: '**', component: NotFoundComponent },
      ];
      export class AppRoutingModule {}
    `, '/virtual/src/app/app-routing.module.ts');

    const h = collectSemanticHints(sf, 'src/app/app-routing.module.ts');
    expect(h?.routes).toEqual([
      { path: '/', component: 'HomeComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
      { path: '/users', component: 'UserListComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
      { path: '/users/:id', component: 'UserDetailComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
      { path: '/admin', component: '(lazy)', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
      { path: '/**', component: 'NotFoundComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
    ]);
    // Angular never claims the module-level webFramework slot (see collectSemanticHints).
    expect(h?.webFramework).toBeUndefined();
  });

  it('emits a layout route plus its children when the parent itself has a component', () => {
    const sf = makeSf(`
      import { Routes } from '@angular/router';
      export const routes: Routes = [
        { path: 'dash', component: DashLayoutComponent, children: [
          { path: 'stats', component: StatsComponent },
        ] },
      ];
    `, '/virtual/src/app/dash.routes.ts');
    const h = collectSemanticHints(sf, 'src/app/dash.routes.ts');
    expect(h?.routes).toEqual([
      { path: '/dash', component: 'DashLayoutComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
      { path: '/dash/stats', component: 'StatsComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
    ]);
  });

  it('reads an inline RouterModule.forRoot([...]) array', () => {
    const sf = makeSf(`
      import { RouterModule } from '@angular/router';
      @NgModule({ imports: [RouterModule.forRoot([{ path: 'login', component: LoginComponent }])] })
      export class AppModule {}
    `, '/virtual/src/app/app.module.ts');
    const h = collectSemanticHints(sf, 'src/app/app.module.ts');
    expect(h?.routes).toEqual([
      { path: '/login', component: 'LoginComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
    ]);
  });

  it('does not double-count a typed const that is also handed to forChild', () => {
    const sf = makeSf(`
      import { Routes, RouterModule } from '@angular/router';
      const routes: Routes = [{ path: 'feature', component: FeatureComponent }];
      @NgModule({ imports: [RouterModule.forChild(routes)] })
      export class FeatureModule {}
    `, '/virtual/src/app/feature/feature.module.ts');
    const h = collectSemanticHints(sf, 'src/app/feature/feature.module.ts');
    expect(h?.routes).toEqual([
      { path: '/feature', component: 'FeatureComponent', declaredIn: 'code', syntax: 'call', kind: 'frontend', framework: 'angular' },
    ]);
  });

  it('ignores route-shaped arrays when @angular/router is not imported', () => {
    const sf = makeSf(`
      const routes = [{ path: 'x', component: X }];
      export class NotAngular {}
    `, '/virtual/src/app/not-angular.ts');
    expect(collectSemanticHints(sf, 'src/app/not-angular.ts')?.routes ?? []).toEqual([]);
  });

  it('projects Angular routes into ui entrypoints with the angular slot', () => {
    const hints = collectSemanticHints(
      makeSf(`
        import { Routes } from '@angular/router';
        const routes: Routes = [{ path: 'users', component: UsersComponent }];
      `, '/virtual/src/app/app-routing.module.ts'),
      'src/app/app-routing.module.ts',
    );
    const entries = collectUiRouteEntrypoints(ctxFor([mod('src/app/app-routing.module', hints)]));
    expect(entries).toEqual([
      {
        __repovineSlot: 'angular-route',
        id: 'entrypoint:route:src/app/app-routing.module:/users',
        kind: 'route',
        layer: 'frontend',
        path: '/users',
        component: 'UsersComponent',
        moduleId: 'src/app/app-routing.module',
        source: 'angular',
        webFramework: 'angular',
      },
    ]);
  });
});

describe('NestJS @Controller routes', () => {
  it('extracts controller base path joined with method decorator subpaths', () => {
    const sf = makeSf(`
      import { Controller, Get, Post, Patch } from '@nestjs/common';
      @Controller('users')
      export class UsersController {
        @Get()
        findAll() {}
        @Get(':id')
        findOne() {}
        @Post()
        create() {}
        @Patch(':id')
        update() {}
      }
    `, '/virtual/src/users/users.controller.ts');
    const h = collectSemanticHints(sf, 'src/users/users.controller.ts');
    expect(h?.webFramework).toBe('nestjs');
    expect(h?.routes).toEqual([
      { path: '/users', component: 'UsersController.findAll', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'GET', framework: 'nestjs' },
      { path: '/users/:id', component: 'UsersController.findOne', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'GET', framework: 'nestjs' },
      { path: '/users', component: 'UsersController.create', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'POST', framework: 'nestjs' },
      { path: '/users/:id', component: 'UsersController.update', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'PATCH', framework: 'nestjs' },
    ]);
  });

  it('handles an empty @Controller() base and the object form', () => {
    const sfEmpty = makeSf(`
      import { Controller, Get } from '@nestjs/common';
      @Controller()
      export class AppController {
        @Get('health')
        health() {}
      }
    `, '/virtual/src/app.controller.ts');
    expect(collectSemanticHints(sfEmpty, 'src/app.controller.ts')?.routes).toEqual([
      { path: '/health', component: 'AppController.health', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'GET', framework: 'nestjs' },
    ]);

    const sfObj = makeSf(`
      import { Controller, Delete } from '@nestjs/common';
      @Controller({ path: 'billing' })
      export class BillingController {
        @Delete(':id')
        remove() {}
      }
    `, '/virtual/src/billing/billing.controller.ts');
    expect(collectSemanticHints(sfObj, 'src/billing/billing.controller.ts')?.routes).toEqual([
      { path: '/billing/:id', component: 'BillingController.remove', declaredIn: 'code', syntax: 'decorator', kind: 'api', method: 'DELETE', framework: 'nestjs' },
    ]);
  });

  it('ignores @Controller-shaped classes when @nestjs/common is not imported', () => {
    const sf = makeSf(`
      @Controller('x')
      export class NotNest {
        @Get() find() {}
      }
    `, '/virtual/src/not-nest.controller.ts');
    expect(collectSemanticHints(sf, 'src/not-nest.controller.ts')?.routes ?? []).toEqual([]);
  });

  it('projects Nest routes into backend api entrypoints labelled nestjs-decorator', () => {
    const hints = collectSemanticHints(
      makeSf(`
        import { Controller, Post } from '@nestjs/common';
        @Controller('auth')
        export class AuthController {
          @Post('login')
          login() {}
        }
      `, '/virtual/src/auth/auth.controller.ts'),
      'src/auth/auth.controller.ts',
    );
    const entries = collectBackendRouteEntrypoints(ctxFor([mod('src/auth/auth.controller', hints)]));
    expect(entries).toEqual([
      {
        __repovineSlot: 'api-route',
        id: 'entrypoint:api:src/auth/auth.controller:/auth/login:POST',
        kind: 'api',
        layer: 'backend',
        path: '/auth/login',
        component: 'AuthController.login',
        method: 'POST',
        moduleId: 'src/auth/auth.controller',
        source: 'nestjs-decorator',
        webFramework: 'nestjs',
      },
    ]);
  });
});
