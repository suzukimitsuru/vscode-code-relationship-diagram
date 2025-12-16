/** @file DB操作 with DuckDB */
import * as vscode from 'vscode';
import * as path from 'path';
import * as codeFiles from './extruct/codeFiles';
import * as SYMBOL from './extruct/symbol';
import * as codeRelationships from './relationship/codeRelationships';

import * as duckdb from 'duckdb';
import * as fs from 'fs';
import { autoSignBinary } from './bindingsAutoSign';

// Node.jsのABIバージョンを取得
const getNodeABI = (): string => {
    // process.versionsからABI番号を取得
    const modules = process.versions.modules;
    return modules || '';
};

// カスタムバインディングをロード（複数のNode.jsバージョンに対応）
// ランタイムで利用可能なバイナリを検索して読み込む
const loadDuckDBBinding = (): typeof duckdb => {
    const bindingsDir = path.join(__dirname, '..', 'bindings');
    const abi = getNodeABI();
    const platform = process.platform;
    const arch = process.arch;

    // ABI特定のバイナリを優先して試す
    const abiSpecificFilename = `duckdb-${platform}-${arch}-abi${abi}.node`;
    const abiSpecificPath = path.join(bindingsDir, abiSpecificFilename);

    if (fs.existsSync(abiSpecificPath)) {
        // macOSでは自動署名を試みる
        if (platform === 'darwin') {
            autoSignBinary(abiSpecificPath);
        }

        try {
            console.log(`Loading DuckDB binding: ${abiSpecificFilename} (Node.js ${process.version}, ABI ${abi})`);
            return require(abiSpecificPath) as typeof duckdb;
        } catch (error) {
            console.error(`Failed to load ABI-specific DuckDB binding from ${abiSpecificPath}:`, error);
        }
    }

    // ABI特定のバイナリが見つからない場合は、利用可能なバイナリを検索
    if (fs.existsSync(bindingsDir)) {
        const files = fs.readdirSync(bindingsDir);
        const matchingFiles = files.filter(file =>
            file.startsWith(`duckdb-${platform}-${arch}-abi`) && file.endsWith('.node')
        );

        if (matchingFiles.length > 0) {
            // 利用可能なABIバージョンをリスト
            const availableABIs = matchingFiles.map(f => {
                const match = f.match(/abi(\d+)\.node$/);
                return match ? match[1] : null;
            }).filter(Boolean);

            console.warn(`ABI ${abi} binding not found. Available ABIs: ${availableABIs.join(', ')}`);
            console.warn(`Attempting to use closest compatible ABI binding...`);

            // 最も近いABIバージョンを試す（後方互換性を期待）
            const sortedFiles = matchingFiles.sort().reverse();
            for (const file of sortedFiles) {
                const fallbackPath = path.join(bindingsDir, file);

                // macOSでは自動署名を試みる
                if (platform === 'darwin') {
                    autoSignBinary(fallbackPath);
                }

                try {
                    console.log(`Attempting to load: ${file}`);
                    return require(fallbackPath) as typeof duckdb;
                } catch (error) {
                    console.error(`Failed to load ${file}:`, error);
                }
            }
        }
    }

    // カスタムバインディングが見つからない場合は、デフォルトのDuckDBを使用
    console.warn(`No compatible custom DuckDB binding found, falling back to default DuckDB module`);
    console.warn(`Node.js: ${process.version}, ABI: ${abi}, Platform: ${platform}-${arch}`);
    return duckdb;
};

const dynDuckdb = loadDuckDBBinding();

/** @description データベース操作 */
export class Db extends vscode.Disposable {

    /** @description データベース */
    private _db: duckdb.Database;
    /** @description 接続 */
    protected _conn: duckdb.Connection;
    
