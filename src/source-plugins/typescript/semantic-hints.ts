import { Node, SyntaxKind, type BindingElement, type SourceFile } from 'ts-morph';
import { importDeclarationSpecifier } from './module-specifier.js';
import { compareCodeUnits } from '../../platform/ordering.js';
import type {
  SemanticHints,
  UiChildComponentHint,
  UiComponentHint,
  UiComponentPropHint,
  UiDataAccess,
  UiHints,
  UiLifecycleEffect,
  UiNavigationAction,
  UiStateSignal,
  UiSubscriptionAction,
  UiTimerAction,
  RouteInfo,
  ConditionalRender,
  SsrMarkers,
  RuntimeAction,
  SecuritySignal,
} from '@repovine/plugin-sdk';

const ROUTE_PATTERN = /<Route[\s>]/;
const FASTIFY_MARKER_PATTERN = /(?:from\s+['"]fastify['"]|\bFastifyInstance\b|\bfastify\b)/;
const FASTIFY_HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'head']);
// Only env var names are extracted from source text; .env files are never read; no values or secrets.
// Proximity heuristic for runtime-action target attribution only — `collectEnvAccesses` owns the
// env-var hint and the env security signals.
const ENV_PROCESS_PATTERN = /process\.env\.([A-Z][A-Z0-9_]+)/g;

/**
 * Detect a directive (`'use server'` or `'use client'`) at the top of a file.
 * Tolerates BOM, leading whitespace, shebangs, single-line comments, and multi-line comments
 * — anything that can legitimately appear before the directive in JS/TS.
 */
function hasTopLevelDirective(text: string, directive: 'use server' | 'use client'): boolean {
  // Walk past leading non-code characters until we hit the first statement.
  let i = 0;
  // BOM
  if (text.charCodeAt(0) === 0xfeff) i++;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch === '#' && text[i + 1] === '!') {
      // shebang
      const nl = text.indexOf('\n', i);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return false;
      i = nl + 1;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) return false;
      i = end + 2;
      continue;
    }
    break;
  }
  if (i >= text.length) return false;
  const slice = text.slice(i, i + directive.length + 2);
  return slice === `"${directive}"` || slice === `'${directive}'`;
}

/** Names of file-level exports that signal SSR data-fetching by convention. */
const SSR_EXPORT_NAMES = new Set([
  'getServerSideProps', 'getStaticProps', 'getInitialProps', 'loader', 'action',
]);

/**
 * Qwik-specific macros: found by pattern because they are call expressions rather than regular
 * exports. A match inside a literal or a comment is prose about Qwik — a doc string naming
 * `routeLoader$` would otherwise mark the module as a Qwik server module.
 */
const QWIK_MACRO_PATTERN = /\b(routeLoader\$|routeAction\$|server\$)\s*\(/g;

function hasQwikMacro(sf: SourceFile, text: string): boolean {
  QWIK_MACRO_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(QWIK_MACRO_PATTERN)) {
    const index = match.index ?? 0;
    if (isInsideLiteral(sf, index) || isInsideComment(text, index)) continue;
    return true;
  }
  return false;
}

function collectSsrMarkers(sf: SourceFile, text: string): SsrMarkers | undefined {
  const m: SsrMarkers = {};
  let any = false;
  if (hasTopLevelDirective(text, 'use server')) { m.useServer = true; any = true; }
  if (hasTopLevelDirective(text, 'use client')) { m.useClient = true; any = true; }

  // Named exports that signal SSR data hooks.
  for (const exp of sf.getExportedDeclarations().keys()) {
    if (!SSR_EXPORT_NAMES.has(exp)) continue;
    switch (exp) {
      case 'getServerSideProps': m.getServerSideProps = true; any = true; break;
      case 'getStaticProps': m.getStaticProps = true; any = true; break;
      case 'getInitialProps': m.getInitialProps = true; any = true; break;
      case 'loader': m.loader = true; any = true; break;
      case 'action': m.action = true; any = true; break;
    }
  }

  if (hasQwikMacro(sf, text)) { m.qwikServer = true; any = true; }

  // Framework-general runtime markers (semanticHints v1). Derived from the JS-specific markers above
  // so non-JS layer consumers can read a neutral shape. `runsOn` is omitted when ambiguous (both or
  // neither directive) — `useServer`/`useClient` stay authoritative. These never flip `any`: they
  // only attach when a primary marker already matched.
  if (m.useServer && !m.useClient) m.runsOn = 'server';
  else if (m.useClient && !m.useServer) m.runsOn = 'client';
  if (m.getServerSideProps || m.getStaticProps || m.getInitialProps || m.loader) m.dataLoader = true;

  return any ? m : undefined;
}

/**
 * One env-var access: the name, and the source offset that carries it. A write
 * (`process.env.X = v` sets the variable for child processes) counts alongside a read — both couple
 * the module to the name.
 */
interface EnvAccess {
  name: string;
  pos: number;
}

/**
 * True for the `process.env` / `import.meta.env` container object.
 *
 * Matched on tree shape rather than on text. `getText()` reproduces trivia interior to the node, so
 * a chain the formatter broke across lines (`process\n  .env\n  .NAME`) or one carrying a comment
 * (`process/*c*\/.env.NAME`) compares unequal to `'process.env'` while denoting exactly it. Shape
 * also rejects `obj.process.env.X`, where the base is a property access rather than the global.
 */
function isEnvContainer(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node) || node.getName() !== 'env') return false;
  const base = node.getExpression();
  if (Node.isIdentifier(base)) return base.getText() === 'process';
  // `import.meta` is a MetaProperty; the keyword token separates it from `new.target`.
  return Node.isMetaProperty(base) && base.getKeywordToken() === SyntaxKind.ImportKeyword;
}

/** A quoted key that resolves to a name — `'NAME'` and `` `NAME` `` both qualify, `[expr]` does not. */
function staticKeyOf(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return undefined;
}

/**
 * The env name a destructured binding element names, absent for a key the source does not fix.
 *
 * `{ PORT }` carries the name on the element. `{ PORT: port }` carries it on the property node and
 * the local alias on the element, so the property node wins wherever it is present — a quoted
 * property resolves through its literal value, so the name never arrives carrying quote characters.
 * `{ ...rest }` binds the remaining names rather than any one of them, and `{ [k]: v }` is the same
 * unresolvable key an element access refuses; both yield nothing.
 */
function envBindingName(element: BindingElement): string | undefined {
  if (element.getDotDotDotToken()) return undefined;
  const property = element.getPropertyNameNode();
  if (!property) return element.getName();
  return Node.isIdentifier(property) ? property.getText() : staticKeyOf(property);
}

/**
 * Env-var accesses, collected off the syntax tree.
 *
 * The tree is what separates an access from the same characters written as prose: a name inside a
 * comment, a quoted string, or a template is never an access node, so it is absent by construction
 * rather than by a position guard. Walking also reaches the forms a `process\.env\.NAME` scan cannot
 * see — quoted-key access and destructuring — and reaches `import.meta.env` at any name, where the
 * scan resolved only the `VITE_` prefix.
 *
 * A key the source does not fix (`process.env[ENV_BY_ROLE[role]]`) yields no name. That is the
 * boundary of what source text decides; naming a guess here would put an unearned name into the
 * annotation ground truth.
 */
function collectEnvAccesses(sf: SourceFile): EnvAccess[] {
  const accesses: EnvAccess[] = [];
  const add = (name: string | undefined, pos: number): void => {
    // An empty name comes from a chain left incomplete mid-edit (`process.env.`) — it names nothing.
    if (name) accesses.push({ name, pos });
  };
  sf.forEachDescendant(node => {
    if (Node.isPropertyAccessExpression(node)) {
      if (!isEnvContainer(node.getExpression())) return;
      // A member being called is a method on the container object (`process.env.hasOwnProperty(k)`),
      // never a variable. `process.env.PATH.split(':')` still lands here on `PATH`, whose own parent
      // is the callee's expression rather than the callee.
      const parent = node.getParent();
      if (parent && Node.isCallExpression(parent) && parent.getExpression() === node) return;
      add(node.getName(), node.getStart());
      return;
    }
    if (Node.isElementAccessExpression(node)) {
      if (!isEnvContainer(node.getExpression())) return;
      add(staticKeyOf(node.getArgumentExpression()), node.getStart());
      return;
    }
    if (Node.isVariableDeclaration(node)) {
      const init = node.getInitializer();
      const nameNode = node.getNameNode();
      if (!init || !isEnvContainer(init) || !Node.isObjectBindingPattern(nameNode)) return;
      for (const element of nameNode.getElements()) add(envBindingName(element), element.getStart());
    }
  });
  return accesses;
}

export function collectSemanticHints(sf: SourceFile, relativeFilePath?: string): SemanticHints | undefined {
  const text = sf.getFullText();
  const hints: SemanticHints = {};
  let hasAny = false;

  const reactRouter = usesReactRouter(sf);
  const tanStackRouter = usesTanStackRouter(sf);
  const angularRouter = usesAngularRouter(sf);
  const nestCommon = usesNestCommon(sf);
  const jsxRoutes = ROUTE_PATTERN.test(text) ? collectRoutes(sf, reactRouter) : [];
  const configRoutes = reactRouter ? collectReactRouterConfigRoutes(sf) : [];
  const tanStackRoutes = tanStackRouter ? collectTanStackRoutes(sf) : [];
  const angularRoutes = angularRouter ? collectAngularRoutes(sf) : [];
  const nestRoutes = nestCommon ? collectNestRoutes(sf) : [];
  const fileRoutes = relativeFilePath ? collectFileRoutes(relativeFilePath, sf) : [];
  const fastifyRoutes = FASTIFY_MARKER_PATTERN.test(text) ? collectFastifyRoutes(sf) : [];
  const routes = [...jsxRoutes, ...configRoutes, ...tanStackRoutes, ...angularRoutes, ...nestRoutes, ...fileRoutes, ...fastifyRoutes];
  if (routes.length > 0) {
    hints.hasRoutes = true;
    hints.routes = routes;
    hasAny = true;
  }
  // Backend frameworks win the single webFramework slot (server-entrypoints reads it to label the
  // route source, e.g. nestjs-decorator). Angular intentionally does not set it here: its frontend
  // entrypoint branch carries webFramework:'angular' directly off route.framework.
  if (fastifyRoutes.length > 0) {
    hints.webFramework = 'fastify';
    hasAny = true;
  } else if (nestRoutes.length > 0) {
    hints.webFramework = 'nestjs';
    hasAny = true;
  } else if (reactRouter) {
    hints.webFramework = 'react-router';
    hasAny = true;
  } else if (tanStackRouter) {
    hints.webFramework = 'tanstack-router';
    hasAny = true;
  }

  const conditionalRenders = collectConditionalRenders(sf);
  if (conditionalRenders.length > 0) {
    hints.conditionalRenders = conditionalRenders;
    hasAny = true;
  }

  const envAccesses = collectEnvAccesses(sf);
  if (envAccesses.length > 0) {
    hints.envVars = [...new Set(envAccesses.map(a => a.name))].sort();
    hasAny = true;
  }

  const runtimeActions = collectRuntimeActions(text, sf);
  if (runtimeActions.length > 0) {
    hints.runtimeActions = runtimeActions;
    hasAny = true;
  }

  const security = collectSecuritySignals(sf, text, envAccesses, relativeFilePath);
  if (security.length > 0) {
    hints.security = security;
    hasAny = true;
  }

  const frontend = collectUiHints(sf, relativeFilePath);
  if (frontend) {
    hints.ui = frontend;
    hasAny = true;
  }

  const ssr = collectSsrMarkers(sf, text);
  if (ssr) {
    hints.ssr = ssr;
    hasAny = true;
  }

  return hasAny ? hints : undefined;
}

