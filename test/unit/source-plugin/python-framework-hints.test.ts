import { describe, it, expect } from '@jest/globals';
import {
  frameworkHintsFromRaw,
  normalizeApiPath,
} from '../../../packages/plugins/source-python/src/framework-hints.js';

describe('normalizeApiPath', () => {
  it('prefixes Django relative paths', () => {
    expect(normalizeApiPath('users/', 'django')).toBe('/users/');
  });

  it('keeps regex Django paths unchanged', () => {
    expect(normalizeApiPath('^items/(?P<id>\\d+)/$', 'django')).toBe('^items/(?P<id>\\d+)/$');
  });

  it('prefixes FastAPI paths when missing a leading slash', () => {
    expect(normalizeApiPath('health', 'fastapi')).toBe('/health');
  });
});

describe('frameworkHintsFromRaw', () => {
  it('maps FastAPI decorator routes', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'fastapi',
      routes: [{ path: '/api/items', method: 'POST', component: 'create_item' }],
    });
    expect(hints).toEqual({
      hasRoutes: true,
      webFramework: 'fastapi',
      routes: [
        {
          path: '/api/items',
          method: 'POST',
          component: 'create_item',
          declaredIn: 'code', syntax: 'decorator',
          kind: 'api',
        },
      ],
    });
  });

  it('passes rendersTemplate through to RouteInfo for server-rendered views', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'fastapi',
      routes: [{ path: '/profile', method: 'GET', component: 'profile', rendersTemplate: ['profile.html'] }],
    });
    expect(hints?.routes?.[0]).toEqual({
      path: '/profile',
      method: 'GET',
      component: 'profile',
      declaredIn: 'code', syntax: 'decorator',
      kind: 'api',
      rendersTemplate: ['profile.html'],
    });
  });

  it('omits rendersTemplate when the raw row has none or an empty list', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'fastapi',
      routes: [{ path: '/api/items', method: 'GET', component: 'list_items', rendersTemplate: [] }],
    });
    expect(hints?.routes?.[0]).not.toHaveProperty('rendersTemplate');
  });

  it('maps Django urlpatterns as ast routes', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'django',
      routes: [{ path: 'users/', method: 'GET', component: '(django-view)' }],
    });
    expect(hints?.routes?.[0]).toEqual({
      path: '/users/',
      method: 'GET',
      component: '(django-view)',
      declaredIn: 'code', syntax: 'call',
      kind: 'api',
    });
  });

  it('maps Flask routes as decorator-sourced with rendersTemplate', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'flask',
      routes: [{ path: '/dashboard', method: 'GET', component: 'dashboard', rendersTemplate: ['dashboard.html'] }],
    });
    expect(hints?.webFramework).toBe('flask');
    expect(hints?.routes?.[0]).toEqual({
      path: '/dashboard',
      method: 'GET',
      component: 'dashboard',
      declaredIn: 'code', syntax: 'decorator',
      kind: 'api',
      rendersTemplate: ['dashboard.html'],
    });
  });

  it('maps DRF synthesized routes with django-style path normalization', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'drf',
      routes: [{ path: 'api/users/', method: 'GET', component: 'UserViewSet' }],
    });
    expect(hints?.webFramework).toBe('drf');
    expect(hints?.routes?.[0]).toEqual({
      path: '/api/users/',
      method: 'GET',
      component: 'UserViewSet',
      declaredIn: 'code', syntax: 'call',
      kind: 'api',
    });
  });

  it('normalizes django paths from first-pass urlpatterns', () => {
    expect(normalizeApiPath('core/', 'django')).toBe('/core/');
  });

  it('uppercases a lowercase HTTP method', () => {
    const hints = frameworkHintsFromRaw({
      framework: 'fastapi',
      routes: [{ path: '/api/items', method: 'get', component: 'list_items' }],
    });
    expect(hints?.routes?.[0]?.method).toBe('GET');
  });

  it('returns undefined when no routes are present', () => {
    expect(frameworkHintsFromRaw({ framework: 'fastapi', routes: [] })).toBeUndefined();
  });
});
