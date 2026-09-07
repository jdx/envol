export type Params = (string | number | null)[];
export interface Statement {
  sql: string;
  params?: Params;
}
export interface Database {
  all<T>(sql: string, params?: Params): Promise<T[]>;
  run(sql: string, params?: Params): Promise<number>;
  batch(statements: Statement[]): Promise<void>;
}
export class D1Store implements Database {
  constructor(private db: D1Database) {}
  async all<T>(sql: string, params: Params = []) {
    return (
      await this.db
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }
  async run(sql: string, params: Params = []) {
    return (
      await this.db
        .prepare(sql)
        .bind(...params)
        .run()
    ).meta.changes;
  }
  async batch(statements: Statement[]) {
    await this.db.batch(
      statements.map((s) => this.db.prepare(s.sql).bind(...(s.params ?? []))),
    );
  }
}
export async function one<T>(
  db: Database,
  sql: string,
  params: Params = [],
): Promise<T | undefined> {
  return (await db.all<T>(sql, params))[0];
}