    /**
     * @description コンストラクタ
     * @param dbFile データベースファイルのパス
     */
    public constructor(dbFile: string) {
        super(() => {
            this._conn?.close(() => {});
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
        this._conn?.close(() => {});
        this._conn = null as any;
        this._db = null as any;
        super.dispose();    
    }

    /**
     * @description テーブル作成
     * @returns 完了
     */
    public table_create(): Promise<void> {
        return new Promise<void>(async (resolve, reject) => {
            const sqls = [
                // コードファイル
                `CREATE TABLE IF NOT EXISTS table_files (
                    relative_path TEXT PRIMARY KEY,
                    language_id TEXT,
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
                    define_line INTEGER,
                    define_character INTEGER,
                    start_line INTEGER,
                    start_character INTEGER,
                    end_line INTEGER,
                    end_character INTEGER,
                    hash TEXT
                );`,
                'CREATE INDEX IF NOT EXISTS idx_symbols_parent_id ON table_symbols(parent_id);',
                'CREATE INDEX IF NOT EXISTS idx_symbols_path ON table_symbols(path);',

                // 関係
                `CREATE TABLE IF NOT EXISTS table_relationships (
                    reference_id TEXT,
                    define_id TEXT,
                );`,
                'CREATE INDEX IF NOT EXISTS idx_relationships_reference_id ON table_relationships(reference_id);',
                'CREATE INDEX IF NOT EXISTS idx_relationships_define_id ON table_relationships(define_id);',

                // 統計情報を更新
                'ANALYZE;'
            ];
            for (let index = 0; index < sqls.length; index++) {
                try {
                    await new Promise<void>((one_resolve, one_reject) => {
                        this._conn.prepare(sqls[index]).run(
                            (err: Error | null) => {
                            if (err) {
                                one_reject(err);
                            } else {
                                one_resolve();
                            }
                        });
                    });
                } catch (error) {
                    reject(error);
                }
            }
            resolve();
        });
    }
 
    /**
     * @description 全てのファイルの読み込み
     * @param path 相対パス
     * @returns ファイル配列
     */
    public codeFile_queryAll(): Promise<codeFiles.File[]> {
        return new Promise<codeFiles.File[]>((resolve, reject) => {
            this._conn.prepare('SELECT * FROM table_files').all(
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const files: codeFiles.File[] = rows.map(row =>
                            new codeFiles.File(row.relative_path, row.language_id, row.updated_at));
                        resolve(files);
                    }
                }
            );
        });
    }

