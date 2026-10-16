/** @file DB操作 with DuckDB */
import * as vscode from 'vscode';
import { DuckDBConnection, DuckDBInstance, DuckDBValue } from '@duckdb/node-api';
import * as codeFiles from './extruct/codeFiles';
import * as SYMBOL from './extruct/symbol';
import * as codeRelationships from './relationship/codeRelationships';
import type { AstDefinition, AstImport, AstOccurrence, FileFacts, ModuleResolution } from './extruct/ast';
import { CandidateFacts, RelationshipV2, candidateNamesChanged, isGlobalScopeFile } from './relationship/resolve';

/**
 * スキーマの版数
 * @description 1 = 初版 (files / symbols / relationships)、
 *              2 = AST の事実 (docs/ast-plan.md §5.2)、
 *              3 = 定義表と名前解決 (Stage 2)、4 = 型の手掛かり (Stage 3)、
 *              5 = 関係の調査経路と、関係 (v2) の参照出現の桁 (Stage 4)、
 *              6 = 副索引の作り直し (DuckDB の不具合で壊れた索引の修復)
 */
export const SCHEMA_VERSION = 6;

/**
 * ファイルの関係の調査経路 (table_files.relationship_mode)
 * @description ast = AST の事実と名前解決 (table_relationships_v2)、lsp = 言語サーバの参照検索 (table_relationships)。
 *              NULL は Stage 3 までに調べたファイルで、lsp と同じ扱い
 */
export type RelationshipMode = 'ast' | 'lsp';

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

/**
 * v2 → v3 の移行 (Stage 2: 名前解決)
 * @description 既存の行は保持し、列とテーブルの追加だけを行う
 */
const MIGRATION_V3: readonly string[] = [
    // AST の定義 (名前解決の結合先。言語サーバのシンボルに付かなかった定義も含む)
    `CREATE TABLE IF NOT EXISTS table_definitions (
        path TEXT,
        fqn TEXT,
        name TEXT,
        kind TEXT,
        parent_fqn TEXT,
        export_name TEXT,
        name_line INTEGER,
        name_character INTEGER,
        start_line INTEGER,
        end_line INTEGER
    );`,
    'CREATE INDEX IF NOT EXISTS idx_definitions_path ON table_definitions(path);',
    'CREATE INDEX IF NOT EXISTS idx_definitions_fqn ON table_definitions(fqn);',

    // 参照出現の根の名前を束縛しているファイル内の定義
    'ALTER TABLE table_occurrences ADD COLUMN IF NOT EXISTS binding_fqn TEXT;',

    // 関係 (v2) を作り直す: 両端のファイル (ファイル単位の置き換えと集計に使う) を加え、
    // weight / confidence を DOUBLE にする (v2 の REAL は 32 ビットで、0.95 が 0.9499999881 になり strength の和に誤差が乗る)。
    // v2 ではこの表に書き込む処理が無いため、作り直しても失う行は無い
    'DROP VIEW IF EXISTS view_relationship_strength;',
    'DROP TABLE IF EXISTS table_relationships_v2;',
    `CREATE TABLE table_relationships_v2 (
        reference_path TEXT,
        reference_fqn TEXT,
        define_path TEXT,
        define_fqn TEXT,
        kind INTEGER DEFAULT 0,
        weight DOUBLE DEFAULT 1.0,
        confidence DOUBLE DEFAULT 1.0,
        reference_line INTEGER,
        is_intra_file BOOLEAN DEFAULT FALSE
    );`,
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_reference ON table_relationships_v2(reference_fqn);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_define ON table_relationships_v2(define_fqn);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_reference_path ON table_relationships_v2(reference_path);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_define_path ON table_relationships_v2(define_path);',
    `CREATE OR REPLACE VIEW view_relationship_strength AS
        SELECT reference_fqn, define_fqn, kind,
               COUNT(*) AS occurrence_count,
               SUM(weight * confidence) AS strength
        FROM table_relationships_v2
        GROUP BY reference_fqn, define_fqn, kind;`,

    // 名前解決の版数 (NULL = 未解決。事実か、import 先の事実が変わると NULL に戻す)
    'ALTER TABLE table_files ADD COLUMN IF NOT EXISTS resolved_version INTEGER;',
];

/**
 * v3 → v4 の移行 (Stage 3: 型推論)
 * @description 定義の値の型の手掛かり (AstTypeRef) と、名前で定義を引く索引を加える
 */
const MIGRATION_V4: readonly string[] = [
    'ALTER TABLE table_definitions ADD COLUMN IF NOT EXISTS type_mode TEXT;',
    'ALTER TABLE table_definitions ADD COLUMN IF NOT EXISTS type_root TEXT;',
    'ALTER TABLE table_definitions ADD COLUMN IF NOT EXISTS type_member TEXT;',
    'ALTER TABLE table_definitions ADD COLUMN IF NOT EXISTS type_scope_id INTEGER;',
    'ALTER TABLE table_definitions ADD COLUMN IF NOT EXISTS type_binding_fqn TEXT;',
    'ALTER TABLE table_definitions ADD COLUMN IF NOT EXISTS type_array BOOLEAN;',
    'CREATE INDEX IF NOT EXISTS idx_definitions_name ON table_definitions(name);',
];

/**
 * v4 → v5 の移行 (Stage 4: 主経路の切替)
 * @description ファイルごとの関係の調査経路を持たせる。関係 (v2) は参照出現の桁 (LSP による確定で使う) を加えて作り直し、
 *              全ファイルを未解決に戻す (名前解決の版数も上がるため、作り直しても次の名前解決で埋まる)。
 *              旧 table_relationships は、AST の文法の無い言語と旧経路へのロールバックで使うため残す (docs/ast-plan.md §12)
 */
