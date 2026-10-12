import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import initSqlJs, { type Database as SqlJsDatabase, type SqlValue } from 'sql.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(HERE, 'schema.sql');

/** An untyped result row. Typed callers pass their own interface instead. */
export type Row = Record<string, SqlValue>;

/**
 * A thin wrapper over SQLite (sql.js / WebAssembly — see README for why not the
 * native module). Its job is to give the repositories a small synchronous
 * query surface and real transactions; it holds no domain knowledge.
 *
 * Each instance is a fresh in-memory database created from schema.sql, which is
 * how test files stay isolated without truncation or ordering rules.
 */
export class Database {
  private constructor(private readonly db: SqlJsDatabase) {}

  static async create(): Promise<Database> {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(fs.readFileSync(SCHEMA_PATH, 'utf8'));
    db.run('PRAGMA foreign_keys = ON');
    return new Database(db);
  }

  run(sql: string, params: SqlValue[] = []): void {
    this.db.run(sql, params);
  }

  all<T>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows: T[] = [];
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
      return rows;
    } finally {
      statement.free();
    }
  }

  get<T>(sql: string, params: SqlValue[] = []): T | undefined {
    return this.all<T>(sql, params)[0];
  }

  count(sql: string, params: SqlValue[] = []): number {
    const row = this.get<Row>(sql, params);
    const value = row ? Object.values(row)[0] : 0;
    return typeof value === 'number' ? value : 0;
  }

  /**
   * Runs `fn` inside a transaction, rolling back on any throw. Webhook
   * processing depends on this: the event row and its effects must commit or
   * fail together, which is what makes a replay a genuine no-op (strategy §9).
   */
  transaction<T>(fn: () => T): T {
    this.db.run('BEGIN');
    try {
      const result = fn();
      this.db.run('COMMIT');
      return result;
    } catch (error) {
      this.db.run('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
