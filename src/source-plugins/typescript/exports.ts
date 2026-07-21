import { Node, ts, type SourceFile, type BindingElement } from 'ts-morph';
import type {
  ExportInfo, SymbolKind, ParamInfo, FieldInfo, MemberInfo, InternalInfo,
} from '@repovine/plugin-sdk';
import { getFunctionNode } from './ts-utils.js';
import { collectModuleCalls } from './call-graph.js';
import { functionTypeLabel, paramTypeLabel, syntaxReturnTypeText, syntaxTypeText } from './type-syntax.js';

/** Exports plus the module-level calls not attributed to any exported declaration (top-level
 * statements, non-exported local helpers). The module bucket is what makes a non-exported helper's
 * calls visible to the reverse-by-name index. */
export interface CollectedExports {
  exports: ExportInfo[];
  moduleCalls: string[];
}

export function collectExports(sf: SourceFile): CollectedExports {
  const result: ExportInfo[] = [];

  // Gather (name, decl) pairs for declarations defined in this file, plus the compiler-node set the
  // single-pass call collector attributes against.
  const pairs: Array<{ name: string; decl: Node }> = [];
  const exportedDecls = new Set<ts.Node>();
  for (const [name, declarations] of sf.getExportedDeclarations()) {
    for (const decl of declarations) {
      if (decl.getSourceFile() !== sf) continue;
      pairs.push({ name, decl });
      exportedDecls.add(decl.compilerNode);
    }
  }

  const { byDecl, module: moduleCalls } = collectModuleCalls(sf, exportedDecls);

  for (const { name, decl } of pairs) {
    const info: ExportInfo = {
      name,
      kind: getSymbolKind(decl),
      signature: getSignatureText(decl),
      params: getParams(decl),
      returnType: getReturnType(decl),
      typeValue: getTypeValue(decl),
      fields: getInterfaceFields(decl),
      lineRange: { start: decl.getStartLineNumber(), end: decl.getEndLineNumber() },
      isDefault: name === 'default',
    };

    if (info.isDefault) {
      const localName = defaultLocalNameOf(decl);
      if (localName) info.defaultLocalName = localName;
    }

    const impls = getImplementsInterfaces(decl);
    if (impls) info.implementsInterfaces = impls;

    const members = collectClassMembers(decl);
    if (members) info.privateMembers = members;

    const fnInternals = collectFunctionInternals(decl);
    if (fnInternals) info.internals = fnInternals;

    const lineCount = info.lineRange.end - info.lineRange.start;
    if (lineCount <= 500) {
      const calls = byDecl.get(decl.compilerNode);
      if (calls && calls.length > 0) info.calls = calls;
    }

    result.push(info);
  }

  return { exports: result, moduleCalls };
}

/**
 * Name of the local declaration a default export points at (`const plugin = …; export default
 * plugin` → `plugin`). Undefined for an anonymous default (`export default { … }`, a literal, an
 * unnamed function/class), which is what lets a consumer keep a named contract while dropping
 * unnameable noise.
 */
function defaultLocalNameOf(node: Node): string | undefined {
  if (Node.isVariableDeclaration(node)) return node.getName();
  if (Node.isFunctionDeclaration(node) || Node.isClassDeclaration(node)) return node.getName() ?? undefined;
  return undefined;
}

function getSymbolKind(node: Node): SymbolKind {
  if (Node.isFunctionDeclaration(node)) return 'function';
  if (Node.isClassDeclaration(node)) return 'class';
  if (Node.isInterfaceDeclaration(node)) return 'interface';
  if (Node.isTypeAliasDeclaration(node)) return 'type';
  if (Node.isEnumDeclaration(node)) return 'enum';
  if (Node.isVariableDeclaration(node)) {
    if (getFunctionNode(node)) return 'function';
    return 'const';
  }
  return 'unknown';
}

function getSignatureText(node: Node): string | undefined {
  const fn = getFunctionNode(node);
  if (fn) {
    const params = fn.getParameters()
      .map(p => paramTypeLabel(p.getName(), syntaxTypeText(p)))
      .join(', ');
    return functionTypeLabel(params, syntaxReturnTypeText(fn));
  }
  if (Node.isClassDeclaration(node)) return `class ${node.getName() ?? 'anonymous'}`;
  if (Node.isInterfaceDeclaration(node)) return `interface ${node.getName()}`;
  if (Node.isTypeAliasDeclaration(node)) return `type ${node.getName()}`;
  if (Node.isEnumDeclaration(node)) return `enum ${node.getName()}`;
  return undefined;
}

function getParams(node: Node): ParamInfo[] | undefined {
  const fn = getFunctionNode(node);
  if (!fn) return undefined;
  return fn.getParameters().map(p => ({
    name: p.getName(),
    type: syntaxTypeText(p) ?? '',
  }));
}

function getReturnType(node: Node): string | undefined {
  const fn = getFunctionNode(node);
  if (!fn) return undefined;
  return syntaxReturnTypeText(fn);
}

