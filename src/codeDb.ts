/** @file DB操作 with DuckDB */
import * as vscode from 'vscode';
import * as path from 'path';
import * as codeFiles from './extruct/codeFiles';
import * as SYMBOL from './extruct/symbol';
import * as codeRelationships from './relationship/codeRelationships';
import type { AstImport, AstOccurrence, FileFacts, ModuleResolution } from './extruct/ast';

/**
 * スキーマの版数
 * @description 1 = 初版 (files / symbols / relationships)、2 = AST の事実 (docs/ast-plan.md §5.2)
 */
export const SCHEMA_VERSION = 2;

/**
 * v1 → v2 の移行 (docs/ast-plan.md §5.4)
 * @description 既存の行は保持し、列とテーブルの追加だけを行う。全て IF NOT EXISTS なので
 *              途中で失敗しても再実行できる。旧 table_relationships は Stage 4 まで残す
 */
const MIGRATION_V2: readonly string[] = [
    // シンボルの解決キー
    'ALTER TABLE table_symbols ADD COLUMN IF NOT EXISTS fqn TEXT;',
    'ALTER TABLE table_symbols ADD COLUMN IF NOT EXISTS export_name TEXT;',
    'CREATE INDEX IF NOT EXISTS idx_symbols_fqn ON table_symbols(fqn);',
    'CREATE INDEX IF NOT EXISTS idx_symbols_name ON table_symbols(name);',

    // 事実抽出の版数 (NULL = 未抽出。FACTS_VERSION と異なれば内容が同じでも抽出し直す)
    'ALTER TABLE table_files ADD COLUMN IF NOT EXISTS facts_version INTEGER;',

    // import 束縛 (再エクスポート・副作用 import を含む)
    `CREATE TABLE IF NOT EXISTS table_imports (
        path TEXT,
        local_name TEXT,
        imported_name TEXT,
        export_name TEXT,
        module_spec TEXT,
        resolved_path TEXT,
        is_external BOOLEAN,
        line INTEGER,
        character INTEGER
    );`,
    'CREATE INDEX IF NOT EXISTS idx_imports_path ON table_imports(path);',
    'CREATE INDEX IF NOT EXISTS idx_imports_resolved ON table_imports(resolved_path);',

    // 参照出現
    `CREATE TABLE IF NOT EXISTS table_occurrences (
        path TEXT,
        line INTEGER,
        character INTEGER,
        root_name TEXT,
        member_path TEXT,
        kind INTEGER,
        enclosing_fqn TEXT,
        scope_id INTEGER
    );`,
    'CREATE INDEX IF NOT EXISTS idx_occ_path ON table_occurrences(path);',
    'CREATE INDEX IF NOT EXISTS idx_occ_name ON table_occurrences(root_name);',

    // 関係 (fqn ペア + 種類 + 確信度)。Stage 2 から書き込む
    `CREATE TABLE IF NOT EXISTS table_relationships_v2 (
        reference_fqn TEXT,
        define_fqn TEXT,
        kind INTEGER DEFAULT 0,
        weight REAL DEFAULT 1.0,
        confidence REAL DEFAULT 1.0,
        reference_line INTEGER,
        is_intra_file BOOLEAN DEFAULT FALSE
    );`,
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_reference ON table_relationships_v2(reference_fqn);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_define ON table_relationships_v2(define_fqn);',
    `CREATE OR REPLACE VIEW view_relationship_strength AS
        SELECT reference_fqn, define_fqn, kind,
               COUNT(*) AS occurrence_count,
               SUM(weight * confidence) AS strength
        FROM table_relationships_v2
        GROUP BY reference_fqn, define_fqn, kind;`,
];

/** 一括挿入1文あたりの行数 (プレースホルダの数を抑える) */
const INSERT_CHUNK_ROWS = 500;

import * as duckdb from 'duckdb';
import * as fs from 'fs';
import { autoSignBinary } from './bindingsAutoSign';