const MIGRATION_V5: readonly string[] = [
    'ALTER TABLE table_files ADD COLUMN IF NOT EXISTS relationship_mode TEXT;',
    'DROP VIEW IF EXISTS view_relationship_strength;',
    'DROP TABLE IF EXISTS table_relationships_v2;',
    `CREATE TABLE table_relationships_v2 (
        reference_path TEXT,
        reference_fqn TEXT,
        define_path TEXT,
        define_fqn TEXT,
        kind INTEGER DEFAULT 0,
        weight DOUBLE DEFAULT 1.0,
        confidence DOUBLE DEFAULT 1.0,
        reference_line INTEGER,
        reference_character INTEGER,
        is_intra_file BOOLEAN DEFAULT FALSE
    );`,
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_reference ON table_relationships_v2(reference_fqn);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_define ON table_relationships_v2(define_fqn);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_reference_path ON table_relationships_v2(reference_path);',
    'CREATE INDEX IF NOT EXISTS idx_relationships_v2_define_path ON table_relationships_v2(define_path);',
    `CREATE OR REPLACE VIEW view_relationship_strength AS
        SELECT reference_fqn, define_fqn, kind,
               COUNT(*) AS occurrence_count,
               SUM(weight * confidence) AS strength
        FROM table_relationships_v2
        GROUP BY reference_fqn, define_fqn, kind;`,
    'UPDATE table_files SET resolved_version = NULL;',
];

/** 副索引 (CREATE INDEX の索引。主キーの索引は含まない) の [索引名, 表, 列] */
const SECONDARY_INDEXES: readonly (readonly [string, string, string])[] = [
    ['idx_files_updated_at', 'table_files', 'updated_at'],
    ['idx_symbols_parent_id', 'table_symbols', 'parent_id'],
    ['idx_symbols_path', 'table_symbols', 'path'],
    ['idx_symbols_fqn', 'table_symbols', 'fqn'],
    ['idx_symbols_name', 'table_symbols', 'name'],
    ['idx_relationships_reference_id', 'table_relationships', 'reference_id'],
    ['idx_relationships_define_id', 'table_relationships', 'define_id'],
    ['idx_imports_path', 'table_imports', 'path'],
    ['idx_imports_resolved', 'table_imports', 'resolved_path'],
    ['idx_occ_path', 'table_occurrences', 'path'],
    ['idx_occ_name', 'table_occurrences', 'root_name'],
    ['idx_definitions_path', 'table_definitions', 'path'],
    ['idx_definitions_fqn', 'table_definitions', 'fqn'],
    ['idx_definitions_name', 'table_definitions', 'name'],
    ['idx_relationships_v2_reference', 'table_relationships_v2', 'reference_fqn'],
    ['idx_relationships_v2_define', 'table_relationships_v2', 'define_fqn'],
    ['idx_relationships_v2_reference_path', 'table_relationships_v2', 'reference_path'],
    ['idx_relationships_v2_define_path', 'table_relationships_v2', 'define_path'],
];

/**
 * v5 → v6 の移行 (DuckDB の副索引の不具合で壊れた DB の修復)
 * @description DuckDB 1.4〜1.5.6 は、WAL を再生した後の最初のチェックポイントが自動か終了時だと、再生した行の無い副索引を書き出す
 *              (duckdb/duckdb#26828・#26106)。索引を通る `WHERE path = ?` が 0 件になり、表を走査する削除は
 *              「Failed to delete all rows from index」の FATAL で DB を使えなくする。以後は開いた直後のチェックポイント (Db) で防ぐが、
 *              既に壊れた DB を直すため、全ての副索引を作り直す。
 *              同じ名前の索引の DROP と CREATE を1つのトランザクションで行うと、開き直したファイルの DB では COMMIT で
 *              プロセスが異常終了する (duckdb/duckdb#23929。1.5.6 でも起きる) ため、トランザクションで囲まない。
 *              途中で止まっても版数は上がらず、次の起動でもう一度作り直す
 */
const MIGRATION_V6: readonly string[] = SECONDARY_INDEXES.flatMap(([name, table, column]) => [
    `DROP INDEX IF EXISTS ${name};`,
    `CREATE INDEX ${name} ON ${table}(${column});`,
]);

/** 版数ごとの移行 (古い順)。[版数, SQL, トランザクションで囲むか] */
const MIGRATIONS: readonly [number, readonly string[], boolean][] = [
    [2, MIGRATION_V2, true], [3, MIGRATION_V3, true], [4, MIGRATION_V4, true], [5, MIGRATION_V5, true], [6, MIGRATION_V6, false],
];

/** 一括挿入1文あたりの行数 (プレースホルダの数を抑える) */
const INSERT_CHUNK_ROWS = 500;

/** table_definitions の1行を定義にする */
const definitionOf = (row: Record<string, any>): AstDefinition => ({
    fqn: row.fqn, name: row.name, kind: row.kind, parentFqn: row.parent_fqn, exportName: row.export_name,
    nameLine: row.name_line, nameCharacter: row.name_character, startLine: row.start_line, endLine: row.end_line,
    type: row.type_mode ? {
        mode: row.type_mode, rootName: row.type_root, memberPath: row.type_member,
        scopeId: row.type_scope_id, bindingFqn: row.type_binding_fqn, array: row.type_array === true,
    } : null,
});


