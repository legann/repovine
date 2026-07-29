/**
 * Plugin-SDK authoring factories.
 *
 * A plugin package's default export is a `PluginRuntimeDescriptor` from `definePlugin`. These two
 * anchors type the pieces that go inside it, so a source plugin and a parser are written against
 * the published contract rather than as ad-hoc literals.
 */

import type { SourcePlugin } from './source-plugin/types.js';
import type { IaCParser } from './types.js';
import { PLUGIN_API_VERSION } from './runtime.js';

/**
 * Author a source plugin. Runtime identity except it stamps the contract `apiVersion` when the spec
 * does not set one. The single authoring entry point for source/ecosystem plugins.
 */
export function defineSourcePlugin(spec: SourcePlugin): SourcePlugin {
  return { apiVersion: PLUGIN_API_VERSION, ...spec };
}

/**
 * Typed authoring anchor for a single IaC parser. Runtime identity; exists so a parser object is
 * written against the public `IaCParser` contract (and shows intent) rather than an ad-hoc literal.
 */
export function defineIaCParser(parser: IaCParser): IaCParser {
  return parser;
}
