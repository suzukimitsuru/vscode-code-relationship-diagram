/** @file DB操作 with DuckDB */
import * as vscode from 'vscode';
import * as duckdb from 'duckdb';

export class Db extends vscode.Disposable {
    private readonly _db: duckdb.Database;
    private readonly _conn: duckdb.Connection;
    public constructor(dbFile: string) {
        super(() => {
            this._conn.close();
            this._db.close();    
        });
        this._db = new duckdb.Database(dbFile);
        this._conn = this._db.connect();
    }

    // テーブル作成
    public table_create(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.run(`
                CREATE TABLE IF NOT EXISTS code_files (
                    relative_path TEXT PRIMARY KEY,
                    updated_at TIMESTAMP
                );
            `,  // PostgreSQL, MySQL: 'id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'
            (err: Error | null) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
 
    // コードファイル更新または挿入
    public codeFile_upsert(relative_path: string, updated: Date): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            // コードファイルの存在確認
            this._conn.all(
                `SELECT COUNT(*) AS count FROM code_files WHERE relative_path = ?;`,
                relative_path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {

                        // 更新または挿入
                        this._conn.run(
                            (rows.length > 0) && (rows[0].count > 0)
                                ? `UPDATE code_files SET updated_at = ? WHERE relative_path = ?;`
                                : `INSERT INTO code_files (updated_at, relative_path) VALUES (?, ?);`,
                            updated.toISOString(), relative_path,
                            (err: Error | null) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve();
                                }
                            }
                        );
                    }
                }
            );
        });
    }

    // コードファイルの問い合わせ
    public codeFile_query(relative_path: string): Promise<duckdb.TableData> {
        return new Promise<duckdb.TableData>((resolve, reject) => {
            this._conn.all(
                `SELECT * FROM code_files WHERE relative_path = ?;`,
                relative_path,
                (err: Error | null, res: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(res);
                    }
                });
        });
    }

    // コードファイルの全てを問い合わせ
    public codeFile_queryAll(): Promise<duckdb.TableData> {
        return new Promise<duckdb.TableData>((resolve, reject) => {
            this._conn.all(`SELECT * FROM code_files;`,
                (err: Error | null, res: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(res);
                    }
                });
        });
    }
}
