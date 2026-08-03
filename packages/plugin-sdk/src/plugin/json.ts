import { z } from 'zod';

/**
 * The value type every declarative payload in this contract is restricted to.
 *
 * A declaration catalog is read before the plugin entry is imported, an extension payload crosses
 * the worker protocol, the dump and the cache, and both are echoed by generic MCP. All three
 * transports are JSON, so the contract admits JSON and nothing else: no `undefined`, no function,
 * no class instance, no `Date`, no cycle.
 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Schema for an arbitrary JSON value. `z.number()` already rejects `NaN`/`Infinity`, which
 * `JSON.stringify` would silently turn into `null`.
 */
export const zJsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(zJsonValue),
  z.record(z.string(), zJsonValue),
]));

/** True when `value` round-trips through JSON unchanged in shape. */
export function isJsonValue(value: unknown): value is JsonValue {
  return zJsonValue.safeParse(value).success;
}