/**
 * Detect JSX components rendered outside of <Route>, e.g.:
 *   if (!isAuth) return <LoginPage />;
 *   {condition ? <A /> : <B />}
 *   {condition && <Component />}
 */
function collectConditionalRenders(sf: SourceFile): ConditionalRender[] {
  const renders: ConditionalRender[] = [];
  const seen = new Set<string>();

  sf.forEachDescendant(node => {
    // Pattern 1: if (condition) return <Component ... />
    if (Node.isIfStatement(node)) {
      const thenStmt = node.getThenStatement();
      if (!thenStmt) return;
      const thenText = thenStmt.getText();
      const jsxMatch = thenText.match(/return\s+<(\w+)/);
      if (!jsxMatch) return;
      const component = jsxMatch[1];
      if (component[0] !== component[0].toUpperCase()) return;

      const condition = node.getExpression().getText();
      const key = `${component}:${condition}`;
      if (seen.has(key)) return;
      seen.add(key);

      const enclosingFn = node.getFirstAncestor(a =>
        Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
        Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
      );
      const enclosingExport = enclosingFn?.getFirstAncestor(a =>
        Node.isVariableStatement(a) || Node.isFunctionDeclaration(a),
      );
      let renderedIn = 'anonymous';
      if (enclosingExport && Node.isVariableStatement(enclosingExport)) {
        renderedIn = enclosingExport.getDeclarations()[0]?.getName() ?? 'anonymous';
      } else if (enclosingExport && Node.isFunctionDeclaration(enclosingExport)) {
        renderedIn = enclosingExport.getName() ?? 'anonymous';
      } else if (enclosingFn && Node.isFunctionDeclaration(enclosingFn)) {
        renderedIn = enclosingFn.getName() ?? 'anonymous';
      }

      renders.push({
        component,
        condition: condition.length > 100 ? condition.slice(0, 100) + '…' : condition,
        renderedIn,
        lineRange: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
      });
    }

    // Pattern 2: {condition && <Component />} or {condition ? <A /> : <B />}
    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression();
      if (!expr) return;

      if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getText() === '&&') {
        const right = expr.getRight();
        const jsxMatch = right.getText().match(/^<(\w+)/);
        if (!jsxMatch || jsxMatch[1][0] !== jsxMatch[1][0].toUpperCase()) return;
        const component = jsxMatch[1];
        const condition = expr.getLeft().getText();
        const key = `${component}:${condition}`;
        if (seen.has(key)) return;
        seen.add(key);

        const enclosingFn = node.getFirstAncestor(a =>
          Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
          Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
        );
        let renderedIn = 'anonymous';
        if (enclosingFn) {
          const parent = enclosingFn.getParent();
          if (parent && Node.isVariableDeclaration(parent)) {
            renderedIn = parent.getName();
          } else if (Node.isFunctionDeclaration(enclosingFn)) {
            renderedIn = enclosingFn.getName() ?? 'anonymous';
          }
        }

        renders.push({
          component,
          condition: condition.length > 100 ? condition.slice(0, 100) + '…' : condition,
          renderedIn,
          lineRange: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
        });
      }

      if (Node.isConditionalExpression(expr)) {
        const condition = expr.getCondition().getText();
        for (const branch of [expr.getWhenTrue(), expr.getWhenFalse()]) {
          const jsxMatch = branch.getText().match(/^<(\w+)/);
          if (!jsxMatch || jsxMatch[1][0] !== jsxMatch[1][0].toUpperCase()) continue;
          const component = jsxMatch[1];
          const key = `${component}:${condition}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const enclosingFn = node.getFirstAncestor(a =>
            Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
            Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
          );
          let renderedIn = 'anonymous';
          if (enclosingFn) {
            const parent = enclosingFn.getParent();
            if (parent && Node.isVariableDeclaration(parent)) {
              renderedIn = parent.getName();
            } else if (Node.isFunctionDeclaration(enclosingFn)) {
              renderedIn = enclosingFn.getName() ?? 'anonymous';
            }
          }

          renders.push({
            component,
            condition: condition.length > 100 ? condition.slice(0, 100) + '…' : condition,
            renderedIn,
            lineRange: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
          });
        }
      }
    }
  });

  return renders;
}

function usesReactRouter(sf: SourceFile): boolean {
  return sf.getImportDeclarations().some(imp => {
    const source = importDeclarationSpecifier(imp);
    if (!source) return false;
    return source === 'react-router-dom'
      || source === 'react-router'
      || source.startsWith('react-router/')
      || source === '@remix-run/react';
  });
}

function usesTanStackRouter(sf: SourceFile): boolean {
  return sf.getImportDeclarations().some(imp => importDeclarationSpecifier(imp) === '@tanstack/react-router');
}

function usesAngularRouter(sf: SourceFile): boolean {
  return sf.getImportDeclarations().some(imp => importDeclarationSpecifier(imp) === '@angular/router');
}

function usesNestCommon(sf: SourceFile): boolean {
  return sf.getImportDeclarations().some(imp => importDeclarationSpecifier(imp) === '@nestjs/common');
}

function identifierFromInitializer(init: Node | undefined): string | undefined {
  if (!init) return undefined;
  if (Node.isIdentifier(init)) return init.getText();
  if (Node.isPropertyAccessExpression(init)) return init.getName();
  return undefined;
}

function componentFromTanStackOptions(node: import('ts-morph').ObjectLiteralExpression): string {
  const prop = node.getProperty('component');
  if (!prop || !Node.isPropertyAssignment(prop)) return '(route)';
  return identifierFromInitializer(prop.getInitializer()) ?? '(route)';
}

function normalizeTanStackPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** TanStack Router routes — only when the module imports `@tanstack/react-router`. */
function collectTanStackRoutes(sf: SourceFile): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const seen = new Set<string>();

  const push = (path: string, component: string, source: 'file' | 'ast', fileType?: string) => {
    const normalized = normalizeTanStackPath(path);
    const key = `${source}:${normalized}:${component}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({
      path: normalized,
      component,
      source,
      kind: 'frontend',
      framework: 'tanstack-router',
      ...(fileType ? { fileType } : {}),
    });
  };

  sf.forEachDescendant(node => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();

    // createFileRoute('/path')({ component: Foo })
    if (Node.isCallExpression(expr)) {
      const factory = expr.getExpression();
      if (Node.isIdentifier(factory) && factory.getText() === 'createFileRoute') {
        const path = stringLiteralArg(expr.getArguments()[0]);
        if (!path) return;
        const opts = node.getArguments()[0];
        const component = opts && Node.isObjectLiteralExpression(opts)
          ? componentFromTanStackOptions(opts)
          : '(route)';
        push(path, component, 'file', 'page');
        return;
      }
    }

    if (!Node.isIdentifier(expr)) return;
    const factoryName = expr.getText();
    if (factoryName !== 'createRoute' && factoryName !== 'createRootRoute') return;

    const arg = node.getArguments()[0];
    if (!arg || !Node.isObjectLiteralExpression(arg)) return;

    // A root route is the shared layout for the tree, not a public URL by itself. An index child
    // created with createRoute({ path: '/' }) is the routable `/` entrypoint.
    if (factoryName === 'createRootRoute') return;
    const pathProp = arg.getProperty('path');
    const path = pathProp && Node.isPropertyAssignment(pathProp)
      ? stringLiteralArg(pathProp.getInitializer())
      : undefined;
    if (!path) return;

    push(path, componentFromTanStackOptions(arg), 'ast');
  });

  return routes;
}

function collectRoutes(sf: SourceFile, reactRouter = false): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const jsxFramework = reactRouter ? 'react-router' : undefined;

  sf.forEachDescendant(node => {
    let pathValue: string | undefined;
    let component: string | undefined;

    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) {
      const tagName = node.getTagNameNode().getText();
      if (tagName !== 'Route') return;

      for (const attr of node.getAttributes()) {
        if (!Node.isJsxAttribute(attr)) continue;
        const name = attr.getNameNode().getText();
        if (name === 'path') {
          const init = attr.getInitializer();
          if (init && Node.isStringLiteral(init)) {
            pathValue = init.getLiteralValue();
          }
        }
        if (name === 'element') {
          const init = attr.getInitializer();
          if (init && Node.isJsxExpression(init)) {
            const innerExpr = init.getExpression();
            if (innerExpr) {
              const jsxText = innerExpr.getText();
              const match = jsxText.match(/^<(\w+)/);
              if (match) component = match[1];
            }
          }
        }
        if (name === 'index') {
          pathValue = pathValue ?? '/';
        }
      }
    }

    if (pathValue && component) {
      routes.push({ path: pathValue, component, source: 'jsx', kind: 'frontend', framework: jsxFramework });
    } else if (pathValue) {
      routes.push({ path: pathValue, component: '(wrapper)', source: 'jsx', kind: 'frontend', framework: jsxFramework });
    }
  });

  return routes;
}

const REACT_ROUTER_ROUTE_MARKERS = new Set([
  'component', 'element', 'lazy', 'children', 'index', 'redirectTo',
  'loader', 'action', 'errorElement', 'handle',
]);

function isReactRouterConfigObject(node: import('ts-morph').ObjectLiteralExpression): boolean {
  let hasMarker = false;
  let hasPathOrIndex = false;
  for (const prop of node.getProperties()) {
    if (Node.isShorthandPropertyAssignment(prop)) {
      hasMarker = true;
      continue;
    }
    if (!Node.isPropertyAssignment(prop)) continue;
    const name = prop.getName();
    if (name === 'path' || name === 'index') hasPathOrIndex = true;
    if (REACT_ROUTER_ROUTE_MARKERS.has(name)) hasMarker = true;
  }
  return hasMarker && hasPathOrIndex;
}

function pathFromReactRouterConfig(node: import('ts-morph').ObjectLiteralExpression): string | undefined {
  const indexProp = node.getProperty('index');
  if (indexProp && Node.isPropertyAssignment(indexProp)) {
    const init = indexProp.getInitializer();
    if (init?.getText() === 'true') return '/';
  }
  const pathProp = node.getProperty('path');
  if (!pathProp || !Node.isPropertyAssignment(pathProp)) return undefined;
  return stringLiteralArg(pathProp.getInitializer());
}

