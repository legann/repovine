import { Node, ts, type CallExpression, type SourceFile } from 'ts-morph';

const IGNORED_CALLS = new Set([
  'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug',
  'JSON.stringify', 'JSON.parse', 'Object.keys', 'Object.values', 'Object.entries',
  'Object.assign', 'Object.fromEntries', 'Array.isArray', 'Array.from',
  'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'toString',
  'Promise.all', 'Promise.resolve', 'Promise.reject', 'Promise.allSettled',
  'Math.max', 'Math.min', 'Math.floor', 'Math.ceil', 'Math.round',
  'Date.now', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'require', 'Map', 'Set', 'Error', 'TypeError', 'RegExp',
]);

/** Max call names kept per bucket (per exported declaration, and the module bucket). */
const PER_BUCKET_CAP = 50;

/** Attribution of a module's forward calls. Calls inside an exported declaration are keyed by that
 * declaration's compiler node; everything else (top-level statements, non-exported helpers) lands in
 * `module`. Both are deduped, `IGNORED_CALLS`-filtered, and capped at `PER_BUCKET_CAP`. */
export interface ModuleCallAttribution {
  byDecl: Map<ts.Node, string[]>;
  module: string[];
}

/** Record the callee name of one CallExpression into a bucket. Plain `f()` and `obj.m()` /
 * `this.m()` are captured; computed/element-access and deeper expressions resolve to the bare
 * property name. Mirrors the resolution the previous per-export visitor used. */
function addCallName(call: CallExpression, bucket: Set<string>): void {
  const expr = call.getExpression();
  if (Node.isIdentifier(expr)) {
    bucket.add(expr.getText());
  } else if (Node.isPropertyAccessExpression(expr)) {
    const obj = expr.getExpression();
    const prop = expr.getName();
    if (Node.isThisExpression(obj)) {
      bucket.add(`this.${prop}`);
    } else if (Node.isIdentifier(obj)) {
      bucket.add(`${obj.getText()}.${prop}`);
    } else {
      bucket.add(prop);
    }
  }
}

/**
 * Collect every forward call in one `SourceFile` pass and attribute each to its nearest enclosing
 * exported declaration, else to the module. Host shape no longer gates collection: function,
 * arrow-const, class method / arrow-property / accessor / constructor / static block, HOC-wrapped
 * const, object-literal method, namespace member, default export, top-level statement, and
 * non-exported local helper are all covered by the single descent.
 *
 * `exportedDecls` holds the compiler nodes of this file's exported declarations (from
 * `getExportedDeclarations()`); a CallExpression is attributed to the innermost such node on its
 * ancestor chain. A single pre-order walk threads the enclosing declaration on the recursion stack,
 * so attribution is O(nodes) — no per-call ancestor re-walk.
 */
export function collectModuleCalls(sf: SourceFile, exportedDecls: Set<ts.Node>): ModuleCallAttribution {
  const byDecl = new Map<ts.Node, Set<string>>();
  const moduleCalls = new Set<string>();

  const walk = (node: Node, enclosing: ts.Node | undefined): void => {
    const enclosingNext = exportedDecls.has(node.compilerNode) ? node.compilerNode : enclosing;
    if (Node.isCallExpression(node)) {
      let bucket: Set<string> | undefined;
      if (enclosingNext) {
        bucket = byDecl.get(enclosingNext);
        if (!bucket) { bucket = new Set<string>(); byDecl.set(enclosingNext, bucket); }
      } else {
        bucket = moduleCalls;
      }
      addCallName(node, bucket);
    }
    node.forEachChild(child => { walk(child, enclosingNext); });
  };
  walk(sf, undefined);

  const finalize = (s: Set<string>): string[] =>
    [...s].filter(c => !IGNORED_CALLS.has(c)).slice(0, PER_BUCKET_CAP);

  const byDeclArr = new Map<ts.Node, string[]>();
  for (const [decl, set] of byDecl) {
    const arr = finalize(set);
    if (arr.length > 0) byDeclArr.set(decl, arr);
  }
  return { byDecl: byDeclArr, module: finalize(moduleCalls) };
}
