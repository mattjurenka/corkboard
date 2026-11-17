// Objects keyed by strings from outside. A plain { [k: string]: T } answers
// for keys it never had: o["constructor"] is a function, "toString" in o is
// true. A Dict has no prototype, so it has only what was put in it, and a
// type of its own, which scripts/lint-keys.ts lets be indexed by any string.
// Dict for data (records, a JSON file's maps), own() for a lookup table.

export type Dict<T> = { [k: string]: T } & { readonly __dict: never };

// A Dict of what's given: an object's own keys, or [key, value] pairs.
export function dict<T>(from?: { readonly [k: string]: T } | Iterable<readonly [string, T]>): Dict<T> {
  const d = Object.create(null) as Dict<T>;
  if (from) for (const [k, v] of Symbol.iterator in from ? (from as Iterable<readonly [string, T]>) : Object.entries(from)) d[k] = v;
  return d;
}

// A table's own entry for k, never one it inherits; with a table of known
// keys, `k` comes back narrowed to them.
export function own<T extends object>(table: T, k: string): T[keyof T] | undefined {
  // keys: checked own
  return hasKey(table, k) ? table[k] : undefined;
}

export function hasKey<T extends object>(table: T, k: string): k is Extract<keyof T, string> {
  return Object.hasOwn(table, k);
}