function componentFromReactRouterConfig(node: import('ts-morph').ObjectLiteralExpression): string {
  for (const name of ['component', 'element', 'lazy']) {
    const prop = node.getProperty(name);
    if (!prop || !Node.isPropertyAssignment(prop)) continue;
    const init = prop.getInitializer();
    if (!init) continue;
    if (Node.isIdentifier(init)) return init.getText();
    if (Node.isCallExpression(init)) return init.getExpression().getText();
    if (Node.isJsxSelfClosingElement(init) || Node.isJsxOpeningElement(init)) {
      return init.getTagNameNode().getText();
    }
  }
  if (node.getProperty('redirectTo')) return '(redirect)';
  if (node.getProperty('index')) return '(index)';
  return '(route-config)';
}

function collectReactRouterConfigRoutes(sf: SourceFile): RouteInfo[] {
  const routes: RouteInfo[] = [];
  const seen = new Set<string>();

  sf.forEachDescendant(node => {
    if (!Node.isObjectLiteralExpression(node)) return;
    if (!isReactRouterConfigObject(node)) return;

    const path = pathFromReactRouterConfig(node);
    if (!path) return;

    const key = `${path}:${node.getStartLineNumber()}`;
    if (seen.has(key)) return;
    seen.add(key);

    const indexProp = node.getProperty('index');
    const isIndex = indexProp && Node.isPropertyAssignment(indexProp) && indexProp.getInitializer()?.getText() === 'true';

    routes.push({
      path,
      component: componentFromReactRouterConfig(node),
      source: 'config',
      kind: 'frontend',
      framework: 'react-router',
      fileType: isIndex ? 'index' : 'route',
    });
  });

  return routes;
}

function collectFastifyRoutes(sf: SourceFile): RouteInfo[] {
  const routes: RouteInfo[] = [];

  sf.forEachDescendant(node => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;

    const methodName = expr.getName();
    const receiver = expr.getExpression().getText();
    const lowerMethod = methodName.toLowerCase();

    if (FASTIFY_HTTP_METHODS.has(lowerMethod)) {
      const path = stringLiteralArg(node.getArguments()[0]);
      if (!path || !looksLikeFastifyReceiver(receiver)) return;
      routes.push({
        path,
        component: expr.getText(),
        source: 'ast',
        kind: 'api',
        method: lowerMethod.toUpperCase(),
      });
      return;
    }

    if (lowerMethod !== 'route' || !looksLikeFastifyReceiver(receiver)) return;
    const arg = node.getArguments()[0];
    if (!arg || !Node.isObjectLiteralExpression(arg)) return;
    const path = objectStringProperty(arg, 'url') ?? objectStringProperty(arg, 'path');
    const method = objectStringProperty(arg, 'method')?.toUpperCase() ?? 'GET';
    if (!path) return;
    routes.push({
      path,
      component: expr.getText(),
      source: 'ast',
      kind: 'api',
      method,
    });
  });

  return routes;
}

function looksLikeFastifyReceiver(value: string): boolean {
  const lower = value.toLowerCase();
  return lower === 'fastify'
    || lower.endsWith('.fastify')
    || lower === 'server'
    || lower === 'app';
}

function stringLiteralArg(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  return undefined;
}

function objectStringProperty(
  node: import('ts-morph').ObjectLiteralExpression,
  propertyName: string,
): string | undefined {
  const prop = node.getProperty(propertyName);
  if (!prop || !Node.isPropertyAssignment(prop)) return undefined;
  return stringLiteralArg(prop.getInitializer());
}

/** Join a parent prefix with a child segment, trimming stray slashes; both may be empty. */
function joinRouteSegments(prefix: string, seg: string | undefined): string {
  const right = (seg ?? '').replace(/^\/+|\/+$/g, '');
  const left = prefix.replace(/\/+$/g, '');
  if (!left) return right;
  if (!right) return left;
  return `${left}/${right}`;
}

