/** @file DB操作 with DuckDB */
import * as vscode from 'vscode';
import * as path from 'path';
import * as SYMBOL from './symbol';
import * as codeRelationships from './codeRelationships';

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
            const sqls = [
                // コードファイル
                `CREATE TABLE IF NOT EXISTS table_files (
                    relative_path TEXT PRIMARY KEY,
                    updated_at TIMESTAMP
                );`,
                'CREATE INDEX IF NOT EXISTS idx_files_updated_at ON table_files(updated_at);',

                // シンボル
                `CREATE TABLE IF NOT EXISTS table_symbols (
                    id TEXT PRIMARY KEY,
                    parent_id TEXT,
                    name TEXT,
                    kind INTEGER,
                    path TEXT,
                    start_line INTEGER,
                    start_character INTEGER,
                    end_line INTEGER,
                    end_character INTEGER,
                    update_id TEXT,
                    pos_x REAL,
                    pos_y REAL
                );`,
                'CREATE INDEX IF NOT EXISTS idx_symbols_parent_id ON table_symbols(parent_id);',
                'CREATE INDEX IF NOT EXISTS idx_symbols_path ON table_symbols(path);',
                'CREATE INDEX IF NOT EXISTS idx_symbols_path_line ON table_symbols(path, start_line);',

                // 関係
                `CREATE TABLE IF NOT EXISTS table_relationships (
                    id TEXT PRIMARY KEY,
                    reference_id TEXT,
                    reference_path TEXT,
                    reference_line INTEGER,
                    define_id TEXT,
                    define_path TEXT,
                    define_line INTEGER
                );`,
                'CREATE INDEX IF NOT EXISTS idx_relationships_reference_id ON table_relationships(reference_id);',
                'CREATE INDEX IF NOT EXISTS idx_relationships_define_id ON table_relationships(define_id);',
                'CREATE INDEX IF NOT EXISTS idx_relationships_paths ON table_relationships(reference_path, define_path);',

                // パス検索用（WHERE path = ?）
                'CREATE INDEX IF NOT EXISTS idx_symbols_path_search ON table_symbols(path)',

                // 範囲検索用（WHERE start_line BETWEEN ? AND ?）
                'CREATE INDEX IF NOT EXISTS idx_symbols_line_range ON table_symbols(start_line, end_line)',

                // 結合用（JOIN ON reference_id = id）
                'CREATE INDEX IF NOT EXISTS idx_relationships_join_reference ON table_relationships(reference_id)',
                'CREATE INDEX IF NOT EXISTS idx_relationships_join_define ON table_relationships(define_id)',

                // ソート用（ORDER BY updated_at）
                'CREATE INDEX IF NOT EXISTS idx_files_sort_updated ON table_files(updated_at DESC)',

                // 複合条件用
                'CREATE INDEX IF NOT EXISTS idx_symbols_kind_path ON table_symbols(kind, path)',

                // 統計情報を更新
                'ANALYZE'
            ];
            for (let index = 0; index < sqls.length; index++) {
                this._conn.prepare(sqls[index], (err: Error | null) => {
                    if (err) {
                        reject(err);
                    } else {
                        if (index === sqls.length - 1) {
                            resolve();
                        }
                    }
                }).run();
            }
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
                this._conn.prepare(`SELECT * FROM table_files WHERE relative_path = ?;`).all(
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
                this._conn.prepare(`SELECT * FROM table_files;`).all(
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
            this._conn.prepare(`SELECT COUNT(*) AS count FROM table_files WHERE relative_path = ?;`).all(
                relative_path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {

                        // 更新または挿入
                        this._conn.prepare(
                            (rows.length > 0) && (rows[0].count > 0)
                                ? `UPDATE table_files SET updated_at = ? WHERE relative_path = ?;`
                                : `INSERT INTO table_files (updated_at, relative_path) VALUES (?, ?);`
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
            this._conn.prepare(`DELETE FROM table_files WHERE relative_path = ?;`).run(
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
                `INSERT INTO table_symbols (id, parent_id, name, kind, path, start_line, start_character, end_line, end_character, update_id, pos_x, pos_y)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
                    symbol.id,
                    parentId,
                    symbol.name,
                    symbol.kind,
                    symbol.path,
                    symbol.startLine,
                    symbol.startCharacter,
                    symbol.endLine,
                    symbol.endCharacter,
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
            this._conn.prepare(`SELECT * FROM table_symbols WHERE path = ? ORDER BY start_line ASC`).all(
                path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const map = new Map<string, SYMBOL.SymbolModel>();
                        for (const row of rows) {
                            map.set(row.id, new SYMBOL.SymbolModel(row.id, row.name, row.kind, row.path,
                                row.start_line, row.start_character,
                                row.end_line, row.end_character,
                                row.parent_id,
                                row.update_id,
                                (row.pos_x !== null && row.pos_y !== null) ? new SYMBOL.Position(row.pos_x, row.pos_y) : null
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
     * @description シンボルを削除
     * @param symbol シンボルのパス
     * @returns 更新または挿入の完了を示すPromise
     */
    public symbol_delete(symbol_path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // 既存のシンボルの関係を先に削除（path一致のものを全削除）
            this._conn.prepare(`DELETE FROM table_relationships WHERE reference_path = ? OR define_path = ?`).run(
                symbol_path, symbol_path,
                (err: Error | null) => {
                    if (err) {
                        reject(err);
                    } else {
                        // 既存のシンボルを削除（path一致のものを全削除）
                        this._conn.prepare(`DELETE FROM table_symbols WHERE path = ?`).run(
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
     * @description 関係を追加
     * @param rel 関係
     * @returns 保存の完了を示すPromise
     */
    public relationship_insert(rel: codeRelationships.Relationship): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare(
                `INSERT INTO table_relationships
                (id, reference_id, reference_path, reference_line, define_id, define_path, define_line)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (id) DO UPDATE SET
                    reference_id = excluded.reference_id,
                    reference_path = excluded.reference_path,
                    reference_line = excluded.reference_line,
                    define_id = excluded.define_id,
                    define_path = excluded.define_path,
                    define_line = excluded.define_line`
            ).run(
                rel.id,
                rel.reference.id,
                rel.reference.path,
                rel.reference.startLine,
                rel.define.id,
                rel.define.path,
                rel.define.startLine,
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
     * @description 関係の全てを読み込み
     * @returns 関係の配列
     */
    public relationship_quaryAll(): Promise<codeRelationships.Relationship[]> {
        return new Promise<codeRelationships.Relationship[]>((resolve, reject) => {
            this._conn.prepare(`SELECT * FROM table_relationships`).all(
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const relationships: codeRelationships.Relationship[] = rows.map(row =>
                            new codeRelationships.Relationship(row.id,
                                new codeRelationships.Symbol(row.reference_id, row.reference_path, row.reference_line),
                                new codeRelationships.Symbol(row.define_id, row.define_path, row.define_line)
                        ));
                        resolve(relationships);
                    }
                }
            );
        });
    }

    /**
     * @description 定義を検索
     * @param definePath 定義ファイルパス
     * @returns 定義の配列
     */
    public relationship_definePath(definePath: string): Promise<codeRelationships.Relationship[]> {
        return new Promise<codeRelationships.Relationship[]>((resolve, reject) => {
            this._conn.prepare(`SELECT * FROM table_relationships WHERE define_path = ?`).all(
                definePath,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const relationships: codeRelationships.Relationship[] = rows.map(row =>
                            new codeRelationships.Relationship(row.id,
                                new codeRelationships.Symbol(row.reference_id, row.reference_path, row.reference_line),
                                new codeRelationships.Symbol(row.define_id, row.define_path, row.define_line)
                        ));
                        resolve(relationships);
                    }
                }
            );
        });
    }

}