// DuckDB の Node.js バインディングを読み込む
const loadDuckDBBinding = (bindingsDir: string): string => {
    const platform = process.platform;          // プラットフォーム: 'win32', 'darwin', 'linux', etc.
    const arch = process.arch;                  // アーキテクチャ: 'x64', 'arm64', etc. 
    const node_major = process.versions.node.split('.')[0]; // Node.jsのメジャーバージョン: '18', '20', '22', '23', etc.

    // バインディングのディレクトリが在ったら
    let loading_major = node_major;
    if (fs.existsSync(bindingsDir)) {

        // 利用可能なバインディングをリスト
        const files = fs.readdirSync(bindingsDir);
        const available_majors = files.filter(file => file.startsWith(`duckdb-${platform}-${arch}-v`) && file.endsWith('.node'))
            .map(file => {
                const match = file.match(/v(\d+)\.node$/);
                return match ? match[1] : '';
            }).filter(Boolean).sort();
        if (available_majors.length > 0) {

            // 利用可能な中で最も近いメジャーバージョンを選択
            loading_major = available_majors[0];
            for (const availableMajor of available_majors) {
                loading_major = availableMajor;
                if (node_major.localeCompare(availableMajor) <= 0) {
                    break;
                }
            }
        }
    }

    // バインディングのパスを構築
    const specific_path = path.join(bindingsDir, `duckdb-${platform}-${arch}-v${loading_major}.node`);

    // macOSでは自動署名を試みる
    if (platform === 'darwin') {
        autoSignBinary(specific_path);
    }

    // DuckDB の Node.js バインディングを返す
    return specific_path;
};

