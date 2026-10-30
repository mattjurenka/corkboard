// A Durable Object's tables as rows, to copy a user's whole account to a
// Worker on another Cloudflare account (api.ts's /api/export and
// /api/import). Every table but SQLite's own, Cloudflare's, the FTS indexes
// (filled again by their triggers as the rows go in) and those the object
// names as its own to rebuild.

export type Dump = Record<string, Record<string, SqlStorageValue>[]>;

const internal = (name: string) => /^(sqlite_|_cf_)/.test(name) || name.includes("_fts");

export function dump(sql: SqlStorage, skip: readonly string[] = []): Dump {
  const out: Dump = {};
  const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid").toArray();
  for (const { name } of tables) {
    const table = name as string;
    if (internal(table) || skip.includes(table)) continue;
    const rows = sql.exec(`SELECT * FROM "${table}"`).toArray();
    if (rows.some((r) => Object.values(r).some((v) => v instanceof ArrayBuffer))) throw new Error(`${table} has binary values`);
    out[table] = rows;
  }
  return out;
}

// Into an object with nothing in it yet, in the order the tables were made,
// so a row comes after what it refers to.
export function restore(sql: SqlStorage, d: Dump): number {
  const known = new Set(sql.exec("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map((r) => r.name as string));
  let n = 0;
  for (const [table, rows] of Object.entries(d)) {
    if (!known.has(table) || internal(table)) throw new Error(`no table ${table} here`);
    for (const row of rows) {
      const cols = Object.keys(row);
      sql.exec(`INSERT INTO "${table}" (${cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, ...Object.values(row));
      n++;
    }
  }
  return n;
}
