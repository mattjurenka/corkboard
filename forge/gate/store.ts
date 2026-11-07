// What the gate keeps: each bound account (its view, so its key now can be
// shown from its id, and the forge user it is), and the revocations it has
// been sent. Sessions are memory only; a restart asks for them again.

import { Database } from "bun:sqlite";
import type { ForgeBind, GrantRevocation } from "../../lib/e2ee/forge";
import type { AccountView, Revocation, Signed } from "../../lib/e2ee/wire";

export type Binding = { id: string; key: string; user: string; view: AccountView; bind: Signed<ForgeBind> };

export class Store {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("CREATE TABLE IF NOT EXISTS bindings (id TEXT PRIMARY KEY, key TEXT NOT NULL, user TEXT NOT NULL, view TEXT NOT NULL, bind TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS revocations (account TEXT NOT NULL, device TEXT NOT NULL, statement TEXT NOT NULL, PRIMARY KEY (account, device))");
    this.db.run("CREATE TABLE IF NOT EXISTS grant_revocations (grant TEXT NOT NULL, by TEXT NOT NULL, account TEXT NOT NULL, statement TEXT NOT NULL, PRIMARY KEY (grant, by))");
  }

  binding(id: string): Binding | null {
    const row = this.db.query<{ id: string; key: string; user: string; view: string; bind: string }, [string]>("SELECT * FROM bindings WHERE id = ?").get(id);
    return row && { id: row.id, key: row.key, user: row.user, view: JSON.parse(row.view), bind: JSON.parse(row.bind) };
  }

  bind(b: Binding) {
    this.db.run("INSERT OR REPLACE INTO bindings (id, key, user, view, bind) VALUES (?, ?, ?, ?, ?)", [b.id, b.key, b.user, JSON.stringify(b.view), JSON.stringify(b.bind)]);
  }

  rotate(id: string, key: string, view: AccountView) {
    this.db.run("UPDATE bindings SET key = ?, view = ? WHERE id = ?", [key, JSON.stringify(view), id]);
  }

  revocations(id: string): Signed<Revocation>[] {
    return this.db
      .query<{ statement: string }, [string]>("SELECT statement FROM revocations WHERE account = ?")
      .all(id)
      .map((r) => JSON.parse(r.statement));
  }

  revoke(id: string, r: Signed<Revocation>) {
    this.db.run("INSERT OR IGNORE INTO revocations (account, device, statement) VALUES (?, ?, ?)", [id, r.body.device, JSON.stringify(r)]);
  }

  grantRevokedBy(grant: string): string[] {
    return this.db
      .query<{ by: string }, [string]>("SELECT by FROM grant_revocations WHERE grant = ?")
      .all(grant)
      .map((r) => r.by);
  }

  revokeGrant(r: Signed<GrantRevocation>) {
    this.db.run("INSERT OR IGNORE INTO grant_revocations (grant, by, account, statement) VALUES (?, ?, ?, ?)", [r.body.grant, r.body.by, r.body.account, JSON.stringify(r)]);
  }
}