/** @description 問い合わせ結果の1行 (列名 → 値。BIGINT は bigint、TIMESTAMP は Date) */
export type Row = Record<string, any>;

/** @description プレースホルダの値を DuckDB の値にする (undefined は NULL) */
const valueOf = (value: unknown): DuckDBValue => (value === undefined ? null : value) as DuckDBValue;

/** @description データベース操作 */
export class Db extends vscode.Disposable {

    /** @description 接続 (開き終わるまでは開く処理) */
    private readonly _connecting: Promise<{ instance: DuckDBInstance, connection: DuckDBConnection, owned: boolean }>;
    /** @description 直前の問い合わせ (問い合わせを呼んだ順に1つずつ実行する) */
    private _last: Promise<unknown> = Promise.resolve();
    /** @description 破棄済み */
    private _disposed = false;

    /**
     * @description コンストラクタ
     * @param dbFile データベースファイルのパス (':memory:' ならメモリ上)
     * @description 開く処理は非同期に進め、最初の問い合わせで完了を待つ。開けなかった場合は最初の問い合わせが失敗する
     */
    public constructor(dbFile: string) {
        super(() => this._close());
        this._connecting = (async () => {
            // 同じプロセスで同じファイルを複数のインスタンスから開かないよう、ファイルはインスタンスキャッシュから開く
            // (拡張機能は調査用と図の表示用で同じファイルを2回開く)。キャッシュのインスタンスは他と共有するため閉じない
            const owned = dbFile === ':memory:';
            const instance = owned ? await DuckDBInstance.create(dbFile) : await DuckDBInstance.fromCache(dbFile);
            const connection = await instance.connect();
            if (!owned) {
                // WAL を再生した直後に自分でチェックポイントする。DuckDB 1.4〜1.5.6 は、再生の後の最初のチェックポイントが
                // 自動 (WAL の肥大) か終了時だと、再生した行の無い副索引を書き出す (duckdb/duckdb#26828・#26106)。
                // 拡張機能はキャッシュのインスタンスを閉じないため、VS Code の終了ごとに WAL が残り、次の起動で再生される
                await connection.run('CHECKPOINT;');
            }
            return { instance, connection, owned };
        })();
        this._connecting.catch(() => {});
    }

    /**
     * @description データベースを破棄する
     */
    public dispose() {
        this._close();
        super.dispose();
    }

    /**
     * @description 接続を閉じる (2回目以降は何もしない)
     */
    private _close(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        void this._last.catch(() => {}).then(() => this._connecting).then(({ instance, connection, owned }) => {
            connection.closeSync();
            if (owned) {
                instance.closeSync();
            }
        }).catch(() => {});
    }

    /**
     * @description 問い合わせを、それまでに呼ばれた問い合わせの後に実行する
     * @param query 問い合わせ
     * @returns 問い合わせの結果
     * @description DuckDB の接続は並行に呼ぶと実行順が保証されないため、呼んだ順に1つずつ実行する
     */
    private _enqueue<T>(query: (connection: DuckDBConnection) => Promise<T>): Promise<T> {
        const result = this._last.catch(() => {}).then(async () => query((await this._connecting).connection));
        this._last = result;
        return result;
    }

    /**
     * @description SQL を1文実行する
     * @param sql SQL
     * @param params プレースホルダの値
     * @returns 完了
     */
    private async _run(sql: string, ...params: unknown[]): Promise<void> {
        await this._enqueue(connection => connection.run(sql, params.length > 0 ? params.map(valueOf) : undefined));
    }

