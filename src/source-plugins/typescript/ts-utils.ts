import { Node, type ArrowFunction, type FunctionExpression, type FunctionDeclaration } from 'ts-morph';
import { shortenText } from '@repovine/plugin-sdk';

export type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

export function getFunctionNode(node: Node): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(node)) return node;
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init) {
      if (Node.isArrowFunction(init)) return init;
      if (Node.isFunctionExpression(init)) return init;
    }
  }
  return undefined;
}

export function normalizeType(text: string, maxLength = 150): string {
  return shortenText(text.replace(/import\("[^"]+"\)\./g, ''), maxLength);
}