function getTypeValue(node: Node): string | undefined {
  if (Node.isTypeAliasDeclaration(node)) {
    const typeNode = node.getTypeNode();
    if (typeNode) {
      const text = typeNode.getText();
      if (text.length <= 300) return text;
      return text.slice(0, 300) + '…';
    }
  }
  if (Node.isEnumDeclaration(node)) {
    const members = node.getMembers().map(m => {
      const val = m.getValue();
      return val !== undefined ? `${m.getName()} = ${JSON.stringify(val)}` : m.getName();
    });
    const text = members.join(' | ');
    if (text.length <= 300) return text;
    return text.slice(0, 300) + '…';
  }
  if (Node.isInterfaceDeclaration(node)) {
    const parts: string[] = [];
    for (const prop of node.getProperties()) {
      const opt = prop.hasQuestionToken() ? '?' : '';
      const t = syntaxTypeText(prop);
      parts.push(t ? `${prop.getName()}${opt}: ${t}` : `${prop.getName()}${opt}`);
    }
    for (const method of node.getMethods()) {
      const params = method.getParameters()
        .map(p => paramTypeLabel(p.getName(), syntaxTypeText(p)))
        .join(', ');
      const ret = syntaxReturnTypeText(method);
      const opt = method.hasQuestionToken() ? '?' : '';
      parts.push(ret
        ? `${method.getName()}${opt}(${params}): ${ret}`
        : `${method.getName()}${opt}(${params})`);
    }
    if (parts.length === 0) return undefined;
    const text = `{ ${parts.join('; ')} }`;
    if (text.length <= 500) return text;
    return text.slice(0, 500) + '…';
  }
  return undefined;
}

function getInterfaceFields(node: Node): FieldInfo[] | undefined {
  if (!Node.isInterfaceDeclaration(node)) return undefined;
  const fields: FieldInfo[] = [];
  for (const prop of node.getProperties()) {
    fields.push({
      name: prop.getName(),
      type: syntaxTypeText(prop) ?? '',
      optional: prop.hasQuestionToken(),
    });
  }
  for (const method of node.getMethods()) {
    const params = method.getParameters()
      .map(p => paramTypeLabel(p.getName(), syntaxTypeText(p)))
      .join(', ');
    const ret = syntaxReturnTypeText(method);
    fields.push({
      name: method.getName(),
      type: ret ? `(${params}) => ${ret}` : `(${params})`,
      optional: method.hasQuestionToken(),
    });
  }
  return fields.length > 0 ? fields : undefined;
}

function getImplementsInterfaces(node: Node): string[] | undefined {
  if (!Node.isClassDeclaration(node)) return undefined;
  const impls = node.getImplements();
  if (impls.length === 0) return undefined;
  return impls.map(i => i.getText().replace(/<.*>$/, ''));
}

function collectClassMembers(node: Node): MemberInfo[] | undefined {
  if (!Node.isClassDeclaration(node)) return undefined;
  const members: MemberInfo[] = [];

  for (const method of node.getMethods()) {
    const scope = method.getScope();
    if (scope !== 'private' && scope !== 'protected') continue;
    const params = method.getParameters()
      .map(p => paramTypeLabel(p.getName(), syntaxTypeText(p)))
      .join(', ');
    const ret = syntaxReturnTypeText(method);
    members.push({
      name: method.getName(),
      kind: 'method',
      access: scope,
      signature: functionTypeLabel(params, ret),
      lineRange: { start: method.getStartLineNumber(), end: method.getEndLineNumber() },
    });
  }

  for (const prop of node.getProperties()) {
    const scope = prop.getScope();
    if (scope !== 'private' && scope !== 'protected') continue;
    members.push({
      name: prop.getName(),
      kind: 'property',
      access: scope,
      signature: syntaxTypeText(prop) ?? '',
      lineRange: { start: prop.getStartLineNumber(), end: prop.getEndLineNumber() },
    });
  }

  return members.length > 0 ? members : undefined;
}

function collectFunctionInternals(node: Node, minLines = 200): InternalInfo[] | undefined {
  const fn = getFunctionNode(node);
  if (!fn) return undefined;
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return undefined;

  const totalLines = fn.getEndLineNumber() - fn.getStartLineNumber();
  if (totalLines < minLines) return undefined;

  const internals: InternalInfo[] = [];

  for (const stmt of body.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const name = stmt.getName();
      if (!name) continue;
      const params = stmt.getParameters()
        .map(p => paramTypeLabel(p.getName(), syntaxTypeText(p)))
        .join(', ');
      const ret = syntaxReturnTypeText(stmt);
      internals.push({
        name,
        kind: 'function',
        signature: functionTypeLabel(params, ret),
        lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
      });
      continue;
    }

    if (!Node.isVariableStatement(stmt)) continue;

    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const nameNode = decl.getNameNode();

      if (Node.isArrayBindingPattern(nameNode) || Node.isObjectBindingPattern(nameNode)) {
        const names = nameNode.getElements()
          .filter((e): e is BindingElement => Node.isBindingElement(e))
          .map(e => e.getName?.() ?? e.getText())
          .filter(Boolean);
        if (names.length > 0) {
          internals.push({
            name: names.join(', '),
            kind: 'destructuring',
            lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
          });
        }
        continue;
      }

      const name = decl.getName();
      const init = decl.getInitializer();

      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const params = init.getParameters()
          .map(p => paramTypeLabel(p.getName(), syntaxTypeText(p)))
          .join(', ');
        const ret = syntaxReturnTypeText(init);
        internals.push({
          name,
          kind: 'function',
          signature: functionTypeLabel(params, ret),
          lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
        });
      } else {
        internals.push({
          name,
          kind: 'variable',
          lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
        });
      }
    }
  }

  return internals.length > 0 ? internals : undefined;
}
