import yaml from 'js-yaml';

/**
 * Schema that allows CloudFormation/SAM tags (!Ref, !Sub, !If, !Join, etc.) without throwing.
 * Used by the YAML loader so every parser sees the raw values regardless of CFN-specific tags.
 */
export const CLOUDFORMATION_SAFE_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('!', {
    kind: 'scalar',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
  new yaml.Type('!', {
    kind: 'sequence',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
  new yaml.Type('!', {
    kind: 'mapping',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
]);