//const dynDuckdb = require(path.join(__dirname, '..', 'bindings', `duckdb-${process.platform}-${process.arch}.node`)) as typeof duckdb;
let dynDuckdb: typeof duckdb;
const duckdb_path = loadDuckDBBinding(path.join(__dirname, '..', 'bindings'));
try {
    dynDuckdb = require(duckdb_path) as typeof duckdb;
    console.log(`✓ DuckDB binding loaded ${path.basename(duckdb_path)} successfully`);
} catch (error) {
    console.error(`✗ CRITICAL: Failed to initialize DuckDB binding ${path.basename(duckdb_path)}`, error);
    throw error;
}

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
     * @description SQL を1文実行する
     * @param sql SQL
     * @param params プレースホルダの値
     * @returns 完了
     */
    private _run(sql: string, ...params: unknown[]): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare(sql).run(...params, (err: Error | null) => err ? reject(err) : resolve());
        });
    }

    /**
     * @description SELECT を1文実行する
     * @param sql SQL
     * @param params プレースホルダの値
     * @returns 行の配列
     */
    private _all(sql: string, ...params: unknown[]): Promise<duckdb.TableData> {
        return new Promise<duckdb.TableData>((resolve, reject) => {
            this._conn.prepare(sql).all(...params, (err: Error | null, rows: duckdb.TableData) => err ? reject(err) : resolve(rows));
        });
    }

    /**
     * @description 処理をトランザクションで囲む (失敗したらロールバックして例外を投げ直す)
     * @param body 処理
     * @returns 処理の戻り値
     */
    private async _transaction<T>(body: () => Promise<T>): Promise<T> {
        await this._run('BEGIN TRANSACTION;');
        try {
            const result = await body();
            await this._run('COMMIT;');
            return result;
        } catch (error) {
            await this._run('ROLLBACK;').catch(() => {});
            throw error;
        }
    }

    /**
     * @description テーブル作成と、旧スキーマからの移行
     * @returns 完了
     * @description 起動時に呼ばれる。既存の DB は行を保持したまま最新のスキーマへ移行する (再構築は不要)
     */
    public async table_create(): Promise<void> {
        for (const sql of this._table_create_v1()) {
            await this._run(sql);
        }
        await this._run('CREATE TABLE IF NOT EXISTS table_schema_version (version INTEGER);');
        const version = await this.schema_version();
        if (version < 2) {
            await this._transaction(async () => {
                for (const sql of MIGRATION_V2) {
                    await this._run(sql);
                }
                await this._run('DELETE FROM table_schema_version;');
                await this._run('INSERT INTO table_schema_version (version) VALUES (?);', 2);
            });
        }
        await this._run('ANALYZE;');
    }

    /**
     * @description スキーマの版数 (版数表が空なら初版の 1)
     * @returns 版数
     */
    public async schema_version(): Promise<number> {
        const rows = await this._all('SELECT MAX(version) AS version FROM table_schema_version;');
        const version = rows.length > 0 ? rows[0].version : null;
        return (version === null || version === undefined) ? 1 : Number(version);
    }

    /**
     * @description 初版のテーブル
     * @returns SQL の配列
     */
    private _table_create_v1(): string[] {
        return [
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
        ];
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
     * @description 事実抽出の版数を全ファイル分読み込む
     * @returns 相対パス → 版数 (未抽出なら null)
     */
    public async codeFile_queryFactsVersions(): Promise<Map<string, number | null>> {
        const rows = await this._all('SELECT relative_path, facts_version FROM table_files;');
        return new Map(rows.map(row => [row.relative_path as string,
            (row.facts_version === null || row.facts_version === undefined) ? null : Number(row.facts_version)]));
    }

    /**
     * @description コードファイルを更新または挿入
     * @param file  ファイル
     * @param factsVersion 事実抽出の版数 (抽出していなければ null)
     * @returns 完了
     */
    public codeFile_upsert(file : codeFiles.File, factsVersion: number | null = null): Promise<void> {
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
                                ? 'UPDATE table_files SET language_id = ?, updated_at = ?, facts_version = ? WHERE relative_path = ?;'
                                : 'INSERT INTO table_files (language_id, updated_at, facts_version, relative_path) VALUES (?, ?, ?, ?);'
                        ).run(
                            file.language_id, file.updated.toISOString(), factsVersion, file.relative_path,
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
                    placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
                    values.push(
                        symbol.id, symbol.parentId,
                        symbol.name, symbol.kind, symbol.path,
                        symbol.define.line, symbol.define.character,
                        symbol.start.line,  symbol.start.character,
                        symbol.end.line,    symbol.end.character,
                        symbol.hash.toString('hex'),
                        symbol.fqn, symbol.exportName
                    );
                }
                this._conn.prepare(
                    'INSERT INTO table_symbols ' +
                    '(id, parent_id, name, kind, path, define_line, define_character, start_line, start_character, end_line, end_character, hash, fqn, export_name) ' +
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
     * @description シンボルのID以外の情報を更新（内容は変わらないが位置が変わった場合など）
     * @param symbol シンボル
     * @returns 完了
     */
    public symbol_update(symbol: SYMBOL.SymbolModel): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this._conn.prepare(
                'UPDATE table_symbols SET ' +
                'parent_id = ?, name = ?, kind = ?, path = ?, ' +
                'define_line = ?, define_character = ?, ' +
                'start_line = ?, start_character = ?, ' +
                'end_line = ?, end_character = ?, ' +
                'hash = ?, fqn = ?, export_name = ? ' +
                'WHERE id = ?;'
            ).run(
                symbol.parentId, symbol.name, symbol.kind, symbol.path,
                symbol.define.line, symbol.define.character,
                symbol.start.line, symbol.start.character,
                symbol.end.line, symbol.end.character,
                symbol.hash.toString('hex'), symbol.fqn, symbol.exportName,
                symbol.id,
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
                            symbol.fqn = row.fqn ?? null;
                            symbol.exportName = row.export_name ?? null;
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
                        const symbolMap = new Map<string, SYMBOL.SymbolModel>();

                        // 全シンボルを作成してMapに登録
                        for (const row of rows) {
                            const hash = Buffer.from(row.hash, 'hex');
                            const symbol = new SYMBOL.SymbolModel(
                                row.id, row.name, row.kind, row.path,
                                new vscode.Position(row.define_line, row.define_character),
                                new vscode.Position(row.start_line, row.start_character),
                                new vscode.Position(row.end_line, row.end_character),
                                hash, row.parent_id,
                            );
                            symbol.fqn = row.fqn ?? null;
                            symbol.exportName = row.export_name ?? null;
                            symbols.push(symbol);
                            symbolMap.set(symbol.id, symbol);
                        }

                        // 親子関係を構築（parent_idを使ってchildren配列を構築）
                        for (const symbol of symbols) {
                            if (symbol.parentId) {
                                const parent = symbolMap.get(symbol.parentId);
                                if (parent) {
                                    parent.addChild(symbol);
                                }
                            }
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
                'INNER JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'INNER JOIN table_symbols s_def ON r.define_id = s_def.id;').all(
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
                'INNER JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'INNER JOIN table_symbols s_def ON r.define_id = s_def.id ' +
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
                'INNER JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'INNER JOIN table_symbols s_def ON r.define_id = s_def.id ' +
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

    /**
     * @description 定義シンボルを参照している関係を読み込む（fan-out用: 変更/削除されたシンボルの参照元を探す）
     * @param symbolIds 定義側シンボルID配列
     * @returns 参照の配列（reference側が参照元、define側が指定したシンボル）
     */
    public relationship_queryReferencesTo(symbolIds: string[]): Promise<codeRelationships.Relationship[]> {
        return new Promise<codeRelationships.Relationship[]>((resolve, reject) => {
            if (symbolIds.length === 0) { resolve([]); return; }
            const placeholders = symbolIds.map(() => "?").join(", ");
            this._conn.prepare(
                'SELECT ' +
                    'r.reference_id, s_ref.path AS reference_path, s_ref.start_line AS reference_line, ' +
                    'r.define_id,    s_def.path AS define_path,    s_def.start_line AS define_line ' +
                'FROM table_relationships r ' +
                'INNER JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
                'INNER JOIN table_symbols s_def ON r.define_id = s_def.id ' +
                `WHERE r.define_id IN (${placeholders});`
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

    /**
     * @description 1ファイルの事実 (import 束縛・参照出現) を置き換える
     * @param relativePath 相対パス
     * @param facts 事実 (null なら削除だけ行う。内容が変わって事実を抽出できなかった場合に古い事実を残さない)
     * @param factsVersion 事実抽出の版数を table_files へ書く場合に指定する (ファイル行が在る事が前提)
     * @returns 完了
     * @description 削除と挿入を1トランザクションで行う
     */
    public facts_replace(relativePath: string, facts: FileFacts | null, factsVersion?: number | null): Promise<void> {
        return this._transaction(async () => {
            await this._run('DELETE FROM table_imports WHERE path = ?;', relativePath);
            await this._run('DELETE FROM table_occurrences WHERE path = ?;', relativePath);
            if (facts) {
                for (let offset = 0; offset < facts.imports.length; offset += INSERT_CHUNK_ROWS) {
                    const chunk = facts.imports.slice(offset, offset + INSERT_CHUNK_ROWS);
                    await this._run(
                        'INSERT INTO table_imports (path, local_name, imported_name, export_name, module_spec, resolved_path, is_external, line, character) ' +
                        `VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')};`,
                        ...chunk.flatMap(entry => [relativePath, entry.localName, entry.importedName, entry.exportName,
                            entry.moduleSpec, entry.resolvedPath, entry.isExternal, entry.line, entry.character]));
                }
                for (let offset = 0; offset < facts.occurrences.length; offset += INSERT_CHUNK_ROWS) {
                    const chunk = facts.occurrences.slice(offset, offset + INSERT_CHUNK_ROWS);
                    await this._run(
                        'INSERT INTO table_occurrences (path, line, character, root_name, member_path, kind, enclosing_fqn, scope_id) ' +
                        `VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')};`,
                        ...chunk.flatMap(entry => [relativePath, entry.line, entry.character, entry.rootName,
                            entry.memberPath, entry.kind, entry.enclosingFqn, entry.scopeId]));
                }
            }
            if (factsVersion !== undefined) {
                await this._run('UPDATE table_files SET facts_version = ? WHERE relative_path = ?;', factsVersion, relativePath);
            }
        });
    }

    /**
     * @description ファイル単位で事実を削除
     * @param relativePath 相対パス
     * @returns 完了
     */
    public async facts_deleteFile(relativePath: string): Promise<void> {
        await this._run('DELETE FROM table_imports WHERE path = ?;', relativePath);
        await this._run('DELETE FROM table_occurrences WHERE path = ?;', relativePath);
    }

    /**
     * @description 1ファイルの事実を読み込む
     * @param relativePath 相対パス
     * @returns import 束縛と参照出現 (それぞれ位置順)
     */
    public async facts_query(relativePath: string): Promise<{ imports: (AstImport & ModuleResolution)[], occurrences: AstOccurrence[] }> {
        const imports = await this._all('SELECT * FROM table_imports WHERE path = ? ORDER BY line, character;', relativePath);
        const occurrences = await this._all('SELECT * FROM table_occurrences WHERE path = ? ORDER BY line, character;', relativePath);
        return {
            imports: imports.map(row => ({
                localName: row.local_name, importedName: row.imported_name, exportName: row.export_name,
                moduleSpec: row.module_spec, resolvedPath: row.resolved_path, isExternal: row.is_external,
                line: row.line, character: row.character,
            })),
            occurrences: occurrences.map(row => ({
                line: row.line, character: row.character, rootName: row.root_name, memberPath: row.member_path,
                kind: row.kind, enclosingFqn: row.enclosing_fqn, scopeId: row.scope_id,
            })),
        };
    }

    /**
     * @description 汎用クエリ実行（任意のSELECTクエリを実行）
     * @param query SQLクエリ文字列
     * @returns クエリ結果の配列
     */
    public executeQuery<T = any>(query: string): Promise<T[]> {
        return new Promise<T[]>((resolve, reject) => {
            this._conn.prepare(query).all(
                (err: Error | null, rows: duckdb.TableData) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(rows as T[]);
                    }
                }
            );
        });
    }
}
