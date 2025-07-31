/** @file DB操作 with DuckDB */
import * as vscode from 'vscode';
import * as path from 'path';
import * as SYMBOL from './symbol';
import * as codeReferences from './codeReferences';

import * as duckdb from 'duckdb';
const dynDuckdb = require(path.join(__dirname, '..', 'bindings', `duckdb-${process.platform}-${process.arch}.node`)) as typeof duckdb;

/** @description データベース操作 */
export class Db extends vscode.Disposable {

    /** @description データベース */
    private _db: duckdb.Database;
    /** @description 接続 */
    private _conn: duckdb.Connection;
    
    /**
     * @description コンストラクタ
     * @param dbFile データベースファイルのパス
     */
    public constructor(dbFile: string) {
        super(() => {
            this._conn?.close((err?: Error | null) => {});
            this._conn = null as any;
            this._db = null as any;
        });
        this._db = new dynDuckdb.Database(dbFile);
        this._conn = this._db.connect();
    }

    /**
     * @description データベースを破棄する
     */
    public dispose() {
        this._conn?.close((err?: Error | null) => {});
        this._conn = null as any;
        this._db = null as any;
        super.dispose();    
    }

    /**
     * @description テーブル作成
     * @returns テーブル作成の完了を示すPromise
     */
    public table_create(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // コードファイルテーブル
            this._conn.prepare(`
                CREATE TABLE IF NOT EXISTS code_files (
                    relative_path TEXT PRIMARY KEY,
                    updated_at TIMESTAMP
                );
            `,  // PostgreSQL, MySQL: 'id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'
            (err: Error | null) => {
                if (err) {
                    reject(err);
                } else {
                    // シンボルテーブル
                    this._conn.prepare(`
                        CREATE TABLE IF NOT EXISTS symbols (
                            id TEXT PRIMARY KEY,
                            parent_id TEXT,
                            name TEXT,
                            kind INTEGER,
                            path TEXT,
                            start_line INTEGER,
                            end_line INTEGER,
                            update_id TEXT,
                            pos_x REAL,
                            pos_y REAL
                        )
                    `,  // PostgreSQL, MySQL: 'id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY'
                    (err: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            // シンボル参照関係テーブル
                            this._conn.prepare(`
                                CREATE TABLE IF NOT EXISTS symbol_references (
                                    id TEXT PRIMARY KEY,
                                    from_symbol_id TEXT,
                                    to_symbol_id TEXT,
                                    from_path TEXT,
                                    to_path TEXT,
                                    reference_type TEXT,
                                    line_number INTEGER,
                                    FOREIGN KEY (from_symbol_id) REFERENCES symbols(id),
                                    FOREIGN KEY (to_symbol_id) REFERENCES symbols(id)
                                )
                            `, (err: Error | null) => {
                                if (err) {
                                    reject(err);
                                } else {
                                    resolve();
                                }
                            }).run();
                        }
                    }).run();
                }
            }).run();
        });
    }
 
    /**
     * @description コードファイルの問い合わせ
     * @param relative_path 相対パス
     * @returns コードファイルの情報を含むPromise
     */
    public codeFile_query(relative_path: string | null): Promise<duckdb.TableData> {
        return new Promise<duckdb.TableData>((resolve, reject) => {
            if (relative_path) {
                this._conn.prepare(`SELECT * FROM code_files WHERE relative_path = ?;`).all(
                    relative_path,
                    (err: Error | null, res: duckdb.TableData) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    }
                );
            } else {
                this._conn.prepare(`SELECT * FROM code_files;`).all(
                    (err: Error | null, res: duckdb.TableData) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(res);
                        }
                    }
                );
            }
        });
    }
    /**
     * @description コードファイルを更新または挿入
     * @param relative_path 更新または挿入するコードファイルの相対パス
     * @param updated       更新日時
     * @returns 更新または挿入の完了を示すPromise
     */
    public codeFile_upsert(relative_path: string, updated: Date): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            // コードファイルの存在確認
            this._conn.prepare(`SELECT COUNT(*) AS count FROM code_files WHERE relative_path = ?;`).all(
                relative_path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {

                        // 更新または挿入
                        this._conn.prepare(
                            (rows.length > 0) && (rows[0].count > 0)
                                ? `UPDATE code_files SET updated_at = ? WHERE relative_path = ?;`
                                : `INSERT INTO code_files (updated_at, relative_path) VALUES (?, ?);`
                        ).run(
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

    /**
     * @description コードファイルを削除
     * @param relative_path 削除するコードファイルの相対パス
     * @returns 削除の完了を示すPromise
     */
    public codeFile_delete(relative_path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare(`DELETE FROM code_files WHERE relative_path = ?;`).run(
                relative_path,
                (err: Error | null) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    /**
     * @description シンボルの再帰的保存
     * @param symbol シンボル情報
     * @param parentId 親シンボルのID
     */
    public symbol_save(symbol: SYMBOL.SymbolModel, parentId: string | null): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare(
                `INSERT INTO symbols (id, parent_id, name, kind, path, start_line, end_line, update_id, pos_x, pos_y)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    symbol.id,
                    parentId,
                    symbol.name,
                    symbol.kind,
                    symbol.path,
                    symbol.startLine,
                    symbol.endLine,
                    symbol.updateId,
                    symbol.position ? symbol.position.x : null,
                    symbol.position ? symbol.position.y : null,
                    (err: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            const children = [];
                            for (const child of symbol.children) {
                                children.push(this.symbol_save(child, symbol.id));
                            }
                            Promise.all(children).then(
                                () => resolve(),
                                (err: Error) => reject(err)
                            );
                        }
                    }
                
            );
        });
    }

    /**
     * @description シンボルの全てを読み込み
     * @param path コードファイルのパス
     * @returns シンボルのルート要素の配列
     */
    public symbol_load(path: string): Promise<SYMBOL.SymbolModel[]> {
        return new Promise<SYMBOL.SymbolModel[]>((resolve, reject) => {
            this._conn.prepare(`SELECT * FROM symbols WHERE path = ? ORDER BY start_line ASC`).all(
                path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const map = new Map<string, SYMBOL.SymbolModel>();
                        for (const row of rows) {
                            map.set(row.id, new SYMBOL.SymbolModel(
                                row.name,
                                row.kind,
                                row.path,
                                row.start_line,
                                row.end_line,
                                row.update_id,
                                (row.pos_x !== null && row.pos_y !== null) ? new SYMBOL.Position(row.pos_x, row.pos_y) : null,
                                row.id,
                                row.parent_id
                            ));
                        }
                        const roots: SYMBOL.SymbolModel[] = [];
                        for (const symbol of map.values()) {
                            if (symbol.parentId && map.has(symbol.parentId)) {
                                map.get(symbol.parentId)!.addChild(symbol);
                            } else {
                                roots.push(symbol);
                            }
                        }
                        resolve(roots);
                    }
                }
            );
        });
    }

    /**
     * @description パス、名前、開始行でシンボルを検索
     * @param path ファイルパス
     * @param name シンボル名
     * @param startLine 開始行
     * @returns シンボルのID（見つからない場合はnull）
     */
    public symbol_findId(path: string, name: string, startLine: number): Promise<string | null> {
        return new Promise<string | null>((resolve, reject) => {
            this._conn.prepare(`
                SELECT id FROM symbols 
                WHERE path = ? AND name = ? AND start_line = ?
                LIMIT 1
            `).all(
                path, name, startLine,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows.length > 0 ? rows[0].id : null);
                    }
                }
            );
        });
    }

    /**
     * @description シンボルを削除
     * @param symbol シンボルのパス
     * @returns 更新または挿入の完了を示すPromise
     */
    public symbol_delete(symbol_path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // 既存のシンボル参照関係を先に削除（path一致のものを全削除）
            this._conn.prepare(`DELETE FROM symbol_references WHERE from_path = ? OR to_path = ?`).run(
                symbol_path, symbol_path,
                (err: Error | null) => {
                    if (err) {
                        reject(err);
                    } else {
                        // 既存のシンボルを削除（path一致のものを全削除）
                        this._conn.prepare(`DELETE FROM symbols WHERE path = ?`).run(
                            symbol_path,
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

    /**
     * @description シンボル参照を保存
     * @param reference シンボル参照情報
     * @returns 保存の完了を示すPromise
     */
    public reference_insert(reference: codeReferences.Reference): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare(
                `INSERT OR REPLACE INTO symbol_references 
                (id, from_symbol_id, to_symbol_id, from_path, to_path, reference_type, line_number) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(
                reference.id,
                reference.fromSymbolId,
                reference.toSymbolId,
                reference.fromPath,
                reference.toPath,
                reference.referenceType,
                reference.lineNumber,
                (err: Error | null) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    /**
     * @description シンボル参照の全てを読み込み
     * @returns シンボル参照の配列
     */
    public reference_quaryAll(): Promise<codeReferences.Reference[]> {
        return new Promise<codeReferences.Reference[]>((resolve, reject) => {
            this._conn.prepare(`SELECT * FROM symbol_references`).all(
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const references: codeReferences.Reference[] = rows.map(row => ({
                            id: row.id,
                            fromSymbolId: row.from_symbol_id,
                            toSymbolId: row.to_symbol_id,
                            fromPath: row.from_path,
                            toPath: row.to_path,
                            referenceType: row.reference_type,
                            lineNumber: row.line_number
                        }));
                        resolve(references);
                    }
                }
            );
        });
    }
}