/** Ensure a single leading slash; an empty path is the root. */
function normalizeRoutePath(path: string): string {
  if (path === '') return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function isAngularRoutesType(typeNode: Node | undefined): boolean {
  if (!typeNode) return false;
  const text = typeNode.getText();
  return text === 'Routes' || text === 'Route[]' || text === 'Array<Route>';
}

/** Resolve the component name for an Angular route object, or undefined when there is nothing to land on. */
function angularComponentName(obj: import('ts-morph').ObjectLiteralExpression): string | undefined {
  const comp = obj.getProperty('component');
  if (comp && Node.isPropertyAssignment(comp)) {
    const id = identifierFromInitializer(comp.getInitializer());
    if (id) return id;
  }
  // loadChildren (lazy module) / loadComponent (lazy standalone) resolve at runtime — record a placeholder.
  if (obj.getProperty('loadChildren') || obj.getProperty('loadComponent')) return '(lazy)';
  return undefined;
}

function collectAngularRouteObject(
  obj: import('ts-morph').ObjectLiteralExpression,
  prefix: string,
  out: RouteInfo[],
  seen: Set<string>,
): void {
  // redirectTo entries are navigation shims, not landable routes — skip (and their children, which Angular forbids).
  if (obj.getProperty('redirectTo')) return;

  const fullPath = joinRouteSegments(prefix, objectStringProperty(obj, 'path'));
  const component = angularComponentName(obj);
  if (component) {
    const normalized = normalizeRoutePath(fullPath);
    const key = `${normalized}|${component}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ path: normalized, component, source: 'ast', kind: 'frontend', framework: 'angular' });
    }
  }

  const childrenProp = obj.getProperty('children');
  if (childrenProp && Node.isPropertyAssignment(childrenProp)) {
    const init = childrenProp.getInitializer();
    if (init && Node.isArrayLiteralExpression(init)) {
      collectAngularRouteArray(init, fullPath, out, seen);
    }
  }
}

function collectAngularRouteArray(
  arr: import('ts-morph').ArrayLiteralExpression,
  prefix: string,
  out: RouteInfo[],
  seen: Set<string>,
): void {
  for (const el of arr.getElements()) {
    if (Node.isObjectLiteralExpression(el)) collectAngularRouteObject(el, prefix, out, seen);
  }
}

/**
 * Angular `RouterModule` routes — only when the module imports `@angular/router`. Two array sources:
 *   1. a const annotated `Routes` / `Route[]` (the canonical table, however it's later consumed);
 *   2. an inline literal — or const reference — passed to `RouterModule.forRoot(...)` / `forChild(...)`.
 * A Set of array nodes dedups the overlap when a typed const is also handed to forRoot/forChild.
 */
function collectAngularRoutes(sf: SourceFile): RouteInfo[] {
  const out: RouteInfo[] = [];
  const seen = new Set<string>();
  const routeArrays = new Set<import('ts-morph').ArrayLiteralExpression>();
  const constArraysByName = new Map<string, import('ts-morph').ArrayLiteralExpression>();

  sf.forEachDescendant(node => {
    if (!Node.isVariableDeclaration(node)) return;
    const init = node.getInitializer();
    if (!init || !Node.isArrayLiteralExpression(init)) return;
    const name = node.getNameNode();
    if (Node.isIdentifier(name)) constArraysByName.set(name.getText(), init);
    if (isAngularRoutesType(node.getTypeNode())) routeArrays.add(init);
  });

  sf.forEachDescendant(node => {
    if (!Node.isCallExpression(node)) return;
    const expr = node.getExpression();
    if (!Node.isPropertyAccessExpression(expr)) return;
    const method = expr.getName();
    if (method !== 'forRoot' && method !== 'forChild') return;
    if (expr.getExpression().getText() !== 'RouterModule') return;
    const arg = node.getArguments()[0];
    if (!arg) return;
    if (Node.isArrayLiteralExpression(arg)) {
      routeArrays.add(arg);
    } else if (Node.isIdentifier(arg)) {
      const ref = constArraysByName.get(arg.getText());
      if (ref) routeArrays.add(ref);
    }
  });

  for (const arr of routeArrays) collectAngularRouteArray(arr, '', out, seen);
  return out;
}

const NEST_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All']);

/** Base path from `@Controller('x')`, `@Controller({ path: 'x' })`, or empty for `@Controller()`. */
function nestControllerBasePath(dec: import('ts-morph').Decorator): string {
  const arg = dec.getArguments()[0];
  if (!arg) return '';
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) return arg.getLiteralText();
  if (Node.isObjectLiteralExpression(arg)) return objectStringProperty(arg, 'path') ?? '';
  return '';
}

/**
 * Nest `@Controller` + HTTP-method decorator routes — only when the module imports `@nestjs/common`.
 * Emits decorator/api RouteInfo; the generic server-entrypoints interpreter turns these into api
 * entrypoints (webFramework 'nestjs' is set on the module so the source reads `nestjs-decorator`).
 */
function collectNestRoutes(sf: SourceFile): RouteInfo[] {
  const out: RouteInfo[] = [];
  for (const cls of sf.getClasses()) {
    const controller = cls.getDecorator('Controller');
    if (!controller) continue;
    const base = nestControllerBasePath(controller);
    const className = cls.getName() ?? '(anonymous)';
    for (const method of cls.getMethods()) {
      for (const dec of method.getDecorators()) {
        const decName = dec.getName();
        if (!NEST_METHOD_DECORATORS.has(decName)) continue;
        const path = normalizeRoutePath(joinRouteSegments(base, stringLiteralArg(dec.getArguments()[0])));
        out.push({
          path,
          component: `${className}.${method.getName()}`,
          source: 'decorator',
          kind: 'api',
          method: decName.toUpperCase(),
          framework: 'nestjs',
        });
      }
    }
  }
  return out;
}


const ROUTE_FILE_EXT_RE = /\.(?:tsx?|jsx?|vue|svelte|mts|cts)$/i;
const NEXTJS_APP_FILE_RE = /^(page|layout|route|loading|error|not-found|template|default)$/;
const FILE_ROUTE_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']);
/** Folders that usually denote view/component trees, not Next.js App Router segments. */
const VIEW_LIKE_PATH_SEGMENTS = new Set([
  'views', 'components', 'features', 'screens', 'containers', 'widgets',
  'stories', 'storybook', '__tests__', '__mocks__', 'fixtures',
]);

function isNextPagesRouterRoot(parts: string[], pagesIdx: number): boolean {
  if (pagesIdx > 1) return false;
  return pagesIdx === 0 || parts[pagesIdx - 1] === 'src';
}

function isLikelyNextAppRouterPath(parts: string[], appIdx: number, basename: string): boolean {
  if (!NEXTJS_APP_FILE_RE.test(basename)) return false;
  if (appIdx === 0 || (appIdx === 1 && parts[0] === 'src')) return true;
  const between = parts.slice(appIdx + 1, -1);
  return between.length > 0 && !between.some(segment => VIEW_LIKE_PATH_SEGMENTS.has(segment.toLowerCase()));
}

function exportedHttpMethods(sf: SourceFile): string[] {
  return [...sf.getExportedDeclarations().keys()]
    .filter(name => FILE_ROUTE_HTTP_METHODS.has(name))
    .sort((a, b) => compareCodeUnits(a, b));
}

function apiFileRoutes(
  path: string,
  framework: string,
  fileType: string,
  methods: string[],
): RouteInfo[] {
  return methods.length > 0
    ? methods.map(method => fileRoute(path, framework, fileType, 'api', method))
    : [fileRoute(path, framework, fileType, 'api')];
}

function collectFileRoutes(relativeFilePath: string, sf: SourceFile): RouteInfo[] {
  const rel = relativeFilePath.replace(/\\/g, '/');
  if (!ROUTE_FILE_EXT_RE.test(rel)) return [];

  const noExt = rel.replace(ROUTE_FILE_EXT_RE, '');
  const parts = noExt.split('/');
  const basename = parts[parts.length - 1];

  const appIdx = parts.indexOf('app');
  if (appIdx >= 0 && isLikelyNextAppRouterPath(parts, appIdx, basename)) {
    if (basename !== 'page' && basename !== 'route') return [];
    const segments = parts.slice(appIdx + 1, -1)
      .filter(s => !s.match(/^\(.+\)$/));
    const urlPath = '/' + segments.join('/');
    return basename === 'route'
      ? apiFileRoutes(urlPath || '/', 'nextjs-app', basename, exportedHttpMethods(sf))
      : [fileRoute(urlPath || '/', 'nextjs-app', basename)];
  }

  const pagesIdx = parts.indexOf('pages');
  if (pagesIdx >= 0 && pagesIdx < parts.length - 1 && isNextPagesRouterRoot(parts, pagesIdx)) {
    if (basename.startsWith('_')) return [];
    const after = parts.slice(pagesIdx + 1);
    const isApi = after[0] === 'api';
    const routeParts = after.slice(isApi ? 1 : 0);
    const last = routeParts[routeParts.length - 1];
    const routeSegments = last === 'index' ? routeParts.slice(0, -1) : routeParts;
    const urlPath = (isApi ? '/api/' : '/') + routeSegments.join('/');
    return [fileRoute(urlPath.replace(/\/+$/, '') || '/', 'nextjs-pages', isApi ? 'api' : 'page')];
  }

  const skRoutesIdx = parts.indexOf('routes');
  if (skRoutesIdx >= 0 && skRoutesIdx + 1 < parts.length && basename.startsWith('+')) {
    const segments = parts.slice(skRoutesIdx + 1, -1)
      .filter(s => !s.match(/^\(.+\)$/));
    const urlPath = '/' + segments.join('/');
    if (basename === '+server') {
      return apiFileRoutes(urlPath || '/', 'sveltekit', 'server', exportedHttpMethods(sf));
    }
    if (basename === '+page' && rel.endsWith('.svelte')) {
      return [fileRoute(urlPath || '/', 'sveltekit', 'page')];
    }
    return [];
  }

  const nuxtServerIdx = parts.indexOf('server');
  if (nuxtServerIdx >= 0 && parts[nuxtServerIdx + 1] === 'api') {
    const after = parts.slice(nuxtServerIdx + 2);
    // `server/api` with nothing after it is a module named `api`, not a route directory.
    if (after.length === 0) return [];
    const last = after[after.length - 1];
    const methodMatch = last.match(/^(.*)\.(get|post|put|patch|delete|options|head)$/i);
    const routeFileName = methodMatch?.[1] ?? last;
    const routeSegments = routeFileName === 'index'
      ? after.slice(0, -1)
      : [...after.slice(0, -1), routeFileName];
    const urlPath = '/api/' + routeSegments.join('/');
    return [fileRoute(
      urlPath.replace(/\/+$/, '') || '/api',
      'nuxt',
      'server-api',
      'api',
      methodMatch?.[2].toUpperCase(),
    )];
  }

  return [];
}

function fileRoute(
  path: string,
  framework: string,
  fileType: string,
  kind: 'frontend' | 'api' = fileRouteKind(fileType),
  method?: string,
): RouteInfo {
  return {
    path,
    component: '(file-route)',
    source: 'file',
    kind,
    framework,
    fileType,
    ...(method ? { method } : {}),
  };
}

function fileRouteKind(fileType: string): 'frontend' | 'api' {
  return fileType === 'api' || fileType === 'server' || fileType === 'server-api' || fileType === 'route'
    ? 'api'
    : 'frontend';
}

function collectSecuritySignals(
  sf: SourceFile,
  text: string,
  envAccesses: EnvAccess[],
  relativeFilePath?: string,
): SecuritySignal[] {
  const rel = (relativeFilePath ?? sf.getBaseName()).replace(/\\/g, '/').toLowerCase();
  const signals: SecuritySignal[] = [];

  const addEnvSignal = (name: string, index: number | undefined): void => {
    const lineRange = index == null ? undefined : lineRangeFromTextIndex(text, index);
    if (isPublicEnvName(name)) signals.push({ kind: 'public-env', name, lineRange });
    if (isSecretLikeName(name) && !isPublicEnvName(name)) signals.push({ kind: 'secret-env', name, lineRange });
  };

  // Same accesses that back `hints.envVars`, so a name flagged as a secret here is a name the module
  // actually touches.
  for (const access of envAccesses) addEnvSignal(access.name, access.pos);

  for (const imp of sf.getImportDeclarations()) {
    const source = importDeclarationSpecifier(imp);
    if (source === undefined) continue;
    const range = nodeLineRange(imp);
    if (isValidationImport(source)) {
      signals.push({ kind: 'validation', name: source, lineRange: range });
    }
    if (isAuthzImport(source)) {
      signals.push({ kind: 'authz', name: source, lineRange: range });
    }
  }

  sf.forEachDescendant(node => {
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText();
      const name = lastCalleeSegment(callee);
      const range = nodeLineRange(node);
      const storage = securityStorageSignal(callee, name, node);
      if (storage) signals.push({ ...storage, lineRange: range });
      if (isValidationCall(callee, name)) signals.push({ kind: 'validation', callee, lineRange: range });
      if (isAuthzCall(callee, name)) signals.push({ kind: 'authz', callee, lineRange: range });
      if (isSourceDisclosureCall(callee, name, node, text, rel)) {
        signals.push({ kind: 'source-disclosure', callee, lineRange: range });
      }
      if (/^(cookies|headers)$/.test(name) || /\.cookie(Store)?$/.test(callee)) {
        signals.push({ kind: 'cookie-access', callee, lineRange: range });
      }
      return;
    }
    if (Node.isPropertyAccessExpression(node) && node.getText() === 'document.cookie') {
      signals.push({ kind: 'cookie-access', callee: 'document.cookie', lineRange: nodeLineRange(node) });
    }
  });

  if (looksLikeSourceDisclosureModule(rel, text)) {
    const idx = text.search(/\b(includeBody|grepBody|privateMembers|readNodeBody|source body|raw source)\b/i);
    signals.push({
      kind: 'source-disclosure',
      name: 'source-body-surface',
      lineRange: idx >= 0 ? lineRangeFromTextIndex(text, idx) : undefined,
    });
  }

  return dedupeBy(signals, itemKey);
}

function isPublicEnvName(name: string): boolean {
  return /^(VITE_|NEXT_PUBLIC_|PUBLIC_|NUXT_PUBLIC_|REACT_APP_)/.test(name);
}

function isSecretLikeName(name: string): boolean {
  return /(?:^|_)(SECRET|TOKEN|PASSWORD|PASS|PRIVATE|CREDENTIAL|API_KEY|ACCESS_KEY|CLIENT_SECRET|JWT|SESSION|AUTH)(?:_|$)/.test(name)
    || /(API_KEY|ACCESS_KEY|CLIENT_SECRET)/.test(name);
}

function isSensitiveStorageKey(key: string | undefined): boolean {
  return !!key && /(?:token|secret|password|session|jwt|auth|credential|api[_-]?key|refresh|access|tenant|user|email|customer|payment|card)/i.test(key);
}

function securityStorageSignal(
  callee: string,
  name: string,
  node: import('ts-morph').CallExpression,
): Omit<SecuritySignal, 'lineRange'> | undefined {
  if (/^(localStorage|sessionStorage)\.(getItem|setItem|removeItem)$/.test(callee) || /^indexedDB\.open$/.test(callee)) {
    const target = firstStringArg(node);
    return {
      kind: isSensitiveStorageKey(target) ? 'browser-storage-sensitive' : 'browser-storage',
      callee,
      target,
    };
  }
  if (/^(get|set|remove)Cookie$/.test(name)) {
    const target = firstStringArg(node);
    return {
      kind: isSensitiveStorageKey(target) ? 'browser-storage-sensitive' : 'cookie-access',
      callee,
      target,
    };
  }
  return undefined;
}

function isValidationImport(source: string): boolean {
  return /(^|\/)(zod|yup|joi|valibot|superstruct|arktype|io-ts|runtypes|class-validator)(\/|$)/i.test(source)
    || /(schema|schemas|validator|validators|validation|guards?)(\/|$)/i.test(source);
}

function isAuthzImport(source: string): boolean {
  return /(authz|authorize|authorization|permission|permissions|roles|policy|policies|access-control|casl|opa)(\/|$)/i.test(source);
}

function isValidationCall(callee: string, name: string): boolean {
  return /^(validate|validateSync|safeParse|parse|parseAsync|assert|assertValid|refine|decode|checkSchema)$/.test(name)
    || /\.(safeParse|parse|validate|validateSync|assert|decode)$/.test(callee)
    || /(?:Schema|Validator|Guard)\.(?:safeParse|parse|validate|check|assert)$/.test(callee);
}

function isAuthzCall(callee: string, name: string): boolean {
  return /^(authorize|requireAuth|requireRole|requirePermission|hasAccess|hasPermission|canAccess|isAllowed|checkPermission|verifyAccess)$/.test(name)
    || /\.(authorize|hasAccess|hasPermission|requirePermission|checkPermission|verifyAccess)$/.test(callee);
}

function isSourceDisclosureCall(
  callee: string,
  name: string,
  node: import('ts-morph').CallExpression,
  text: string,
  rel: string,
): boolean {
  if (!/^(readFile|readFileSync)$/.test(name) && !/\.(readFile|readFileSync)$/.test(callee)) return false;
  const callText = node.getText();
  return /(?:filePath|body|source|raw|lineRange|includeBody|grepBody|privateMembers)/i.test(callText)
    || looksLikeSourceDisclosureModule(rel, text);
}

function looksLikeSourceDisclosureModule(rel: string, text: string): boolean {
  return /(^|\/)(mcp|tools?|handlers?|inspect|dump|graph)(\/|$)/.test(rel)
    && /\b(includeBody|grepBody|privateMembers|readNodeBody|source body|raw source|bodyLimit|bodyOffset)\b/i.test(text);
}

function lineRangeFromTextIndex(text: string, index: number): { start: number; end: number } {
  const line = text.slice(0, Math.max(0, index)).split(/\r?\n/).length;
  return { start: line, end: line };
}

function collectUiHints(sf: SourceFile, relativeFilePath?: string): UiHints | undefined {
  const rel = (relativeFilePath ?? sf.getBaseName()).replace(/\\/g, '/').toLowerCase();
  const text = sf.getFullText();
  const imports = sf.getImportDeclarations()
    .map(imp => importDeclarationSpecifier(imp))
    .filter((source): source is string => source !== undefined);

  const lifecycleEffects: UiLifecycleEffect[] = [];
  const dataAccess: UiDataAccess[] = [];
  const navigation: UiNavigationAction[] = [];
  const timers: UiTimerAction[] = [];
  const subscriptions: UiSubscriptionAction[] = [];
  const state: UiStateSignal[] = [];

  sf.forEachDescendant(node => {
    if (Node.isCallExpression(node)) {
      const callee = node.getExpression().getText();
      const name = lastCalleeSegment(callee);
      const range = nodeLineRange(node);

      const effectKind = lifecycleEffectKind(callee, name);
      if (effectKind) {
        lifecycleEffects.push({ kind: effectKind, name, lineRange: range });
      }

      const data = dataAccessFromCall(callee, name, node);
      if (data) dataAccess.push({ ...data, lineRange: range });

      const nav = navigationFromCall(callee, name, node);
      if (nav) navigation.push({ ...nav, lineRange: range });

      const timer = timerFromCall(callee, name);
      if (timer) timers.push({ ...timer, lineRange: range });

      const subscription = subscriptionFromCall(callee, name);
      if (subscription) subscriptions.push({ ...subscription, lineRange: range });

      const stateSignal = stateFromCall(callee, name, node);
      if (stateSignal) state.push({ ...stateSignal, lineRange: range });
    }

    if (Node.isNewExpression(node)) {
      const expr = node.getExpression().getText();
      const name = lastCalleeSegment(expr);
      const range = nodeLineRange(node);
      if (name === 'WebSocket' || name === 'EventSource') {
        subscriptions.push({ kind: 'websocket', callee: expr, lineRange: range });
      }
      if (/^(BehaviorSubject|ReplaySubject|Subject)$/.test(name)) {
        state.push({ kind: 'rxjs-state', name, lineRange: range });
        subscriptions.push({ kind: 'observable', callee: expr, lineRange: range });
      }
    }

    if (Node.isMethodDeclaration(node)) {
      const name = node.getName();
      if (/^ng(OnInit|OnDestroy|AfterViewInit|AfterViewChecked|AfterContentInit|OnChanges)$/.test(name)) {
        lifecycleEffects.push({
          kind: 'angular-lifecycle',
          name,
          lineRange: nodeLineRange(node),
        });
      }
    }
  });

  const enrichedEffects = lifecycleEffects.map(effect => ({
    ...effect,
    dataAccessCount: countInside(dataAccess, effect.lineRange),
    navigationCount: countInside(navigation, effect.lineRange),
    timerCount: countInside(timers, effect.lineRange),
    subscriptionCount: countInside(subscriptions, effect.lineRange),
  }));

  const serviceWrapper = collectServiceWrapperHint(sf, rel, text);
  const framework = detectUiFramework(rel, imports, sf);
  const components = collectComponentHints(sf, framework, imports, {
    lifecycleEffects: enrichedEffects,
    dataAccess,
    navigation,
    timers,
    subscriptions,
    state,
  });
  const hints: UiHints = {};
  if (framework !== 'unknown') hints.framework = framework;
  if (enrichedEffects.length > 0) hints.lifecycleEffects = enrichedEffects;
  if (dataAccess.length > 0) hints.dataAccess = dedupeBy(dataAccess, itemKey);
  if (navigation.length > 0) hints.navigation = dedupeBy(navigation, itemKey);
  if (timers.length > 0) hints.timers = dedupeBy(timers, itemKey);
  if (subscriptions.length > 0) hints.subscriptions = dedupeBy(subscriptions, itemKey);
  if (state.length > 0) hints.state = dedupeBy(state, itemKey);
  if (serviceWrapper) hints.serviceWrapper = serviceWrapper;
  if (components.length > 0) hints.components = components;

  return Object.keys(hints).length > 0 ? hints : undefined;
}

type ComponentFunction =
  | import('ts-morph').FunctionDeclaration
  | import('ts-morph').FunctionExpression
  | import('ts-morph').ArrowFunction;

interface UiSignalBuckets {
  lifecycleEffects: UiLifecycleEffect[];
  dataAccess: UiDataAccess[];
  navigation: UiNavigationAction[];
  timers: UiTimerAction[];
  subscriptions: UiSubscriptionAction[];
  state: UiStateSignal[];
}

function collectComponentHints(
  sf: SourceFile,
  framework: UiHints['framework'],
  imports: string[],
  signals: UiSignalBuckets,
): UiComponentHint[] {
  if (framework === 'react' || framework === 'next') return collectReactComponentHints(sf, framework, imports, signals);
  if (framework === 'vue' || framework === 'nuxt') return collectVueComponentHints(sf, framework, imports, signals);
  if (framework === 'svelte') return collectSvelteComponentHints(sf, framework, imports, signals);
  if (framework === 'angular') return collectAngularComponentHints(sf, framework, imports, signals);
  return [];
}

function collectReactComponentHints(
  sf: SourceFile,
  framework: 'react' | 'next',
  imports: string[],
  signals: UiSignalBuckets,
): UiComponentHint[] {
  const candidates = collectReactComponentCandidates(sf);
  if (candidates.length === 0) return [];

  const serviceImports = countServiceImports(imports);

  const out: UiComponentHint[] = [];
  for (const candidate of candidates) {
    const body = candidate.fn.getBody();
    if (!body) continue;
    const props = collectAcceptedProps(candidate.fn);
    const propNames = props.map(prop => prop.name);
    const childComponents = collectChildComponents(body, propNames);
    const range = nodeLineRange(candidate.ownerNode);
    const bodyText = body.getText();
    const validationOrMapping = countValidationOrMapping(sf, bodyText, body.getStart());

    if (props.length === 0 && childComponents.length === 0) continue;

    out.push({
      framework,
      name: candidate.name,
      props,
      childComponents,
      localSignals: localSignalsForRange(signals, range, serviceImports, validationOrMapping),
      lineRange: range,
    });
  }
  return out;
}

function collectVueComponentHints(
  sf: SourceFile,
  framework: 'vue' | 'nuxt',
  imports: string[],
  signals: UiSignalBuckets,
): UiComponentHint[] {
  const text = sf.getFullText();
  const template = sfcTemplateFromVirtualSource(text);
  const props = collectVueProps(text);
  if (props.length === 0 && !template) return [];
  const range = sourceFileRange(sf);
  const componentName = componentNameFromPath(sf.getFilePath());
  return [{
    framework,
    name: componentName,
    props,
    childComponents: template ? collectVueTemplateChildren(template, props.map(prop => prop.name)) : [],
    localSignals: localSignalsForRange(signals, range, countServiceImports(imports), countValidationOrMapping(sf, text)),
    lineRange: range,
  }];
}

function collectSvelteComponentHints(
  sf: SourceFile,
  framework: 'svelte',
  imports: string[],
  signals: UiSignalBuckets,
): UiComponentHint[] {
  const text = sf.getFullText();
  const template = sfcTemplateFromVirtualSource(text);
  const props = collectSvelteProps(sf);
  if (props.length === 0 && !template) return [];
  const range = sourceFileRange(sf);
  return [{
    framework,
    name: componentNameFromPath(sf.getFilePath()),
    props,
    childComponents: template ? collectSvelteTemplateChildren(template, props.map(prop => prop.name)) : [],
    localSignals: localSignalsForRange(signals, range, countServiceImports(imports), countValidationOrMapping(sf, text)),
    lineRange: range,
  }];
}

function collectAngularComponentHints(
  sf: SourceFile,
  framework: 'angular',
  imports: string[],
  signals: UiSignalBuckets,
): UiComponentHint[] {
  const out: UiComponentHint[] = [];
  for (const cls of sf.getClasses()) {
    if (!cls.getDecorators().some(dec => dec.getName() === 'Component')) continue;
    const range = nodeLineRange(cls);
    const props = collectAngularProps(cls);
    const template = angularInlineTemplate(cls);
    out.push({
      framework,
      name: cls.getName() ?? componentNameFromPath(sf.getFilePath()),
      props,
      childComponents: template ? collectAngularTemplateChildren(template, props.map(prop => prop.name)) : [],
      localSignals: localSignalsForRange(signals, range, countServiceImports(imports), countValidationOrMapping(sf, cls.getText(), cls.getStart())),
      lineRange: range,
    });
  }
  return out;
}

function collectReactComponentCandidates(sf: SourceFile): Array<{ name: string; fn: ComponentFunction; ownerNode: Node }> {
  const candidates: Array<{ name: string; fn: ComponentFunction; ownerNode: Node }> = [];
  const add = (name: string | undefined, fn: ComponentFunction, ownerNode: Node): void => {
    if (!name || !isPascalCase(name)) return;
    const body = fn.getBody();
    if (!body || !looksLikeJsxComponent(body.getText())) return;
    candidates.push({ name, fn, ownerNode });
  };

  sf.forEachChild(node => {
    if (Node.isFunctionDeclaration(node)) {
      add(node.getName(), node, node);
      return;
    }
    if (!Node.isVariableStatement(node)) return;
    for (const decl of node.getDeclarations()) {
      const init = decl.getInitializer();
      if (!init || (!Node.isArrowFunction(init) && !Node.isFunctionExpression(init))) continue;
      add(decl.getName(), init, decl);
    }
  });

  return candidates;
}

function looksLikeJsxComponent(text: string): boolean {
  return /return\s*\(?\s*</.test(text) || /^<[\w.]+[\s>]/.test(text.trim()) || /<React\.Fragment[\s>]/.test(text);
}

function collectAcceptedProps(fn: ComponentFunction): UiComponentPropHint[] {
  const props = new Map<string, UiComponentPropHint>();
  const addProp = (name: string, source: UiComponentPropHint['source'], lineRange?: { start: number; end: number }): void => {
    if (!isUsefulPropName(name)) return;
    const current = props.get(name);
    if (current && current.source !== 'type-only') return;
    props.set(name, {
      name,
      kind: propKind(name),
      source,
      ...(lineRange ? { lineRange } : {}),
    });
  };

  const firstParam = fn.getParameters()[0];
  const body = fn.getBody();
  if (!firstParam || !body) return [];

  const nameNode = firstParam.getNameNode();
  let propsObjectName: string | undefined;
  if (Node.isObjectBindingPattern(nameNode)) {
    collectBindingPatternProps(nameNode, 'destructured-param', addProp);
  } else if (Node.isIdentifier(nameNode)) {
    propsObjectName = nameNode.getText();
  }

  if (propsObjectName) {
    const propAccessPattern = new RegExp(`\\b${escapeRegExp(propsObjectName)}\\.([A-Za-z_$][\\w$]*)`, 'g');
    for (const match of body.getText().matchAll(propAccessPattern)) {
      addProp(match[1], 'props-object', nodeLineRange(firstParam));
    }

    body.forEachDescendant(node => {
      if (!Node.isVariableDeclaration(node)) return;
      const init = node.getInitializer();
      if (!init || init.getText() !== propsObjectName) return;
      const localName = node.getNameNode();
      if (Node.isObjectBindingPattern(localName)) {
        collectBindingPatternProps(localName, 'props-object', addProp);
      }
    });
  }

  if (props.size === 0) {
    for (const name of propsFromTypeNode(firstParam.getTypeNode()?.getText())) {
      addProp(name, 'type-only', nodeLineRange(firstParam));
    }
  }

  return [...props.values()].sort((a, b) => compareCodeUnits(a.name, b.name));
}

function collectBindingPatternProps(
  pattern: import('ts-morph').ObjectBindingPattern,
  source: UiComponentPropHint['source'],
  addProp: (name: string, source: UiComponentPropHint['source'], lineRange?: { start: number; end: number }) => void,
): void {
  for (const el of pattern.getElements()) {
    if (el.getText().trim().startsWith('...')) continue;
    const propName = el.getPropertyNameNode()?.getText() ?? el.getNameNode().getText();
    addProp(propName, source, nodeLineRange(el));
  }
}

function propsFromTypeNode(typeText: string | undefined): string[] {
  if (!typeText || !typeText.includes('{')) return [];
  const out: string[] = [];
  const fieldPattern = /([A-Za-z_$][\w$]*)\??\s*:/g;
  for (const match of typeText.matchAll(fieldPattern)) out.push(match[1]);
  return out;
}

function collectChildComponents(body: Node, propNames: string[]): UiChildComponentHint[] {
  const children: UiChildComponentHint[] = [];
  const seen = new Set<string>();
  const inspect = (node: Node): void => {
    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) {
      const componentName = node.getTagNameNode().getText();
      if (!isComponentTag(componentName)) return;

      const passedProps = new Set<string>();
      const passedCallbacks = new Set<string>();
      const forwardedProps = new Set<string>();
      const spreadProps = new Set<string>();

      for (const attr of node.getAttributes()) {
        if (Node.isJsxAttribute(attr)) {
          const attrName = attr.getNameNode().getText();
          if (attrName === 'key' || attrName === 'ref') continue;
          passedProps.add(attrName);
          if (isCallbackLikeName(attrName)) passedCallbacks.add(attrName);

          const exprText = jsxAttributeExpressionText(attr);
          if (!exprText) continue;
          for (const propName of referencedPropNames(exprText, propNames)) {
            forwardedProps.add(propName);
            if (isCallbackLikeName(propName)) passedCallbacks.add(propName);
          }
        } else if (Node.isJsxSpreadAttribute(attr)) {
          const exprText = attr.getExpression().getText();
          spreadProps.add(exprText);
          if (propNames.includes(exprText)) forwardedProps.add(exprText);
          if (exprText === 'props') {
            for (const propName of propNames) forwardedProps.add(propName);
          }
        }
      }

      const key = `${componentName}:${node.getStartLineNumber()}:${[...passedProps].sort().join(',')}`;
      if (seen.has(key)) return;
      seen.add(key);
      children.push({
        componentName,
        passedProps: [...passedProps].sort(),
        passedCallbacks: [...passedCallbacks].sort(),
        forwardedProps: [...forwardedProps].sort(),
        spreadProps: [...spreadProps].sort(),
        lineRange: nodeLineRange(node),
      });
    }
  };

  inspect(body);
  body.forEachDescendant(inspect);
  return children;
}

function jsxAttributeExpressionText(attr: import('ts-morph').JsxAttribute): string | undefined {
  const init = attr.getInitializer();
  if (!init) return undefined;
  if (Node.isStringLiteral(init)) return init.getLiteralValue();
  if (Node.isJsxExpression(init)) return init.getExpression()?.getText();
  return init.getText();
}

function referencedPropNames(exprText: string, propNames: string[]): string[] {
  const out: string[] = [];
  for (const propName of propNames) {
    const escaped = escapeRegExp(propName);
    if (
      new RegExp(`^${escaped}$`).test(exprText)
      || new RegExp(`\\b${escaped}\\b`).test(exprText)
      || new RegExp(`\\bprops\\.${escaped}\\b`).test(exprText)
    ) {
      out.push(propName);
    }
  }
  return out;
}

function collectVueProps(text: string): UiComponentPropHint[] {
  const props = new Map<string, UiComponentPropHint>();
  const add = (name: string): void => {
    if (!isUsefulPropName(name)) return;
    props.set(name, { name, kind: propKind(name), source: 'unknown' });
  };

  for (const match of text.matchAll(/defineProps\s*<\s*\{([\s\S]*?)\}\s*>\s*\(/g)) {
    for (const name of propsFromTypeNode(`{${match[1]}}`)) add(name);
  }
  for (const match of text.matchAll(/defineProps\s*\(\s*\[([\s\S]*?)\]\s*\)/g)) {
    for (const stringMatch of match[1].matchAll(/['"]([A-Za-z_$][\w$]*)['"]/g)) add(stringMatch[1]);
  }
  for (const match of text.matchAll(/defineProps\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
    for (const propMatch of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) add(propMatch[1]);
  }
  return [...props.values()].sort((a, b) => compareCodeUnits(a.name, b.name));
}

function collectSvelteProps(sf: SourceFile): UiComponentPropHint[] {
  const props = new Map<string, UiComponentPropHint>();
  sf.forEachChild(node => {
    if (!Node.isVariableStatement(node)) return;
    if (!node.hasExportKeyword()) return;
    for (const decl of node.getDeclarations()) {
      const name = decl.getName();
      if (!isUsefulPropName(name)) continue;
      props.set(name, {
        name,
        kind: propKind(name),
        source: 'unknown',
        lineRange: nodeLineRange(decl),
      });
    }
  });
  return [...props.values()].sort((a, b) => compareCodeUnits(a.name, b.name));
}

function collectAngularProps(cls: import('ts-morph').ClassDeclaration): UiComponentPropHint[] {
  const props: UiComponentPropHint[] = [];
  for (const prop of cls.getProperties()) {
    const decorators = prop.getDecorators().map(dec => dec.getName());
    if (!decorators.includes('Input') && !decorators.includes('Output')) continue;
    const name = prop.getName();
    if (!isUsefulPropName(name)) continue;
    props.push({
      name,
      kind: decorators.includes('Output') ? 'callback' : propKind(name),
      source: 'unknown',
      lineRange: nodeLineRange(prop),
    });
  }
  return props.sort((a, b) => compareCodeUnits(a.name, b.name));
}

function collectVueTemplateChildren(template: string, propNames: string[]): UiChildComponentHint[] {
  return collectTemplateChildren(template, propNames, {
    propAttr: /^(?::|v-bind:)([A-Za-z_$][\w$-]*)$/,
    eventAttr: /^(?:@|v-on:)([A-Za-z_$][\w$-]*)$/,
    spreadAttr: /^v-bind$/,
  });
}

function collectSvelteTemplateChildren(template: string, propNames: string[]): UiChildComponentHint[] {
  return collectTemplateChildren(template, propNames, {
    propAttr: /^([A-Za-z_$][\w$-]*)$/,
    eventAttr: /^on:([A-Za-z_$][\w$-]*)$/,
    spreadAttr: /^$/,
    shorthandProps: true,
  });
}

function collectAngularTemplateChildren(template: string, propNames: string[]): UiChildComponentHint[] {
  return collectTemplateChildren(template, propNames, {
    propAttr: /^\[([A-Za-z_$][\w$-]*)\]$/,
    eventAttr: /^\(([A-Za-z_$][\w$-]*)\)$/,
    spreadAttr: /^$/,
  });
}

interface TemplateParseOptions {
  propAttr: RegExp;
  eventAttr: RegExp;
  spreadAttr: RegExp;
  shorthandProps?: boolean;
}

function collectTemplateChildren(template: string, propNames: string[], options: TemplateParseOptions): UiChildComponentHint[] {
  const children: UiChildComponentHint[] = [];
  const tagRe = /<([A-Z][\w.]*|[a-z][\w]*-[\w-]+)\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(template)) !== null) {
    const componentName = normalizeTemplateComponentName(match[1]);
    const attrs = match[2] ?? '';
    const passedProps = new Set<string>();
    const passedCallbacks = new Set<string>();
    const forwardedProps = new Set<string>();
    const spreadProps = new Set<string>();

    for (const attr of parseTemplateAttributes(attrs)) {
      if (options.shorthandProps && attr.name.startsWith('{') && attr.name.endsWith('}')) {
        const propName = attr.name.slice(1, -1).trim();
        if (isUsefulPropName(propName)) {
          passedProps.add(propName);
          if (propNames.includes(propName)) forwardedProps.add(propName);
          if (isCallbackLikeName(propName)) passedCallbacks.add(propName);
        }
        continue;
      }

      const propMatch = attr.name.match(options.propAttr);
      if (propMatch) {
        const propName = propMatch[1] ?? attr.name;
        passedProps.add(propName);
        for (const forwarded of referencedPropNames(attr.value ?? '', propNames)) {
          forwardedProps.add(forwarded);
          if (isCallbackLikeName(forwarded)) passedCallbacks.add(forwarded);
        }
        continue;
      }

      const eventMatch = attr.name.match(options.eventAttr);
      if (eventMatch) {
        const eventName = eventMatch[1];
        const callbackName = eventName.startsWith('on') ? eventName : `on${eventName[0]?.toUpperCase() ?? ''}${eventName.slice(1)}`;
        passedCallbacks.add(callbackName);
        for (const forwarded of referencedPropNames(attr.value ?? '', propNames)) {
          forwardedProps.add(forwarded);
          passedCallbacks.add(isCallbackLikeName(forwarded) ? forwarded : callbackName);
        }
        continue;
      }

      if (options.spreadAttr.test(attr.name)) {
        spreadProps.add(attr.value ?? attr.name);
        for (const forwarded of referencedPropNames(attr.value ?? '', propNames)) forwardedProps.add(forwarded);
      }
    }

    children.push({
      componentName,
      passedProps: [...passedProps].sort(),
      passedCallbacks: [...passedCallbacks].sort(),
      forwardedProps: [...forwardedProps].sort(),
      spreadProps: [...spreadProps].sort(),
      lineRange: { start: lineNumberAt(template, match.index ?? 0), end: lineNumberAt(template, (match.index ?? 0) + match[0].length) },
    });
  }
  return children;
}

function parseTemplateAttributes(attrs: string): Array<{ name: string; value?: string }> {
  const parsed: Array<{ name: string; value?: string }> = [];
  const attrRe = new RegExp(
    '(\\{[A-Za-z_$][\\w$]*\\}|(?:\\[[^\\]]+\\]|\\([^)]+\\)|[@:]?[A-Za-z_$][\\w$:-]*|v-(?:bind|on)(?::[A-Za-z_$][\\w$-]*)?))'
    + '(?:\\s*=\\s*(?:"([^"]*)"|\\\'([^\\\']*)\\\'|\\{([^}]*)\\}))?',
    'g',
  );
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrs)) !== null) {
    parsed.push({ name: match[1], value: match[2] ?? match[3] ?? match[4] });
  }
  return parsed;
}

function normalizeTemplateComponentName(name: string): string {
  if (!name.includes('-')) return name;
  return name.split('-').filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join('');
}

function angularInlineTemplate(cls: import('ts-morph').ClassDeclaration): string | undefined {
  const componentDecorator = cls.getDecorators().find(dec => dec.getName() === 'Component');
  const arg = componentDecorator?.getCallExpression()?.getArguments()[0];
  if (!arg || !Node.isObjectLiteralExpression(arg)) return undefined;
  const templateProp = arg.getProperty('template');
  if (!templateProp || !Node.isPropertyAssignment(templateProp)) return undefined;
  const init = templateProp.getInitializer();
  if (!init) return undefined;
  if (Node.isStringLiteral(init) || Node.isNoSubstitutionTemplateLiteral(init)) return init.getLiteralText();
  return init.getText().replace(/^`|`$/g, '');
}

function sfcTemplateFromVirtualSource(text: string): string | undefined {
  const match = text.match(/\bconst\s+__REPOVINE_SFC_TEMPLATE__\s*=\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|(?:`[\s\S]*?`))\s*;/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return match[1].slice(1, -1);
  }
}

function componentNameFromPath(filePath: string): string {
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? 'Component';
  return normalizeTemplateComponentName(base.replace(/\.(vue|svelte)\.ts$/i, '').replace(/\.(vue|svelte|tsx?|jsx?)$/i, ''));
}

function sourceFileRange(sf: SourceFile): { start: number; end: number } {
  return { start: 1, end: sf.getEndLineNumber() };
}

function countServiceImports(imports: string[]): number {
  return imports.filter(source =>
    /(^|\/)(api|apis|clients?|sdk|services?|repositories?|stores?|state)(\/|$)/i.test(source)
    || /(?:api|client|service|store|repository|repo|sdk)(?:[-_.]|$)/i.test(source),
  ).length;
}

/** Bare identifier names, so a comment describing what a component validates counts as validation.
 *  The count crosses a `> 0` threshold at `component-signals.ts:17` and becomes a
 *  `validation/mapping` label, so prose inflating it states something untrue. */
const VALIDATION_OR_MAPPING_PATTERN = /\b(validate[A-Za-z0-9_]*|validator|parse[A-Za-z0-9_]*|assert[A-Za-z0-9_]*|map[A-Za-z0-9_]*|mapper|mapping|normalize[A-Za-z0-9_]*|transform[A-Za-z0-9_]*|serialize[A-Za-z0-9_]*|deserialize[A-Za-z0-9_]*|format[A-Za-z0-9_]*|can[A-Z][A-Za-z0-9_]*|should[A-Z][A-Za-z0-9_]*|is[A-Z][A-Za-z0-9_]*Allowed)\b/g;

function countValidationOrMapping(sf: SourceFile, scopeText: string, base = 0): number {
  return countOutsideProse(sf, scopeText, VALIDATION_OR_MAPPING_PATTERN, base);
}

function localSignalsForRange(
  signals: UiSignalBuckets,
  range: { start: number; end: number },
  serviceImports: number,
  validationOrMapping: number,
): UiComponentHint['localSignals'] {
  return {
    localState: countInside(signals.state, range) ?? 0,
    effects: countInside(signals.lifecycleEffects, range) ?? 0,
    dataAccess: countInside(signals.dataAccess, range) ?? 0,
    navigation: countInside(signals.navigation, range) ?? 0,
    timers: countInside(signals.timers, range) ?? 0,
    subscriptions: countInside(signals.subscriptions, range) ?? 0,
    serviceImports,
    validationOrMapping,
  };
}

function isComponentTag(name: string): boolean {
  const first = name.split('.')[0];
  return isPascalCase(first) || first === 'React';
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9_$]*$/.test(name);
}

function isUsefulPropName(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'children' && name !== 'className' && name !== 'style';
}

function propKind(name: string): UiComponentPropHint['kind'] {
  if (/^set[A-Z]/.test(name)) return 'setter';
  if (isCallbackLikeName(name)) return 'callback';
  if (/^(is|has|can|should|disabled|loading|pending|error|open|visible|selected|active|dirty|valid)[A-Z_]/.test(name)) return 'state-flag';
  return 'data';
}

function isCallbackLikeName(name: string): boolean {
  return /^(on[A-Z]|handle[A-Z]|set[A-Z]|dispatch[A-Z]|submit[A-Z]?|save[A-Z]?|delete[A-Z]?|remove[A-Z]?)/.test(name);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Real JSX in the syntax tree. The `.tsx`/`.jsx` extension alone is a weak signal, so React
 * detection needs evidence of JSX in the file; a `<Widget>` written inside a string or a comment
 * is prose about a component, not a use of one.
 */
function hasJsxSyntax(sf: SourceFile): boolean {
  return sf.getFirstDescendantByKind(SyntaxKind.JsxElement) !== undefined
    || sf.getFirstDescendantByKind(SyntaxKind.JsxSelfClosingElement) !== undefined
    || sf.getFirstDescendantByKind(SyntaxKind.JsxFragment) !== undefined;
}

function detectUiFramework(
  rel: string,
  imports: string[],
  sf: SourceFile,
): UiHints['framework'] {
  // Angular needs an `@angular/*` import, not a filename suffix. `.service.ts` and `.module.ts` are
  // NestJS convention as much as Angular's, so the suffix alone labelled every Nest service as an
  // Angular frontend module. Genuine Angular components, services, modules, directives and pipes all
  // import their decorator from `@angular/core`. The suffix still drives domain promotion, which is
  // a separate mechanism and keeps its fixture-documented behaviour.
  if (imports.some(source => source.startsWith('@angular/'))) return 'angular';
  if (imports.some(source => source === 'next' || source.startsWith('next/')) || /(^|\/)app\/.+\.(tsx?|jsx?)$/.test(rel)) return 'next';
  if (imports.some(source => source === 'nuxt' || source.startsWith('#') || source.startsWith('nuxt/')) || /(^|\/)(pages|layouts|composables)\//.test(rel) && rel.endsWith('.vue')) return 'nuxt';
  if (imports.some(source => source === 'react' || source.startsWith('react/')) || /\.(tsx|jsx)$/.test(rel) && hasJsxSyntax(sf)) return 'react';
  if (imports.some(source => source === 'vue' || source.startsWith('vue/')) || rel.endsWith('.vue')) return 'vue';
  if (imports.some(source => source === 'svelte' || source.startsWith('svelte/')) || rel.endsWith('.svelte')) return 'svelte';
  return 'unknown';
}

function lifecycleEffectKind(
  callee: string,
  name: string,
): UiLifecycleEffect['kind'] | undefined {
  if (/^(useEffect|useLayoutEffect|useInsertionEffect)$/.test(name)) return 'react-effect';
  if (/^(watch|watchEffect)$/.test(name)) return 'vue-watch';
  if (/^on(Mounted|Unmounted|Updated|BeforeMount|BeforeUnmount|BeforeUpdate|Activated|Deactivated)$/.test(name)) return 'vue-lifecycle';
  if (/^(onMount|onDestroy|beforeUpdate|afterUpdate)$/.test(name)) return 'svelte-lifecycle';
  if (name === 'effect' && /\bangular\b/.test(callee.toLowerCase())) return 'angular-lifecycle';
  return undefined;
}

function dataAccessFromCall(
  callee: string,
  name: string,
  node: import('ts-morph').CallExpression,
): Omit<UiDataAccess, 'lineRange'> | undefined {
  const target = firstStringArg(node);
  if (name === 'fetch') return { kind: 'fetch', callee, target };
  if (/^use(Infinite)?Query$/.test(name) || /^(useAsyncData|useFetch)$/.test(name)) {
    return { kind: 'query', callee, target };
  }
  if (/^(useMutation|mutate|mutateAsync)$/.test(name) || /\.(mutate|mutateAsync)$/.test(callee)) {
    return { kind: 'mutation', callee, target };
  }
  if (/^(gql|graphql)$/.test(name) || /\.(graphql|gql)$/.test(callee)) {
    return { kind: 'graphql', callee, target };
  }
  if (/^(localStorage|sessionStorage)\.(getItem|setItem|removeItem)$/.test(callee) || /^indexedDB\.open$/.test(callee)) {
    return { kind: 'storage', callee, target };
  }
  if (
    /^axios(?:\.|$)/.test(callee)
    || /(?:api|client|sdk|http|request)\.(get|post|put|patch|delete|request)$/i.test(callee)
    || /^this\.http\.(get|post|put|patch|delete|request)$/.test(callee)
  ) {
    return { kind: /\.(post|put|patch|delete)$/.test(callee) ? 'mutation' : 'http-client', callee, target };
  }
  if (/(api|client|sdk)\.(query|mutation|request|execute|send|post|put|patch|delete|get)$/.test(callee)) {
    return { kind: /\.(post|put|patch|delete|mutation|send|execute)$/.test(callee) ? 'mutation' : 'api-client', callee, target };
  }
  return undefined;
}

function navigationFromCall(
  callee: string,
  name: string,
  node: import('ts-morph').CallExpression,
): Omit<UiNavigationAction, 'lineRange'> | undefined {
  const target = firstStringArg(node);
  if (name === 'navigate' || /\.navigate$/.test(callee)) return { kind: 'navigate', callee, target };
  if (/^(push|replace)$/.test(name) && /\.(router|history|navigation)\.(push|replace)$/.test(callee)) {
    return { kind: callee.includes('history.') ? 'history' : 'router-push', callee, target };
  }
  if (name === 'redirect') return { kind: 'redirect', callee, target };
  if (name === 'goto') return { kind: 'navigate', callee, target };
  return undefined;
}

function timerFromCall(callee: string, name: string): Omit<UiTimerAction, 'lineRange'> | undefined {
  if (name === 'setTimeout') return { kind: 'timeout', callee };
  if (name === 'setInterval') return { kind: 'interval', callee };
  if (name === 'requestAnimationFrame') return { kind: 'animation-frame', callee };
  return undefined;
}

function subscriptionFromCall(
  callee: string,
  name: string,
): Omit<UiSubscriptionAction, 'lineRange'> | undefined {
  if (name === 'addEventListener') return { kind: 'event-listener', callee };
  if (name === 'subscribe') return { kind: 'observable', callee };
  if (/^(onSnapshot|onValue|onAuthStateChanged)$/.test(name)) return { kind: 'realtime', callee };
  return undefined;
}

function stateFromCall(
  callee: string,
  name: string,
  node: import('ts-morph').CallExpression,
): Omit<UiStateSignal, 'lineRange'> | undefined {
  if (name === 'useState') return { kind: 'react-state', name: assignedName(node) };
  if (name === 'useReducer') return { kind: 'react-reducer', name: assignedName(node) };
  if (name === 'createContext' || name === 'useContext') return { kind: 'react-context', name: assignedName(node) };
  if (name === 'ref' || name === 'shallowRef' || name === 'computed') return { kind: 'vue-ref', name: assignedName(node) };
  if (name === 'reactive') return { kind: 'vue-reactive', name: assignedName(node) };
  if (name === 'provide' || name === 'inject') return { kind: 'vue-provide', name: assignedName(node) };
  if (/^(writable|readable|derived)$/.test(name)) return { kind: 'svelte-store', name: assignedName(node) };
  if (name === 'signal' || name === 'computedSignal') return { kind: 'angular-service-state', name: assignedName(node) };
  return undefined;
}

/** Delegate-call patterns are bare method names, so a comment describing what a wrapper delegates
 *  counts as delegation. The count is reported as a fact about the module, so prose inflating it
 *  states something untrue rather than merely over-reporting. */
const DELEGATE_CALL_PATTERN = /\.(?:get|post|put|patch|delete|request|send|execute|mutate|query|fetch)\s*\(/g;
const BARE_FETCH_PATTERN = /\bfetch\s*\(/g;

/**
 * Matches of `pattern` that are real code rather than prose. `scopeText` may be a substring of the
 * file — a component body, a class — in which case `base` is its offset, so both guards receive
 * absolute positions. The comment guard needs the whole file: a substring cannot tell whether a
 * comment opened before it started.
 */
function countOutsideProse(sf: SourceFile, scopeText: string, pattern: RegExp, base = 0): number {
  const fullText = sf.getFullText();
  pattern.lastIndex = 0;
  let count = 0;
  for (const match of scopeText.matchAll(pattern)) {
    const at = base + (match.index ?? 0);
    if (isInsideLiteral(sf, at) || isInsideComment(fullText, at)) continue;
    count += 1;
  }
  return count;
}

function collectServiceWrapperHint(
  sf: SourceFile,
  rel: string,
  text: string,
): UiHints['serviceWrapper'] | undefined {
  const file = rel.split('/').pop() ?? rel;
  const role =
    /(?:^|[-_.])api(?:[-_.]|$)|(^|\/)api\//.test(rel) ? 'api'
    : /(?:^|[-_.])client(?:[-_.]|$)|(^|\/)(clients?|sdk)\//.test(rel) ? 'client'
    : /(?:^|[-_.])adapter(?:[-_.]|$)|(^|\/)adapters?\//.test(rel) ? 'adapter'
    : /(?:^|[-_.])manager(?:[-_.]|$)|(^|\/)managers?\//.test(rel) ? 'manager'
    : /(?:^|[-_.])provider(?:[-_.]|$)|(^|\/)providers?\//.test(rel) ? 'provider'
    : /(?:^|[-_.])service(?:[-_.]|$)|(^|\/)services?\//.test(rel) ? 'service'
    : undefined;
  if (!role || /(?:^|[-_.])(test|spec|mock|types?|schema)(?:[-_.]|$)/.test(file)) return undefined;
  const lineCount = text.split(/\r?\n/).length;
  const delegateCallCount = countOutsideProse(sf, text, DELEGATE_CALL_PATTERN)
    + countOutsideProse(sf, text, BARE_FETCH_PATTERN);
  return {
    candidate: true,
    role,
    lineCount,
    delegateCallCount,
  };
}

function lastCalleeSegment(callee: string): string {
  return callee
    .replace(/\?\./g, '.')
    .split('.')
    .pop()
    ?.replace(/[^A-Za-z0-9_$].*$/, '') ?? callee;
}

function nodeLineRange(node: Node): { start: number; end: number } {
  return { start: node.getStartLineNumber(), end: node.getEndLineNumber() };
}

function firstStringArg(node: import('ts-morph').CallExpression): string | undefined {
  for (const arg of node.getArguments()) {
    const literal = firstStringLiteral(arg);
    if (literal) return literal;
  }
  return undefined;
}

function firstStringLiteral(node: Node): string | undefined {
  if (Node.isStringLiteral(node)) return node.getLiteralValue();
  if (Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralText();
  if (Node.isArrayLiteralExpression(node)) {
    for (const el of node.getElements()) {
      const nested = firstStringLiteral(el);
      if (nested) return nested;
    }
  }
  return undefined;
}

function assignedName(node: import('ts-morph').CallExpression): string | undefined {
  const parent = node.getParent();
  if (parent && Node.isVariableDeclaration(parent)) return parent.getName();
  return undefined;
}

function countInside<T extends { lineRange?: { start: number; end: number } }>(
  items: T[],
  range?: { start: number; end: number },
): number | undefined {
  if (!range) return undefined;
  const count = items.filter(item =>
    item.lineRange &&
    item.lineRange.start >= range.start &&
    item.lineRange.end <= range.end,
  ).length;
  return count > 0 ? count : undefined;
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function itemKey(item: { lineRange?: { start: number; end: number }; kind?: string; callee?: string; name?: string; target?: string }): string {
  return [
    item.kind ?? '',
    item.callee ?? '',
    item.name ?? '',
    item.target ?? '',
    item.lineRange?.start ?? '',
    item.lineRange?.end ?? '',
  ].join(':');
}

interface RuntimeActionPattern {
  action: RuntimeAction['action'];
  pattern: RegExp;
  targetKeys: string[];
}

const RUNTIME_ACTION_PATTERNS: RuntimeActionPattern[] = [
  { action: 'sqs.sendMessage', pattern: /\b(?:SendMessageCommand|SendMessageBatchCommand|sendMessage|sendMessageBatch)\b/g, targetKeys: ['QueueUrl'] },
  { action: 'sns.publish', pattern: /\b(?:PublishCommand|publish)\b/g, targetKeys: ['TopicArn', 'TargetArn'] },
  { action: 'eventbridge.putEvents', pattern: /\b(?:PutEventsCommand|putEvents)\b/g, targetKeys: ['EventBusName'] },
  { action: 'lambda.invoke', pattern: /\b(?:InvokeCommand|invoke)\b/g, targetKeys: ['FunctionName'] },
];

/**
 * True when `index` falls inside a literal, per the real syntax tree rather than a character scan.
 * Covers template literals, which a quote-character scanner cannot see: a module made of prose
 * template strings would otherwise have every runtime-action keyword in its prose counted as a
 * call. Text inside a `${…}` interpolation resolves to the interpolated node, not to a template
 * part, so genuine calls there are still detected.
 */
function isInsideLiteral(sf: SourceFile, index: number): boolean {
  const kind = sf.getDescendantAtPos(index)?.getKindName();
  return kind === 'StringLiteral'
    || kind === 'NoSubstitutionTemplateLiteral'
    || kind === 'TemplateHead'
    || kind === 'TemplateMiddle'
    || kind === 'TemplateTail'
    || kind === 'RegularExpressionLiteral';
}

function collectRuntimeActions(text: string, sf: SourceFile): RuntimeAction[] {
  const actions: RuntimeAction[] = [];
  const seen = new Set<string>();
  const envAliases = collectEnvAliases(text);

  for (const actionPattern of RUNTIME_ACTION_PATTERNS) {
    actionPattern.pattern.lastIndex = 0;
    for (const match of text.matchAll(actionPattern.pattern)) {
      const index = match.index ?? 0;
      // Skip tokens inside any literal (quoted OR template — prose modules are all template) or a comment.
      if (isInsideLiteral(sf, index) || isInsideComment(text, index)) continue;
      const envVar = envVarForRuntimeCall(text, index, actionPattern.targetKeys, envAliases)
        ?? nearestEnvVar(text, index, envAliases);
      const line = lineNumberAt(text, index);
      const key = `${actionPattern.action}:${envVar ?? ''}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      actions.push({
        action: actionPattern.action,
        ...(envVar ? { envVar } : {}),
        lineRange: { start: line, end: line },
      });
    }
  }

  return actions;
}

function collectEnvAliases(text: string): Map<string, string> {
  const aliases = new Map<string, string>();
  const directEnv = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\])/g;
  for (const match of text.matchAll(directEnv)) {
    aliases.set(match[1], match[2] ?? match[3]);
  }
  return aliases;
}

function envVarForRuntimeCall(
  text: string,
  index: number,
  targetKeys: string[],
  envAliases: Map<string, string>,
): string | undefined {
  const start = Math.max(0, index - 250);
  const end = Math.min(text.length, index + 1200);
  const windowText = text.slice(start, end);

  for (const key of targetKeys) {
    const targetPattern = new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`, 'g');
    for (const match of windowText.matchAll(targetPattern)) {
      const envVar = envVarFromExpression(match[1], envAliases);
      if (envVar) return envVar;
    }
  }
  return undefined;
}

function envVarFromExpression(expr: string, envAliases: Map<string, string>): string | undefined {
  const direct = expr.match(/process\.env\.([A-Z][A-Z0-9_]*)/) ?? expr.match(/process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/);
  if (direct) return direct[1];

  const identifier = expr.trim().match(/^([A-Za-z_$][\w$]*)\b/);
  if (!identifier) return undefined;
  const name = identifier[1];
  return envAliases.get(name);
}

function nearestEnvVar(text: string, index: number, envAliases: Map<string, string>): string | undefined {
  const start = Math.max(0, index - 900);
  const end = Math.min(text.length, index + 900);
  const windowText = text.slice(start, end);
  let best: { envVar: string; distance: number } | undefined;
  for (const match of windowText.matchAll(ENV_PROCESS_PATTERN)) {
    const envVar = match[1];
    const absolute = start + (match.index ?? 0);
    const distance = Math.abs(absolute - index);
    if (!best || distance < best.distance) best = { envVar, distance };
  }
  for (const [alias, envVar] of envAliases) {
    const aliasIdx = windowText.indexOf(alias);
    if (aliasIdx < 0) continue;
    const absolute = start + aliasIdx;
    const distance = Math.abs(absolute - index);
    if (!best || distance < best.distance) best = { envVar, distance };
  }
  return best?.envVar;
}

function isCharEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

/** True when `index` lies inside a line or block comment. */
function isInsideComment(text: string, index: number): boolean {
  let inSingle = false;
  let inDouble = false;
  let inBlock = false;
  let inLine = false;
  for (let i = 0; i < index; i++) {
    if (inLine) {
      if (text[i] === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (text[i] === '*' && text[i + 1] === '/') {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (!inSingle && !inDouble) {
      if (text[i] === '/' && text[i + 1] === '/') {
        inLine = true;
        i++;
        continue;
      }
      if (text[i] === '/' && text[i + 1] === '*') {
        inBlock = true;
        i++;
        continue;
      }
    }
    if (!isCharEscaped(text, i)) {
      const ch = text[i];
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
    }
  }
  return inLine || inBlock;
}


function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}