    /**
     * @description SELECT を1文実行する
     * @param sql SQL
     * @param params プレースホルダの値
     * @returns 行の配列
     */
    private _all(sql: string, ...params: unknown[]): Promise<Row[]> {
        return this._enqueue(async connection => {
            const reader = await connection.runAndReadAll(sql, params.length > 0 ? params.map(valueOf) : undefined);
            return reader.getRowObjectsJS() as Row[];
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
        for (const [target, sqls, transactional] of MIGRATIONS) {
            if (version < target) {
                const migrate = async () => {
                    for (const sql of sqls) {
                        await this._run(sql);
                    }
                };
                const record = async () => {
                    await this._run('DELETE FROM table_schema_version;');
                    await this._run('INSERT INTO table_schema_version (version) VALUES (?);', target);
                };
                if (transactional) {
                    await this._transaction(async () => {
                        await migrate();
                        await record();
                    });
                } else {
                    await migrate();
                    await this._transaction(record);
                }
            }
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
    public async codeFile_queryAll(): Promise<codeFiles.File[]> {
        const rows = await this._all('SELECT * FROM table_files');
        return rows.map(row => new codeFiles.File(row.relative_path, row.language_id, row.updated_at));
    }

    /**
     * @description ファイルの読み込み
     * @param path  パス
     * @returns ファイル配列
     */
    public async codeFile_query(path: string): Promise<codeFiles.File[]> {
        const rows = await this._all('SELECT * FROM table_files WHERE relative_path = ?;', path);
        return rows.map(row => new codeFiles.File(row.relative_path, row.language_id, row.updated_at));
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
     * @description 関係の調査経路を全ファイル分読み込む
     * @returns 相対パス → 調査経路 (Stage 3 までに調べたファイルは null)
     */
    public async codeFile_queryRelationshipModes(): Promise<Map<string, RelationshipMode | null>> {
        const rows = await this._all('SELECT relative_path, relationship_mode FROM table_files;');
        return new Map(rows.map(row => [row.relative_path as string, (row.relationship_mode ?? null) as RelationshipMode | null]));
    }

    /**
     * @description コードファイルを更新または挿入
     * @param file  ファイル
     * @param factsVersion 事実抽出の版数 (抽出していなければ null)
     * @param relationshipMode 関係の調査経路
     * @returns 完了
     */
    public async codeFile_upsert(file : codeFiles.File, factsVersion: number | null = null, relationshipMode: RelationshipMode = 'lsp'): Promise<void> {

        // コードファイルの存在確認
        const rows = await this._all('SELECT COUNT(*) AS count FROM table_files WHERE relative_path = ?;', file.relative_path);

        // 更新または挿入
        await this._run(
            (rows.length > 0) && (Number(rows[0].count) > 0)
                ? 'UPDATE table_files SET language_id = ?, updated_at = ?, facts_version = ?, relationship_mode = ? WHERE relative_path = ?;'
                : 'INSERT INTO table_files (language_id, updated_at, facts_version, relationship_mode, relative_path) VALUES (?, ?, ?, ?, ?);',
            file.language_id, file.updated.toISOString(), factsVersion, relationshipMode, file.relative_path);
    }

    /**
     * @description ファイルを削除
     * @param path  パス
     * @returns 完了
     */
    public async codeFile_delete(path: string): Promise<void> {
        await this._run('DELETE FROM table_files WHERE relative_path = ?;', path);
    }

    /**
     * @description 階層シンボルを挿入
     * @param symbols シンボル配列
     * @returns 完了
     */
    public async symbol_inserts(symbols: SYMBOL.SymbolModel[]): Promise<void> {
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
            await this._run(
                'INSERT INTO table_symbols ' +
                '(id, parent_id, name, kind, path, define_line, define_character, start_line, start_character, end_line, end_character, hash, fqn, export_name) ' +
                `VALUES ${placeholders.join(', ')};`,
                ...values);
        }
    }

    /**
     * @description シンボルのID以外の情報を更新（内容は変わらないが位置が変わった場合など）
     * @param symbol シンボル
     * @returns 完了
     */
    public async symbol_update(symbol: SYMBOL.SymbolModel): Promise<void> {
        await this._run(
            'UPDATE table_symbols SET ' +
            'parent_id = ?, name = ?, kind = ?, path = ?, ' +
            'define_line = ?, define_character = ?, ' +
            'start_line = ?, start_character = ?, ' +
            'end_line = ?, end_character = ?, ' +
            'hash = ?, fqn = ?, export_name = ? ' +
            'WHERE id = ?;',
            symbol.parentId, symbol.name, symbol.kind, symbol.path,
            symbol.define.line, symbol.define.character,
            symbol.start.line, symbol.start.character,
            symbol.end.line, symbol.end.character,
            symbol.hash.toString('hex'), symbol.fqn, symbol.exportName,
            symbol.id);
    }

    /**
     * @description 行をシンボルにする
     * @param row table_symbols の行
     * @returns シンボル
     */
    private _symbolOf(row: Row): SYMBOL.SymbolModel {
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
        return symbol;
    }

    /**
     * @description 全ての階層シンボルを読み込み
     * @param path  パス
     * @returns シンボルのルート要素の配列
     */
    public async symbol_query(path: string): Promise<SYMBOL.SymbolModel[]> {
        const rows = await this._all('SELECT * FROM table_symbols WHERE path = ? ORDER BY path, start_line ASC;', path);
        return rows.map(row => this._symbolOf(row));
    }

    /**
     * @description シンボルを削除
     * @param ids シンボルID配列
     * @returns 完了
     */
    public async symbol_delete(ids: string[]): Promise<void> {
        if (ids.length > 0) {
            const placeholders = ids.map(() => '?').join(', ');
            await this._run(`DELETE FROM table_symbols WHERE id IN (${placeholders});`, ...ids);
        }
    }

    /**
     * @description ファイル単位でシンボルを削除
     * @param path  パス
     * @returns 完了
     */
    public async symbol_deleteFile(path: string): Promise<void> {
        // 既存のシンボルを削除（path一致のものを全削除）
        await this._run('DELETE FROM table_symbols WHERE path = ?;', path);
    }

    /**
     * @description 全てのシンボルを読み込み
     * @returns シンボルの配列
     */
    public async symbol_quaryAll(): Promise<SYMBOL.SymbolModel[]> {
        const rows = await this._all('SELECT * FROM table_symbols ORDER BY path, start_line ASC;');

        // 全シンボルを作成してMapに登録
        const symbols = rows.map(row => this._symbolOf(row));
        const symbolMap = new Map<string, SYMBOL.SymbolModel>(symbols.map(symbol => [symbol.id, symbol]));

        // 親子関係を構築（parent_idを使ってchildren配列を構築）
        for (const symbol of symbols) {
            if (symbol.parentId) {
                const parent = symbolMap.get(symbol.parentId);
                if (parent) {
                    parent.addChild(symbol);
                }
            }
        }
        return symbols;
    }

    /**
     * @description 関係を追加
     * @param rels 関係配列
     * @returns 完了
     */
    public async relationship_inserts(rels: codeRelationships.Relationship[]): Promise<void> {
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
            await this._run(`INSERT INTO table_relationships (reference_id, define_id) VALUES ${placeholders.join(', ')};`, ...values);
        }
    }

    /**
     * @description ファイル単位で定義と参照の両方の関係を削除
     * @param path  パス
     * @returns 完了
     */
    public async relationship_deleteFile(path: string): Promise<void> {
        // 既存のシンボルの関係を先に削除（path一致のものを全削除）
        await this._run(
            'DELETE FROM table_relationships ' +
            'WHERE reference_id IN (SELECT id FROM table_symbols WHERE path = ?) ' +
            'OR    define_id    IN (SELECT id FROM table_symbols WHERE path = ?);',
            path, path);
    }

    /**
     * @description 定義側のファイル単位で関係を削除 (関係の調査経路を AST へ切り替えたファイルの、LSP 由来の関係を消す)
     * @param path  定義側のファイル
     * @returns 完了
     */
    public async relationship_deleteDefinePath(path: string): Promise<void> {
        await this._run('DELETE FROM table_relationships WHERE define_id IN (SELECT id FROM table_symbols WHERE path = ?);', path);
    }

    /**
     * @description シンボル単位で定義と参照の両方の関係を削除
     * @param symbolIds シンボルID配列
     * @returns 完了
     */
    public async relationship_deleteSymbols(symbolIds: string[]): Promise<void> {
        const placeholders = symbolIds.map(() => "?").join(", ");
        await this._run(
            'DELETE FROM table_relationships ' +
            `WHERE reference_id IN (${placeholders}) ` +
            `OR    define_id    IN (${placeholders});`,
            ...symbolIds, ...symbolIds);
    }

    /**
     * @description 指定された関係を削除（reference_idとdefine_idのペアで完全一致）
     * @param rels 関係配列
     * @returns 完了
     */
    public async relationship_delete(rels: codeRelationships.Relationship[]): Promise<void> {
        if (rels.length > 0) {
            // (reference_id = ? AND define_id = ?) OR ... の条件を構築
            const conditions = rels.map(() => "(reference_id = ? AND define_id = ?)").join(" OR ");
            const values: string[] = [];
            for (const rel of rels) {
                values.push(rel.reference.id, rel.define.id);
            }
            await this._run(`DELETE FROM table_relationships WHERE ${conditions};`, ...values);
        }
    }

    /** @description 関係と両端のファイル・行を読む SELECT (WHERE 句は呼び出し側で付ける) */
    private static readonly RELATIONSHIP_SELECT =
        'SELECT ' +
            'r.reference_id, s_ref.path AS reference_path, s_ref.start_line AS reference_line, ' +
            'r.define_id,    s_def.path AS define_path,    s_def.start_line AS define_line ' +
        'FROM table_relationships r ' +
        'INNER JOIN table_symbols s_ref ON r.reference_id = s_ref.id ' +
        'INNER JOIN table_symbols s_def ON r.define_id = s_def.id';

    /**
     * @description 行を関係にする
     * @param rows RELATIONSHIP_SELECT の行
     * @returns 関係の配列
     */
    private static _relationshipsOf(rows: Row[]): codeRelationships.Relationship[] {
        return rows.map(row =>
            new codeRelationships.Relationship(
                new codeRelationships.SymbolLocation(row.reference_id, row.reference_path, row.reference_line),
                new codeRelationships.SymbolLocation(row.define_id, row.define_path, row.define_line)
        ));
    }

    /**
     * @description 全ての関係を読み込む
     * @returns 関係の配列
     */
    public async relationship_quaryAll(): Promise<codeRelationships.Relationship[]> {
        return Db._relationshipsOf(await this._all(`${Db.RELATIONSHIP_SELECT};`));
    }

    /**
     * @description 図に表示する LSP 由来の関係 (定義側のファイルを LSP の経路で調べたもの)
     * @returns 関係の配列
     * @description 定義側を AST の経路へ切り替えたファイルの関係は、関係 (v2) から作るため除く
     *              (ロールバック・切り替えの途中で古い行が残っていても二重に数えない)
     */
    public async relationship_queryLspMode(): Promise<codeRelationships.Relationship[]> {
        return Db._relationshipsOf(await this._all(
            `${Db.RELATIONSHIP_SELECT} LEFT JOIN table_files f ON f.relative_path = s_def.path ` +
            "WHERE f.relationship_mode IS DISTINCT FROM 'ast';"));
    }

    /**
     * @description 定義ファイルパスから関係を読み込む
     * @param definePath 定義ファイルパス
     * @returns 定義の配列
     */
    public async relationship_queryDefinePath(definePath: string): Promise<codeRelationships.Relationship[]> {
        return Db._relationshipsOf(await this._all(`${Db.RELATIONSHIP_SELECT} WHERE s_def.path = ?;`, definePath));
    }

    /**
     * @description 参照から関係を読み込む
     * @param symbolIds シンボルID配列
     * @returns 定義の配列
     */
    public async relationship_queryReferencedSymbols(symbolIds: string[]): Promise<codeRelationships.Relationship[]> {
        const placeholders = symbolIds.map(() => "?").join(", ");
        return Db._relationshipsOf(await this._all(`${Db.RELATIONSHIP_SELECT} WHERE r.reference_id IN (${placeholders});`, ...symbolIds));
    }

    /**
     * @description 定義シンボルを参照している関係を読み込む（fan-out用: 変更/削除されたシンボルの参照元を探す）
     * @param symbolIds 定義側シンボルID配列
     * @returns 参照の配列（reference側が参照元、define側が指定したシンボル）
     */
    public async relationship_queryReferencesTo(symbolIds: string[]): Promise<codeRelationships.Relationship[]> {
        if (symbolIds.length === 0) { return []; }
        const placeholders = symbolIds.map(() => "?").join(", ");
        return Db._relationshipsOf(await this._all(`${Db.RELATIONSHIP_SELECT} WHERE r.define_id IN (${placeholders});`, ...symbolIds));
    }

    /**
     * @description 1ファイルの事実 (定義・import 束縛・参照出現) を置き換える
     * @param relativePath 相対パス
     * @param facts 事実 (null なら削除だけ行う。内容が変わって事実を抽出できなかった場合に古い事実を残さない)
     * @param factsVersion 事実抽出の版数を table_files へ書く場合に指定する (ファイル行が在る事が前提)
     * @returns 完了
     * @description 削除と挿入を1トランザクションで行う。このファイルと、このファイルを import している
     *              ファイルの名前解決を未解決に戻す (定義や export が変わった可能性があるため)
     */
    public facts_replace(relativePath: string, facts: FileFacts | null, factsVersion?: number | null): Promise<void> {
        return this._transaction(async () => {
            await this._markUnresolved(relativePath, facts);
            await this._run('DELETE FROM table_definitions WHERE path = ?;', relativePath);
            await this._run('DELETE FROM table_imports WHERE path = ?;', relativePath);
            await this._run('DELETE FROM table_occurrences WHERE path = ?;', relativePath);
            if (facts) {
                for (let offset = 0; offset < facts.definitions.length; offset += INSERT_CHUNK_ROWS) {
                    const chunk = facts.definitions.slice(offset, offset + INSERT_CHUNK_ROWS);
                    await this._run(
                        'INSERT INTO table_definitions (path, fqn, name, kind, parent_fqn, export_name, name_line, name_character, start_line, end_line, ' +
                        'type_mode, type_root, type_member, type_scope_id, type_binding_fqn, type_array) ' +
                        `VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')};`,
                        ...chunk.flatMap(entry => [relativePath, entry.fqn, entry.name, entry.kind, entry.parentFqn, entry.exportName,
                            entry.nameLine, entry.nameCharacter, entry.startLine, entry.endLine,
                            entry.type?.mode ?? null, entry.type?.rootName ?? null, entry.type?.memberPath ?? null,
                            entry.type?.scopeId ?? null, entry.type?.bindingFqn ?? null, entry.type?.array ?? null]));
                }
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
                        'INSERT INTO table_occurrences (path, line, character, root_name, member_path, kind, enclosing_fqn, scope_id, binding_fqn) ' +
                        `VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')};`,
                        ...chunk.flatMap(entry => [relativePath, entry.line, entry.character, entry.rootName,
                            entry.memberPath, entry.kind, entry.enclosingFqn, entry.scopeId, entry.bindingFqn]));
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
        await this._transaction(async () => {
            await this._markUnresolved(relativePath, null);
            await this._run('DELETE FROM table_definitions WHERE path = ?;', relativePath);
            await this._run('DELETE FROM table_imports WHERE path = ?;', relativePath);
            await this._run('DELETE FROM table_occurrences WHERE path = ?;', relativePath);
            await this._run('DELETE FROM table_relationships_v2 WHERE reference_path = ?;', relativePath);
        });
    }

    /**
     * @description 事実が変わるファイルの影響を受けるファイルの名前解決を未解決に戻す (事実を書き換える前に呼ぶ事)
     * @param relativePath 相対パス
     * @param facts 新しい事実 (削除・抽出できなかった場合は null)
     * @description docs/ast-plan.md §9。次のファイルを未解決に戻す
     * - そのファイルと、そのファイルを推移的に import しているファイル (段2 の再エクスポート・段3 の戻り値や継承元の型は
     *   import を辿った先の事実に依存する)
     * - 段4 / 4' の候補 (メンバの定義・グローバルなトップレベルの定義) が増減した名前を引いているファイル
     */
    private async _markUnresolved(relativePath: string, facts: FileFacts | null): Promise<void> {
        await this._run(
            'UPDATE table_files SET resolved_version = NULL WHERE relative_path IN (' +
                'WITH RECURSIVE dependents(path) AS (' +
                    'SELECT ?::VARCHAR UNION SELECT i.path FROM table_imports i JOIN dependents d ON i.resolved_path = d.path' +
                ') SELECT path FROM dependents);',
            relativePath);

        // 段4 の候補が増減した名前 (根の名前はファイル内に束縛の無いもの、メンバはどの位置でも引かれうる)
        const definitions = await this._all('SELECT name, fqn, kind, parent_fqn FROM table_definitions WHERE path = ?;', relativePath);
        const imports = await this._all('SELECT COUNT(*) AS count FROM table_imports WHERE path = ?;', relativePath);
        const before: CandidateFacts | null = definitions.length === 0 ? null : {
            definitions: definitions.map(row => ({ name: row.name, fqn: row.fqn, kind: row.kind, parentFqn: row.parent_fqn })),
            globalScope: isGlobalScopeFile(relativePath, Number(imports[0].count), (await this._all(
                'SELECT COUNT(*) AS count FROM table_definitions WHERE path = ? AND export_name IS NOT NULL;', relativePath))[0].count > 0),
        };
        const after: CandidateFacts | null = facts === null ? null : {
            definitions: facts.definitions,
            globalScope: isGlobalScopeFile(relativePath, facts.imports.length, facts.definitions.some(definition => definition.exportName !== null)),
        };
        const names = candidateNamesChanged(relativePath, before, after);
        for (let offset = 0; offset < names.length; offset += INSERT_CHUNK_ROWS) {
            const chunk = names.slice(offset, offset + INSERT_CHUNK_ROWS);
            const placeholders = chunk.map(() => '?').join(', ');
            await this._run(
                'UPDATE table_files SET resolved_version = NULL WHERE relative_path IN (' +
                    'SELECT DISTINCT path FROM table_occurrences ' +
                    `WHERE (scope_id IS NULL AND root_name IN (${placeholders})) ` +
                    `OR list_has_any(string_split(member_path, '.'), [${placeholders}]));`,
                ...chunk, ...chunk);
        }
    }

    /**
     * @description 1ファイルの事実を読み込む
     * @param relativePath 相対パス
     * @returns import 束縛と参照出現 (それぞれ位置順)
     */
    public async facts_query(relativePath: string): Promise<{
        definitions: AstDefinition[], imports: (AstImport & ModuleResolution)[], occurrences: AstOccurrence[] }> {
        return {
            definitions: await this.definitions_query(relativePath),
            imports: await this.imports_query(relativePath),
            occurrences: await this.occurrences_query(relativePath),
        };
    }

    /**
     * @description 1ファイルの参照出現を読み込む
     * @param relativePath 相対パス
     * @returns 参照出現 (位置順)
     */
    public async occurrences_query(relativePath: string): Promise<AstOccurrence[]> {
        const rows = await this._all('SELECT * FROM table_occurrences WHERE path = ? ORDER BY line, character;', relativePath);
        return rows.map(row => ({
            line: row.line, character: row.character, rootName: row.root_name, memberPath: row.member_path,
            kind: row.kind, enclosingFqn: row.enclosing_fqn, scopeId: row.scope_id, bindingFqn: row.binding_fqn,
        }));
    }

    /**
     * @description 1ファイルの import 束縛を読み込む
     * @param relativePath 相対パス
     * @returns import 束縛 (位置順)
     */
    public async imports_query(relativePath: string): Promise<(AstImport & ModuleResolution)[]> {
        const rows = await this._all('SELECT * FROM table_imports WHERE path = ? ORDER BY line, character;', relativePath);
        return rows.map(row => ({
            localName: row.local_name, importedName: row.imported_name, exportName: row.export_name,
            moduleSpec: row.module_spec, resolvedPath: row.resolved_path, isExternal: row.is_external,
            line: row.line, character: row.character,
        }));
    }

    /**
     * @description 1ファイルの定義を読み込む
     * @param relativePath 相対パス
     * @returns 定義 (位置順)
     */
    public async definitions_query(relativePath: string): Promise<AstDefinition[]> {
        const rows = await this._all('SELECT * FROM table_definitions WHERE path = ? ORDER BY name_line, name_character;', relativePath);
        return rows.map(definitionOf);
    }

    /**
     * @description 名前で定義を引く (名前解決の段4: プロジェクト全体での一意名)
     * @param name 名前
     * @returns 定義とそのファイル (ファイル・位置順)
     */
    public async definitions_queryNamed(name: string): Promise<{ path: string, definition: AstDefinition }[]> {
        const rows = await this._all('SELECT * FROM table_definitions WHERE name = ? ORDER BY path, name_line, name_character;', name);
        return rows.map(row => ({ path: row.path as string, definition: definitionOf(row) }));
    }

    /**
     * @description 名前解決が必要なファイル (事実が最新で、名前解決が未解決か古い版数のもの)
     * @param factsVersion 最新の事実抽出の版数
     * @param resolveVersion 最新の名前解決の版数
     * @returns 相対パスの配列 (名前順)
     */
    public async resolution_pendingFiles(factsVersion: number, resolveVersion: number): Promise<string[]> {
        const rows = await this._all(
            'SELECT relative_path FROM table_files WHERE facts_version = ? AND resolved_version IS DISTINCT FROM ? ORDER BY relative_path;',
            factsVersion, resolveVersion);
        return rows.map(row => row.relative_path as string);
    }

    /**
     * @description 参照元ファイル単位で関係 (v2) を置き換え、名前解決の版数を記録する
     * @param relativePaths 参照元ファイル
     * @param relationships そのファイル群から出る関係
     * @param resolveVersion 名前解決の版数
     * @returns 完了
     */
    public relationships_v2_replace(relativePaths: string[], relationships: RelationshipV2[], resolveVersion: number): Promise<void> {
        return this._transaction(async () => {
            for (let offset = 0; offset < relativePaths.length; offset += INSERT_CHUNK_ROWS) {
                const chunk = relativePaths.slice(offset, offset + INSERT_CHUNK_ROWS);
                const placeholders = chunk.map(() => '?').join(', ');
                await this._run(`DELETE FROM table_relationships_v2 WHERE reference_path IN (${placeholders});`, ...chunk);
                await this._run(`UPDATE table_files SET resolved_version = ? WHERE relative_path IN (${placeholders});`, resolveVersion, ...chunk);
            }
            for (let offset = 0; offset < relationships.length; offset += INSERT_CHUNK_ROWS) {
                const chunk = relationships.slice(offset, offset + INSERT_CHUNK_ROWS);
                await this._run(
                    'INSERT INTO table_relationships_v2 (reference_path, reference_fqn, define_path, define_fqn, kind, weight, confidence, ' +
                    'reference_line, reference_character, is_intra_file) ' +
                    `VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')};`,
                    ...chunk.flatMap(entry => [entry.referencePath, entry.referenceFqn, entry.definePath, entry.defineFqn,
                        entry.kind, entry.weight, entry.confidence, entry.referenceLine, entry.referenceCharacter, entry.isIntraFile]));
            }
        });
    }

    /**
     * @description 関係 (v2) を読み込む
     * @param referencePath 参照元ファイル (省略時は全て)
     * @returns 関係 (参照元ファイル・行の順)
     */
    public async relationships_v2_query(referencePath?: string): Promise<RelationshipV2[]> {
        const rows = referencePath === undefined
            ? await this._all('SELECT * FROM table_relationships_v2 ORDER BY reference_path, reference_line, reference_character, define_fqn;')
            : await this._all('SELECT * FROM table_relationships_v2 WHERE reference_path = ? ORDER BY reference_line, reference_character, define_fqn;', referencePath);
        return rows.map(Db._relationshipV2Of);
    }

    /**
     * @description 図に表示する関係 (v2)。参照元のファイルを AST の経路で調べた関係 (ファイル内の関係を含む)
     * @param threshold 確信度の下限 (含む)
     * @returns 関係 (参照元ファイル・行の順)
     */
    public async relationships_v2_queryAstMode(threshold: number): Promise<RelationshipV2[]> {
        const rows = await this._all(
            'SELECT r.* FROM table_relationships_v2 r JOIN table_files f ON f.relative_path = r.reference_path ' +
            "WHERE f.relationship_mode = 'ast' AND r.confidence >= ? " +
            'ORDER BY r.reference_path, r.reference_line, r.reference_character, r.define_fqn;', threshold);
        return rows.map(Db._relationshipV2Of);
    }

    /**
     * @description 確信度が閾値未満の関係 (v2) を読む (LSP による確定の対象。ファイル間・ファイル内とも)
     * @param referencePaths 参照元ファイル
     * @param threshold 確信度の上限 (含まない)
     * @returns 関係 (参照元ファイル・位置の順)
     */
    public async relationships_v2_queryUncertain(referencePaths: string[], threshold: number): Promise<RelationshipV2[]> {
        const relationships: RelationshipV2[] = [];
        for (let offset = 0; offset < referencePaths.length; offset += INSERT_CHUNK_ROWS) {
            const chunk = referencePaths.slice(offset, offset + INSERT_CHUNK_ROWS);
            const rows = await this._all(
                `SELECT * FROM table_relationships_v2 WHERE reference_path IN (${chunk.map(() => '?').join(', ')}) AND confidence < ? ` +
                'ORDER BY reference_path, reference_line, reference_character, define_fqn;', ...chunk, threshold);
            relationships.push(...rows.map(Db._relationshipV2Of));
        }
        return relationships;
    }

    /**
     * @description LSP で確定した結果で、関係 (v2) を置き換える
     * @param removes 消す関係 (読んだ時と全ての列が同じ行を消す。その後で名前解決し直された行は消さない)
     * @param inserts 加える関係
     * @returns 完了
     */
    public relationships_v2_confirm(removes: RelationshipV2[], inserts: RelationshipV2[]): Promise<void> {
        return this._transaction(async () => {
            for (const entry of removes) {
                await this._run(
                    'DELETE FROM table_relationships_v2 WHERE reference_path = ? AND reference_fqn = ? AND define_path = ? AND define_fqn = ? ' +
                    'AND kind = ? AND confidence = ? AND reference_line = ? AND reference_character = ?;',
                    entry.referencePath, entry.referenceFqn, entry.definePath, entry.defineFqn,
                    entry.kind, entry.confidence, entry.referenceLine, entry.referenceCharacter);
            }
            for (let offset = 0; offset < inserts.length; offset += INSERT_CHUNK_ROWS) {
                const chunk = inserts.slice(offset, offset + INSERT_CHUNK_ROWS);
                await this._run(
                    'INSERT INTO table_relationships_v2 (reference_path, reference_fqn, define_path, define_fqn, kind, weight, confidence, ' +
                    'reference_line, reference_character, is_intra_file) ' +
                    `VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')};`,
                    ...chunk.flatMap(entry => [entry.referencePath, entry.referenceFqn, entry.definePath, entry.defineFqn,
                        entry.kind, entry.weight, entry.confidence, entry.referenceLine, entry.referenceCharacter, entry.isIntraFile]));
            }
        });
    }

    /**
     * @description 名前の位置にある定義を引く (LSP が返した定義の位置を完全修飾名にする)
     * @param relativePath 相対パス
     * @param line 名前の開始行
     * @param character 名前の開始桁 (UTF-16)
     * @returns 完全修飾名 (無ければ null)
     */
    public async definitions_queryAt(relativePath: string, line: number, character: number): Promise<string | null> {
        const rows = await this._all(
            "SELECT fqn FROM table_definitions WHERE path = ? AND name_line = ? AND name_character = ? AND kind <> 'parameter' LIMIT 1;",
            relativePath, line, character);
        return rows.length > 0 ? rows[0].fqn as string : null;
    }

    /** @description table_relationships_v2 の1行を関係にする */
    private static _relationshipV2Of(row: Row): RelationshipV2 {
        return {
            referencePath: row.reference_path, referenceFqn: row.reference_fqn, definePath: row.define_path, defineFqn: row.define_fqn,
            kind: row.kind, weight: row.weight, confidence: row.confidence,
            referenceLine: row.reference_line, referenceCharacter: row.reference_character, isIntraFile: row.is_intra_file,
        };
    }

    /**
     * @description 汎用クエリ実行（任意のSELECTクエリを実行）
     * @param query SQLクエリ文字列
     * @returns クエリ結果の配列
     */
    public async executeQuery<T = any>(query: string): Promise<T[]> {
        return await this._all(query) as T[];
    }
}
