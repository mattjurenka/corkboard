// One user: the boards they have. Each board's cards live in its own Board
// object; this only lists them, so GET /api/boards is one call.

import { DurableObject } from "cloudflare:workers";
import type { BoardInfo } from "./board";

export class User extends DurableObject {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS boards (key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT)");
  }

  boards(): BoardInfo[] {
    return this.sql.exec("SELECT key, name, root FROM boards ORDER BY name, key").toArray() as BoardInfo[];
  }

  forget(key: string): void {
    this.sql.exec("DELETE FROM boards WHERE key = ?", key);
  }

  remember(board: BoardInfo): void {
    this.sql.exec(
      "INSERT INTO boards (key, name, root) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET name = excluded.name, root = excluded.root",
      board.key,
      board.name,
      board.root,
    );
  }
}
