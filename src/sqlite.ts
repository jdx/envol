import { DatabaseSync } from "node:sqlite";
import type { Database, Params, Statement } from "./db.ts";
export class SQLiteStore implements Database {
  readonly raw: DatabaseSync;
  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
  }
  async all<T>(sql: string, params: Params = []) {
    return this.raw.prepare(sql).all(...params) as T[];
  }
  async run(sql: string, params: Params = []) {
    return Number(this.raw.prepare(sql).run(...params).changes);
  }
  async batch(statements: Statement[]) {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      for (const s of statements)
        this.raw.prepare(s.sql).run(...(s.params ?? []));
      this.raw.exec("COMMIT");
    } catch (error) {
      this.raw.exec("ROLLBACK");
      throw error;
    }
  }
  close() {
    this.raw.close();
  }
}