    /**
     * @description ファイルの読み込み
     * @param path  パス
     * @returns ファイル配列
     */
    public codeFile_query(path: string): Promise<codeFiles.File[]> {
        return new Promise<codeFiles.File[]>((resolve, reject) => {
            this._conn.prepare('SELECT * FROM table_files WHERE relative_path = ?;').all(
                path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const files: codeFiles.File[] = rows.map(row =>
                            new codeFiles.File(row.relative_path, row.language_id, row.updated_at));
                        resolve(files);
                    }
                }
            );
        });
    }

    /**
     * @description コードファイルを更新または挿入
     * @param file  ファイル
     * @returns 完了
     */
    public codeFile_upsert(file : codeFiles.File): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            // コードファイルの存在確認
            this._conn.prepare('SELECT COUNT(*) AS count FROM table_files WHERE relative_path = ?;').all(
                file.relative_path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {

                        // 更新または挿入
                        this._conn.prepare(
                            (rows.length > 0) && (rows[0].count > 0)
                                ? 'UPDATE table_files SET language_id = ?, updated_at = ? WHERE relative_path = ?;'
                                : 'INSERT INTO table_files (language_id, updated_at, relative_path) VALUES (?, ?, ?);'
                        ).run(
                            file.language_id, file.updated.toISOString(), file.relative_path,
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
     * @description ファイルを削除
     * @param path  パス
     * @returns 完了
     */
    public codeFile_delete(path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare('DELETE FROM table_files WHERE relative_path = ?;').run(
                path,
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
     * @description 階層シンボルを挿入
     * @param symbols シンボル配列
     * @returns 完了
     */
    public symbol_inserts(symbols: SYMBOL.SymbolModel[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (symbols.length > 0) {
                const placeholders: string[] = [];
                const values: any[] = [];
                for (const symbol of symbols) {
                    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
                    values.push(
                        symbol.id, symbol.parentId,
                        symbol.name, symbol.kind, symbol.path,
                        symbol.define.line, symbol.define.character,
                        symbol.start.line,  symbol.start.character,
                        symbol.end.line,    symbol.end.character,
                        symbol.hash.toString('hex')
                    );
                }
                this._conn.prepare(
                    'INSERT INTO table_symbols ' + 
                    '(id, parent_id, name, kind, path, define_line, define_character, start_line, start_character, end_line, end_character, hash) ' + 
                    `VALUES ${placeholders.join(', ')};`).run(
                    ...values,
                    (err: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    }
                );
            } else {
                resolve();
            }
        });
    }

    /**
     * @description 全ての階層シンボルを読み込み
     * @param path  パス
     * @returns シンボルのルート要素の配列
     */
    public symbol_query(path: string): Promise<SYMBOL.SymbolModel[]> {
        return new Promise<SYMBOL.SymbolModel[]>((resolve, reject) => {
            this._conn.prepare('SELECT * FROM table_symbols WHERE path = ? ORDER BY path, start_line ASC;').all(
                path,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const symbols: SYMBOL.SymbolModel[] = [];
                        for (const row of rows) {
                            const hash = Buffer.from(row.hash, 'hex');
                            const symbol = new SYMBOL.SymbolModel(
                                row.id, row.name, row.kind, row.path,
                                new vscode.Position(row.define_line, row.define_character),
                                new vscode.Position(row.start_line, row.start_character),
                                new vscode.Position(row.end_line, row.end_character),
                                hash, row.parent_id,
                            );
                            symbols.push(symbol);
                        }
                        resolve(symbols);
                    }
                }
            );
        });
    }

    /**
     * @description シンボルを削除
     * @param ids シンボルID配列
     * @returns 完了
     */
    public symbol_delete(ids: string[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // 既存のシンボルを削除（path一致のものを全削除）
            this._conn.prepare('DELETE FROM table_symbols WHERE id IN ?;').run(
                ids,
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
     * @description ファイル単位でシンボルを削除
     * @param path  パス
     * @returns 完了
     */
    public symbol_deleteFile(path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // 既存のシンボルを削除（path一致のものを全削除）
            this._conn.prepare('DELETE FROM table_symbols WHERE path = ?;').run(
                path,
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
     * @description 全てのシンボルを読み込み
     * @returns シンボルの配列
     */
    public symbol_quaryAll(): Promise<SYMBOL.SymbolModel[]> {
        return new Promise<SYMBOL.SymbolModel[]>((resolve, reject) => {
            this._conn.prepare('SELECT * FROM table_symbols ORDER BY path, start_line ASC;').all(
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const symbols: SYMBOL.SymbolModel[] = [];
                        for (const row of rows) {
                            const hash = Buffer.from(row.hash, 'hex');
                            symbols.push(new SYMBOL.SymbolModel(
                                row.id, row.name, row.kind, row.path,
                                new vscode.Position(row.define_line, row.define_character),
                                new vscode.Position(row.start_line, row.start_character),
                                new vscode.Position(row.end_line, row.end_character),
                                hash, row.parent_id,
                            ));
                        }
                        resolve(symbols);
                    }
                }
            );
        });
    }

    /**
     * @description 関係を追加
     * @param rels 関係配列
     * @returns 完了
     */
    public relationship_inserts(rels: codeRelationships.Relationship[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (rels.length > 0) {
                const placeholders: string[] = [];
                const values: any[] = [];
                for (const rel of rels) {
                    placeholders.push('(?, ?)');
                    values.push(
                        rel.reference.id,
                        rel.define.id
                    );
                }
                this._conn.prepare(`INSERT INTO table_relationships (reference_id, define_id) VALUES ${placeholders.join(', ')};`).run(
                    ...values,
                    (err: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    }
                );
            } else {
                resolve();
            }
        });
    }

    /**
     * @description ファイル単位で定義と参照の両方の関係を削除
     * @param path  パス
     * @returns 完了
     */
    public relationship_deleteFile(path: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            // 既存のシンボルの関係を先に削除（path一致のものを全削除）
            this._conn.prepare(
                'DELETE FROM table_relationships ' +
                'WHERE reference_id IN (SELECT id FROM table_symbols WHERE path = ?) ' +
                'OR    define_id    IN (SELECT id FROM table_symbols WHERE path = ?);'
            ).run(
                path, path,
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
     * @description シンボル単位で定義と参照の両方の関係を削除
     * @param symbolIds シンボルID配列
     * @returns 完了
     */
    public relationship_deleteSymbols(symbolIds: string[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const placeholders = symbolIds.map(() => "?").join(", ");
            this._conn.prepare(
                'DELETE FROM table_relationships ' +
                `WHERE reference_id IN (${placeholders}) ` +
                `OR    define_id    IN (${placeholders});`
            ).run(
                ...symbolIds, ...symbolIds,
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
     * @description 指定された関係を削除（reference_idとdefine_idのペアで完全一致）
     * @param rels 関係配列
     * @returns 完了
     */
    public relationship_delete(rels: codeRelationships.Relationship[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (rels.length > 0) {
                // (reference_id = ? AND define_id = ?) OR ... の条件を構築
                const conditions = rels.map(() => "(reference_id = ? AND define_id = ?)").join(" OR ");
                const values: string[] = [];
                for (const rel of rels) {
                    values.push(rel.reference.id, rel.define.id);
                }

                this._conn.prepare(
                    `DELETE FROM table_relationships WHERE ${conditions};`
                ).run(
                    ...values,
                    (err: Error | null) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve();
                        }
                    }
                );
            } else {
                resolve();
            }
        });
    }

    /**
     * @description 全ての関係を読み込む
     * @returns 関係の配列
     */
    public relationship_quaryAll(): Promise<codeRelationships.Relationship[]> {
        return new Promise<codeRelationships.Relationship[]>((resolve, reject) => {
            this._conn.prepare(
                'SELECT ' +
                    'r.reference_id, s_ref.path AS reference_path, s_ref.start_line AS reference_line, ' +
                    'r.define_id,    s_def.path AS define_path,    s_def.start_line AS define_line ' +
                'FROM table_relationships r ' +
                'LEFT JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'LEFT JOIN table_symbols s_def ON r.define_id = s_def.id;').all(
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const relationships: codeRelationships.Relationship[] = rows.map(row =>
                            new codeRelationships.Relationship(
                                new codeRelationships.SymbolLocation(row.reference_id, row.reference_path, row.reference_line),
                                new codeRelationships.SymbolLocation(row.define_id, row.define_path, row.define_line)
                        ));
                        resolve(relationships);
                    }
                }
            );
        });
    }

    /**
     * @description 定義ファイルパスから関係を読み込む
     * @param definePath 定義ファイルパス
     * @returns 定義の配列
     */
    public relationship_queryDefinePath(definePath: string): Promise<codeRelationships.Relationship[]> {
        return new Promise<codeRelationships.Relationship[]>((resolve, reject) => {
            this._conn.prepare(
                'SELECT ' +
                    'r.reference_id, s_ref.path AS reference_path, s_ref.start_line AS reference_line, ' +
                    'r.define_id,    s_def.path AS define_path,    s_def.start_line AS define_line ' +
                'FROM table_relationships r ' +
                'LEFT JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'LEFT JOIN table_symbols s_def ON r.define_id = s_def.id ' +
                'WHERE s_def.path = ?;').all(
                definePath,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const relationships: codeRelationships.Relationship[] = rows.map(row =>
                            new codeRelationships.Relationship(
                                new codeRelationships.SymbolLocation(row.reference_id, row.reference_path, row.reference_line),
                                new codeRelationships.SymbolLocation(row.define_id, row.define_path, row.define_line)
                        ));
                        resolve(relationships);
                    }
                }
            );
        });
    }

    /**
     * @description 参照から関係を読み込む
     * @param symbolIds シンボルID配列
     * @returns 定義の配列
     */
    public relationship_queryReferencedSymbols(symbolIds: string[]): Promise<codeRelationships.Relationship[]> {
        return new Promise<codeRelationships.Relationship[]>((resolve, reject) => {
            const placeholders = symbolIds.map(() => "?").join(", ");
            this._conn.prepare(
                'SELECT ' +
                    'r.reference_id, s_ref.path AS reference_path, s_ref.start_line AS reference_line, ' +
                    'r.define_id,    s_def.path AS define_path,    s_def.start_line AS define_line ' +
                'FROM table_relationships r ' +
                'LEFT JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'LEFT JOIN table_symbols s_def ON r.define_id = s_def.id ' +
                `WHERE r.reference_id IN (${placeholders});`
            ).all(
                ...symbolIds,
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        const relationships: codeRelationships.Relationship[] = rows.map(row =>
                            new codeRelationships.Relationship(
                                new codeRelationships.SymbolLocation(row.reference_id, row.reference_path, row.reference_line),
                                new codeRelationships.SymbolLocation(row.define_id, row.define_path, row.define_line)
                        ));
                        resolve(relationships);
                    }
                }
            );
        });
    }
}
