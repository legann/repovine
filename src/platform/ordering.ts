/**
 * Host-independent string ordering.
 *
 * Declared in the SDK because a producer orders its own discovery output and must not reach for
 * `localeCompare` to do it; re-exported here so every engine sort that touches the graph — package
 * order, node payload lists, persisted artifacts — compares the same bytes. See the SDK declaration
 * for why locale collation stays out of the projection path.
 */
export { compareCodeUnits } from '@repovine/plugin-sdk';
