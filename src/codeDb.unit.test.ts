/** @file DuckDB 操作の単体テスト (スキーマ移行・事実の保存) */
import { DuckDBInstance } from '@duckdb/node-api';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import * as codeDb from './codeDb';
import * as codeFiles from './extruct/codeFiles';
import * as SYMBOL from './extruct/symbol';
import { FileFacts, RelationshipKind } from './extruct/ast';
import { RelationshipV2 } from './relationship/resolve';

/** 初版 (0.3.36 まで) のスキーマ */
const V1_SCHEMA = [
    'CREATE TABLE table_files (relative_path TEXT PRIMARY KEY, language_id TEXT, updated_at TIMESTAMP);',
    'CREATE INDEX idx_files_updated_at ON table_files(updated_at);',
    `CREATE TABLE table_symbols (id TEXT PRIMARY KEY, parent_id TEXT, name TEXT, kind INTEGER, path TEXT,
        define_line INTEGER, define_character INTEGER, start_line INTEGER, start_character INTEGER,
        end_line INTEGER, end_character INTEGER, hash TEXT);`,
    'CREATE INDEX idx_symbols_parent_id ON table_symbols(parent_id);',
    'CREATE INDEX idx_symbols_path ON table_symbols(path);',
    'CREATE TABLE table_relationships (reference_id TEXT, define_id TEXT);',
    'CREATE INDEX idx_relationships_reference_id ON table_relationships(reference_id);',
    'CREATE INDEX idx_relationships_define_id ON table_relationships(define_id);',
];

const columnsOf = async (db: codeDb.Db, table: string): Promise<string[]> =>
    (await db.executeQuery<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`))
        .map(row => row.column_name);
const countOf = async (db: codeDb.Db, table: string): Promise<number> =>
    Number((await db.executeQuery<{ count: bigint }>(`SELECT COUNT(*) AS count FROM ${table}`))[0].count);

/**
 * @description DuckDB を別のプロセスで操作する (WAL の再生は、閉じずに終わったプロセスの後に別のプロセスで開いた時に起きる)
 * @param file DB のファイル
 * @param script 処理 (`DuckDBInstance` と、ファイルのパス `file`・引数 `args` を使える)
 * @param args 引数 (JSON にして渡す)
 */
const duckdbProcess = (file: string, script: string, args: unknown = null): void => {
    execFileSync(process.execPath, ['--input-type=module', '-e',
        `import { DuckDBInstance } from '@duckdb/node-api';\nconst [file, args] = [process.argv[1], JSON.parse(process.argv[2])];\n${script}`,
        file, JSON.stringify(args)]);
};

/**
 * @description 初版のスキーマを作ってチェックポイントし、シンボルを 100 行挿入して閉じずに終わる (挿入は WAL にだけ残る)
 * @param file DB のファイル
 * @description VS Code の終了と同じ状態。拡張機能はキャッシュのインスタンスを閉じない
 */
const leaveWal = (file: string): void => duckdbProcess(file, `
    const connection = await (await DuckDBInstance.create(file)).connect();
    for (const sql of args) { await connection.run(sql); }
    await connection.run('CHECKPOINT');
    await connection.run("INSERT INTO table_symbols SELECT 'src/a.ts/' || i, NULL, 'S' || i, 5, 'src/a.ts', 0, 0, 0, 0, 0, 0, '00' FROM range(100) r(i)");
    process.exit(0);`, V1_SCHEMA);

/**
 * @description 別のプロセスで開いて WAL を再生し、閉じる (閉じる時にチェックポイントする)
 * @param file DB のファイル
 * @param checkpoint 開いた直後に CHECKPOINT を実行する
 */
const replayWal = (file: string, checkpoint: boolean): void => duckdbProcess(file, `
    const instance = await DuckDBInstance.create(file);
    const connection = await instance.connect();
    if (args) { await connection.run('CHECKPOINT'); }
    connection.closeSync();
    instance.closeSync();`, checkpoint);

/**
 * @description 開き直して、パスで引いたシンボルの件数を、索引を通る問い合わせと表の走査で数える
 * @param file DB のファイル
 * @returns [索引を通る件数, 走査の件数]
 */
const countSymbolsByPath = async (file: string): Promise<[number, number]> => {
    const instance = await DuckDBInstance.create(file);
    const connection = await instance.connect();
    const count = async (where: string) => Number((await connection.runAndReadAll(`SELECT count(*) FROM table_symbols WHERE ${where}`)).getRows()[0][0]);
    const result: [number, number] = [await count("path = 'src/a.ts'"), await count("path || '' = 'src/a.ts'")];
    connection.closeSync();
    instance.closeSync();
    return result;
};

const FACTS: FileFacts = {
    relativePath: 'src/a.ts',
    definitions: [
        { fqn: 'src/a.ts#A', name: 'A', kind: 'class', parentFqn: 'src/a.ts#', exportName: 'A', nameLine: 3, nameCharacter: 13, startLine: 3, endLine: 6, type: null },
        { fqn: 'src/a.ts#A.m', name: 'm', kind: 'method', parentFqn: 'src/a.ts#A', exportName: null, nameLine: 4, nameCharacter: 4, startLine: 4, endLine: 5,
            type: { mode: 'annotation', rootName: 'Base', memberPath: null, scopeId: 0, bindingFqn: null, array: true } },
    ],
    imports: [
        { localName: 'B', importedName: 'B', exportName: null, moduleSpec: './b', line: 0, character: 20, resolvedPath: 'src/b.ts', isExternal: false },
        { localName: 'vscode', importedName: '*', exportName: null, moduleSpec: 'vscode', line: 1, character: 24, resolvedPath: null, isExternal: true },
    ],
    occurrences: [
        { line: 3, character: 10, rootName: 'B', memberPath: null, kind: RelationshipKind.inheritance, enclosingFqn: 'src/a.ts#A', scopeId: 0, bindingFqn: null },
        { line: 4, character: 8, rootName: 'this', memberPath: 'run', kind: RelationshipKind.call, enclosingFqn: 'src/a.ts#A.m', scopeId: null, bindingFqn: null },
    ],
    hasError: false,
    elapsedMs: 1,
};

describe('codeDb', () => {
    const opened: codeDb.Db[] = [];
    const temporaries: string[] = [];
    const open = (file: string = ':memory:'): codeDb.Db => {
        const db = new codeDb.Db(file);
        opened.push(db);
        return db;
    };
    afterEach(() => {
        opened.splice(0).forEach(db => db.dispose());
        temporaries.splice(0).forEach(directory => fs.rmSync(directory, { recursive: true, force: true }));
    });

    describe('スキーマ', () => {
        it('新規の DB は最新の版で作られる', async () => {
            const db = open();
            await db.table_create();
            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect(await columnsOf(db, 'table_symbols')).toEqual(expect.arrayContaining(['fqn', 'export_name']));
            expect(await columnsOf(db, 'table_files')).toContain('facts_version');
            expect(await columnsOf(db, 'table_imports')).toEqual(
                ['path', 'local_name', 'imported_name', 'export_name', 'module_spec', 'resolved_path', 'is_external', 'line', 'character']);
            expect(await columnsOf(db, 'table_occurrences')).toEqual(
                ['path', 'line', 'character', 'root_name', 'member_path', 'kind', 'enclosing_fqn', 'scope_id', 'binding_fqn']);
            expect(await columnsOf(db, 'table_relationships_v2')).toEqual(expect.arrayContaining(['confidence', 'reference_path', 'define_path']));
            expect(await columnsOf(db, 'table_definitions')).toEqual(
                ['path', 'fqn', 'name', 'kind', 'parent_fqn', 'export_name', 'name_line', 'name_character', 'start_line', 'end_line',
                    'type_mode', 'type_root', 'type_member', 'type_scope_id', 'type_binding_fqn', 'type_array']);
            expect(await columnsOf(db, 'table_files')).toContain('resolved_version');
            expect(await columnsOf(db, 'table_files')).toContain('relationship_mode');
            expect(await columnsOf(db, 'table_relationships_v2')).toContain('reference_character');
            expect(await countOf(db, 'view_relationship_strength')).toBe(0);
        });

        it('v4 の DB を v5 へ移行すると、関係 (v2) を作り直して全ファイルを未解決に戻す', async () => {
            const db = open();
            await db.table_create();
            // 0.3.39 (v4) の状態へ戻す: 関係 (v2) に桁が無く、調査経路の列が無い (索引のある表は列を消せないため作り直す)
            await db.executeQuery('DROP VIEW view_relationship_strength');
            await db.executeQuery('DROP TABLE table_relationships_v2');
            await db.executeQuery(`CREATE TABLE table_relationships_v2 (reference_path TEXT, reference_fqn TEXT, define_path TEXT, define_fqn TEXT,
                kind INTEGER, weight DOUBLE, confidence DOUBLE, reference_line INTEGER, is_intra_file BOOLEAN)`);
            await db.executeQuery("INSERT INTO table_relationships_v2 VALUES ('src/a.ts', 'src/a.ts#', 'src/b.ts', 'src/b.ts#B', 1, 1, 1, 0, FALSE)");
            await db.executeQuery('DROP TABLE table_files');
            await db.executeQuery(`CREATE TABLE table_files (relative_path TEXT PRIMARY KEY, language_id TEXT, updated_at TIMESTAMP,
                facts_version INTEGER, resolved_version INTEGER)`);
            await db.executeQuery("INSERT INTO table_files VALUES ('src/a.ts', 'typescript', '2026-01-01 00:00:00', 1, 1)");
            await db.executeQuery('UPDATE table_schema_version SET version = 4');

            await db.table_create();

            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect(await columnsOf(db, 'table_relationships_v2')).toContain('reference_character');
            expect(await countOf(db, 'table_relationships_v2')).toBe(0);
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/a.ts']);
            // 調査経路の記録が無いファイルは LSP の経路で調べたもの
            expect(await db.codeFile_queryRelationshipModes()).toEqual(new Map([['src/a.ts', null]]));
        });

        it('v1 の DB を、行を保持したまま最新の版へ移行する', async () => {
            const db = open();
            for (const sql of V1_SCHEMA) {
                await db.executeQuery(sql);
            }
            await db.executeQuery("INSERT INTO table_files VALUES ('src/a.ts', 'typescript', '2026-01-01 00:00:00')");
            await db.executeQuery("INSERT INTO table_symbols VALUES ('src/a.ts', NULL, 'a.ts', 0, 'src/a.ts', 0, 0, 0, 0, 9, 0, '00')");
            await db.executeQuery("INSERT INTO table_relationships VALUES ('x', 'y')");

            await db.table_create();

            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect(await countOf(db, 'table_files')).toBe(1);
            expect(await countOf(db, 'table_symbols')).toBe(1);
            expect(await countOf(db, 'table_relationships')).toBe(1);
            const symbols = await db.symbol_query('src/a.ts');
            expect(symbols[0].fqn).toBeNull();
            expect((await db.codeFile_queryFactsVersions()).get('src/a.ts')).toBeNull();
        });

        it('v2 の DB を、事実を保持したまま v3 へ移行する', async () => {
            const db = open();
            for (const sql of V1_SCHEMA) {
                await db.executeQuery(sql);
            }
            // 0.3.37 (v2) の状態を作る: v2 までの移行だけを実行した DB
            await db.executeQuery('CREATE TABLE table_schema_version (version INTEGER)');
            await db.executeQuery('INSERT INTO table_schema_version VALUES (2)');
            await db.executeQuery('ALTER TABLE table_files ADD COLUMN facts_version INTEGER');
            await db.executeQuery('ALTER TABLE table_symbols ADD COLUMN fqn TEXT');
            await db.executeQuery('ALTER TABLE table_symbols ADD COLUMN export_name TEXT');
            await db.executeQuery(`CREATE TABLE table_imports (path TEXT, local_name TEXT, imported_name TEXT, export_name TEXT,
                module_spec TEXT, resolved_path TEXT, is_external BOOLEAN, line INTEGER, character INTEGER)`);
            await db.executeQuery(`CREATE TABLE table_occurrences (path TEXT, line INTEGER, character INTEGER, root_name TEXT,
                member_path TEXT, kind INTEGER, enclosing_fqn TEXT, scope_id INTEGER)`);
            await db.executeQuery(`CREATE TABLE table_relationships_v2 (reference_fqn TEXT, define_fqn TEXT, kind INTEGER DEFAULT 0,
                weight REAL DEFAULT 1.0, confidence REAL DEFAULT 1.0, reference_line INTEGER, is_intra_file BOOLEAN DEFAULT FALSE)`);
            await db.executeQuery("INSERT INTO table_files VALUES ('src/a.ts', 'typescript', '2026-01-01 00:00:00', 1)");
            await db.executeQuery("INSERT INTO table_occurrences VALUES ('src/a.ts', 1, 2, 'B', NULL, 2, 'src/a.ts#A', 0)");

            await db.table_create();

            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect(await countOf(db, 'table_occurrences')).toBe(1);
            expect(await columnsOf(db, 'table_occurrences')).toContain('binding_fqn');
            expect(await countOf(db, 'table_definitions')).toBe(0);
            // 事実は v1 の版数のままなので、次の全走査で抽出し直される (定義表を埋めるため)
            expect((await db.codeFile_queryFactsVersions()).get('src/a.ts')).toBe(1);
        });

        it('移行は何度実行しても同じ結果になる', async () => {
            const db = open();
            await db.table_create();
            await db.table_create();
            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect(await countOf(db, 'table_schema_version')).toBe(1);
        });

        it('拡張機能が作った実際の v1 DB (exsample-workspace) を複製して移行できる', async () => {
            const source = path.resolve('exsample-workspace', '.vscode', 'crd.duckdb');
            expect(fs.existsSync(source)).toBe(true);
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-migration-'));
            temporaries.push(directory);
            const copy = path.join(directory, 'crd.duckdb');
            fs.copyFileSync(source, copy);
            if (fs.existsSync(`${source}.wal`)) {
                fs.copyFileSync(`${source}.wal`, `${copy}.wal`);
            }

            const db = open(copy);
            const before = {
                files: await countOf(db, 'table_files'),
                symbols: await countOf(db, 'table_symbols'),
                relationships: await countOf(db, 'table_relationships'),
            };
            expect(before.symbols).toBeGreaterThan(0);

            await db.table_create();

            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect({
                files: await countOf(db, 'table_files'),
                symbols: await countOf(db, 'table_symbols'),
                relationships: await countOf(db, 'table_relationships'),
            }).toEqual(before);
            // 既存の関係の読み込み (showDiagram の経路) が移行後も動く
            expect((await db.relationship_quaryAll()).length).toBe(before.relationships);
        });
    });

    describe('事実', () => {
        it('定義・import 束縛・参照出現を保存し、読み戻せる', async () => {
            const db = open();
            await db.table_create();
            await db.facts_replace('src/a.ts', FACTS);
            const found = await db.facts_query('src/a.ts');
            expect(found.definitions).toEqual(FACTS.definitions);
            expect(found.imports).toEqual(FACTS.imports);
            expect(found.occurrences).toEqual(FACTS.occurrences);
        });

        it('置き換えると前の事実は残らない。null なら削除だけ行う', async () => {
            const db = open();
            await db.table_create();
            await db.facts_replace('src/a.ts', FACTS);
            await db.facts_replace('src/a.ts', { ...FACTS, imports: FACTS.imports.slice(0, 1), occurrences: [] });
            expect((await db.facts_query('src/a.ts')).imports).toHaveLength(1);
            expect((await db.facts_query('src/a.ts')).occurrences).toHaveLength(0);
            await db.facts_replace('src/a.ts', null);
            expect(await countOf(db, 'table_imports')).toBe(0);
        });

        it('失敗したら置き換え前の事実へロールバックする', async () => {
            const db = open();
            await db.table_create();
            await db.facts_replace('src/a.ts', FACTS);
            const broken = { ...FACTS, occurrences: [{ ...FACTS.occurrences[0], kind: 'not a number' as unknown as RelationshipKind }] };
            await expect(db.facts_replace('src/a.ts', broken)).rejects.toThrow();
            expect(await db.facts_query('src/a.ts')).toEqual({ definitions: FACTS.definitions, imports: FACTS.imports, occurrences: FACTS.occurrences });
        });

        it('大量の参照出現を分割して挿入できる', async () => {
            const db = open();
            await db.table_create();
            const occurrences = Array.from({ length: 1234 }, (_, index) => ({ ...FACTS.occurrences[0], line: index }));
            await db.facts_replace('src/a.ts', { ...FACTS, occurrences });
            expect(await countOf(db, 'table_occurrences')).toBe(1234);
        });

        it('事実抽出の版数を記録する', async () => {
            const db = open();
            await db.table_create();
            await db.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', new Date()), 1);
            await db.codeFile_upsert(new codeFiles.File('src/b.c', 'c', new Date()));
            expect(await db.codeFile_queryFactsVersions()).toEqual(new Map([['src/a.ts', 1], ['src/b.c', null]]));
            await db.facts_replace('src/b.c', null, 7);
            expect((await db.codeFile_queryFactsVersions()).get('src/b.c')).toBe(7);
        });

        it('事実を置き換えると、そのファイルと import しているファイルの名前解決が未解決に戻る', async () => {
            const db = open();
            await db.table_create();
            for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
                await db.codeFile_upsert(new codeFiles.File(file, 'typescript', new Date()), 1);
            }
            await db.relationships_v2_replace(['src/a.ts', 'src/b.ts', 'src/c.ts'], [], 1);
            expect(await db.resolution_pendingFiles(1, 1)).toEqual([]);

            // a.ts は b.ts を import している (FACTS の imports)。b.ts の事実が変わると a.ts も解決し直す
            await db.facts_replace('src/a.ts', FACTS);
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/a.ts']);
            await db.relationships_v2_replace(['src/a.ts'], [], 1);
            await db.facts_replace('src/b.ts', null);
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/a.ts', 'src/b.ts']);
            // 版数が上がれば全ファイルが対象になり、事実が古いファイルは対象外
            expect(await db.resolution_pendingFiles(1, 2)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
            expect(await db.resolution_pendingFiles(2, 1)).toEqual([]);
        });

        it('事実を置き換えると、推移的に import しているファイルも未解決に戻る (段2 の再エクスポート・段3 の型)', async () => {
            const db = open();
            await db.table_create();
            const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
            for (const file of files) {
                await db.codeFile_upsert(new codeFiles.File(file, 'typescript', new Date()), 1);
            }
            const importing = (from: string, to: string): FileFacts =>
                ({ ...FACTS, relativePath: from, definitions: [], occurrences: [], imports: [{ ...FACTS.imports[0], resolvedPath: to }] });
            // a → b → c (c と b は互いに import する循環)。d は無関係
            await db.facts_replace('src/a.ts', importing('src/a.ts', 'src/b.ts'));
            await db.facts_replace('src/b.ts', importing('src/b.ts', 'src/c.ts'));
            await db.facts_replace('src/c.ts', importing('src/c.ts', 'src/b.ts'));
            await db.relationships_v2_replace(files, [], 1);

            await db.facts_replace('src/c.ts', importing('src/c.ts', 'src/b.ts'));
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
        });

        it('段4 の候補が増減した名前を引いているファイルを未解決に戻す', async () => {
            const db = open();
            await db.table_create();
            const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
            for (const file of files) {
                await db.codeFile_upsert(new codeFiles.File(file, 'typescript', new Date()), 1);
            }
            const occurrence = FACTS.occurrences[0];
            // b.ts は型の分からない値のメンバ run を、c.ts は束縛の無い名前 helper を、d.ts は束縛のある名前 run を引く
            await db.facts_replace('src/b.ts', { ...FACTS, relativePath: 'src/b.ts', definitions: [], imports: [],
                occurrences: [{ ...occurrence, rootName: 'value', memberPath: 'x.run', scopeId: 1 }] });
            await db.facts_replace('src/c.ts', { ...FACTS, relativePath: 'src/c.ts', definitions: [], imports: [],
                occurrences: [{ ...occurrence, rootName: 'helper', memberPath: null, scopeId: null }] });
            await db.facts_replace('src/d.ts', { ...FACTS, relativePath: 'src/d.ts', definitions: [], imports: [],
                occurrences: [{ ...occurrence, rootName: 'run', memberPath: null, scopeId: 0 }] });
            await db.facts_replace('src/a.ts', { ...FACTS, imports: [], occurrences: [] });
            await db.relationships_v2_replace(files, [], 1);

            // メソッド run を足す: b.ts だけ (d.ts の run はファイル内で束縛されている)
            const method = { ...FACTS.definitions[1], fqn: 'src/a.ts#A.run', name: 'run', kind: 'method', type: null };
            await db.facts_replace('src/a.ts', { ...FACTS, imports: [], occurrences: [], definitions: [...FACTS.definitions, method] });
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/a.ts', 'src/b.ts']);

            // 同じ定義のまま置き換えても他のファイルは対象にならない
            await db.relationships_v2_replace(files, [], 1);
            await db.facts_replace('src/a.ts', { ...FACTS, imports: [], occurrences: [], definitions: [...FACTS.definitions, method] });
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/a.ts']);

            // スクリプト (import / export の無いファイル) のトップレベルの関数 helper はグローバル: 削除すると c.ts が対象になる
            await db.relationships_v2_replace(files, [], 1);
            const helper = { ...FACTS.definitions[0], fqn: 'src/e.ts#helper', name: 'helper', kind: 'function', parentFqn: 'src/e.ts#', exportName: null };
            await db.codeFile_upsert(new codeFiles.File('src/e.ts', 'typescript', new Date()), 1);
            await db.facts_replace('src/e.ts', { ...FACTS, relativePath: 'src/e.ts', imports: [], occurrences: [], definitions: [helper] });
            await db.relationships_v2_replace([...files, 'src/e.ts'], [], 1);
            await db.facts_deleteFile('src/e.ts');
            expect(await db.resolution_pendingFiles(1, 1)).toEqual(['src/c.ts', 'src/e.ts']);
        });

        it('関係 (v2) を参照元ファイル単位で置き換える', async () => {
            const db = open();
            await db.table_create();
            await db.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', new Date()), 1);
            const relationship: RelationshipV2 = {
                referencePath: 'src/a.ts', referenceFqn: 'src/a.ts#A', definePath: 'src/b.ts', defineFqn: 'src/b.ts#B',
                kind: RelationshipKind.inheritance, weight: 10, confidence: 0.95, referenceLine: 3, referenceCharacter: 10, isIntraFile: false,
            };
            await db.relationships_v2_replace(['src/a.ts'], [relationship, { ...relationship, referenceLine: 9 }], 1);
            await db.relationships_v2_replace(['src/b.ts'], [{ ...relationship, referencePath: 'src/b.ts' }], 1);
            await db.relationships_v2_replace(['src/a.ts'], [relationship], 1);
            expect(await db.relationships_v2_query('src/a.ts')).toEqual([relationship]);
            expect(await db.relationships_v2_query()).toHaveLength(2);
            // 集約ビューは fqn の組と種類ごとにまとめる (2行とも src/a.ts#A → src/b.ts#B の継承)。確信度は DOUBLE で誤差が乗らない
            const strength = await db.executeQuery('SELECT occurrence_count, strength FROM view_relationship_strength');
            expect(strength.map(row => [Number(row.occurrence_count), Number(row.strength)])).toEqual([[2, 19]]);
        });

        it('ファイル単位で事実を削除する', async () => {
            const db = open();
            await db.table_create();
            await db.facts_replace('src/a.ts', FACTS);
            await db.facts_replace('src/b.ts', FACTS);
            await db.facts_deleteFile('src/a.ts');
            expect((await db.facts_query('src/a.ts')).occurrences).toHaveLength(0);
            expect((await db.facts_query('src/a.ts')).definitions).toHaveLength(0);
            expect((await db.facts_query('src/b.ts')).occurrences).toHaveLength(2);
        });
    });

    describe('関係の調査経路 (Stage 4)', () => {
        const position = new vscode.Position(0, 0);
        const symbolOf = (id: string, file: string, fqn: string, parentId: string | null) => {
            const symbol = new SYMBOL.SymbolModel(id, id, parentId ? vscode.SymbolKind.Class : vscode.SymbolKind.File, file,
                position, position, position, Buffer.alloc(1), parentId);
            symbol.fqn = fqn;
            return symbol;
        };
        const v2 = (referencePath: string, definePath: string, confidence: number, isIntraFile: boolean = false): RelationshipV2 => ({
            referencePath: referencePath, referenceFqn: `${referencePath}#`, definePath: definePath, defineFqn: `${definePath}#X`,
            kind: RelationshipKind.call, weight: 5, confidence: confidence, referenceLine: 1, referenceCharacter: 2, isIntraFile: isIntraFile,
        });

        it('ファイルごとの調査経路を記録する (既定は lsp)', async () => {
            const db = open();
            await db.table_create();
            await db.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', new Date()), 1, 'ast');
            await db.codeFile_upsert(new codeFiles.File('src/b.c', 'c', new Date()));
            expect(await db.codeFile_queryRelationshipModes()).toEqual(new Map([['src/a.ts', 'ast'], ['src/b.c', 'lsp']]));
            await db.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', new Date()), 1, 'lsp');
            expect((await db.codeFile_queryRelationshipModes()).get('src/a.ts')).toBe('lsp');
        });

        it('図には、定義側が LSP の経路の LSP 由来の関係と、参照元が AST の経路の関係 (v2) を出す', async () => {
            const db = open();
            await db.table_create();
            await db.codeFile_upsert(new codeFiles.File('a.ts', 'typescript', new Date()), 1, 'ast');
            await db.codeFile_upsert(new codeFiles.File('b.ts', 'typescript', new Date()), 1, 'lsp');
            await db.codeFile_upsert(new codeFiles.File('c.c', 'c', new Date()));
            await db.symbol_inserts([symbolOf('a', 'a.ts', 'a.ts#', null), symbolOf('a/A', 'a.ts', 'a.ts#A', 'a'),
                symbolOf('b', 'b.ts', 'b.ts#', null), symbolOf('b/B', 'b.ts', 'b.ts#B', 'b'), symbolOf('c/C', 'c.c', 'c.c#C', 'c')]);
            // LSP 由来: b → a (定義側 a は AST の経路なので出さない)、a → b・a → c (定義側が LSP の経路なので出す)
            await db.executeQuery("INSERT INTO table_relationships VALUES ('b/B', 'a/A'), ('a/A', 'b/B'), ('a/A', 'c/C')");
            expect((await db.relationship_queryLspMode()).map(entry => `${entry.reference.id}->${entry.define.id}`).sort()).toEqual(['a/A->b/B', 'a/A->c/C']);

            // v2: 参照元が AST の経路で、ファイル間で、確信度が閾値以上のもの
            await db.relationships_v2_replace(['a.ts'], [v2('a.ts', 'b.ts', 0.95), v2('a.ts', 'b.ts', 0.5), v2('a.ts', 'a.ts', 1, true)], 1);
            await db.relationships_v2_replace(['b.ts'], [v2('b.ts', 'a.ts', 0.95)], 1);
            expect((await db.relationships_v2_queryAstMode(0.7)).map(entry => [entry.referencePath, entry.confidence])).toEqual([['a.ts', 0.95]]);
            expect(await db.relationships_v2_queryAstMode(0)).toHaveLength(2);

            // 定義側のファイル単位で LSP 由来の関係を消す
            await db.relationship_deleteDefinePath('b.ts');
            expect((await db.relationship_quaryAll()).map(entry => `${entry.reference.id}->${entry.define.id}`).sort()).toEqual(['a/A->c/C', 'b/B->a/A']);
        });

        it('低確信度の関係を読み、確定した結果で置き換える', async () => {
            const db = open();
            await db.table_create();
            const weak = v2('a.ts', 'b.ts', 0.25);
            await db.relationships_v2_replace(['a.ts'], [weak, { ...weak, defineFqn: 'c.ts#X', definePath: 'c.ts' }, v2('a.ts', 'b.ts', 0.95)], 1);
            const uncertain = await db.relationships_v2_queryUncertain(['a.ts', 'z.ts'], 0.7);
            expect(uncertain.map(entry => entry.defineFqn)).toEqual(['b.ts#X', 'c.ts#X']);

            await db.relationships_v2_confirm(uncertain, [{ ...weak, confidence: 0.99 }]);
            expect((await db.relationships_v2_query('a.ts')).map(entry => [entry.defineFqn, entry.confidence]).sort()).toEqual([['b.ts#X', 0.95], ['b.ts#X', 0.99]]);
        });

        it('名前の位置にある定義を引く (引数は除く)', async () => {
            const db = open();
            await db.table_create();
            const parameter = { ...FACTS.definitions[0], fqn: 'src/a.ts#A.p', name: 'p', kind: 'parameter', nameLine: 9, nameCharacter: 1 };
            await db.facts_replace('src/a.ts', { ...FACTS, definitions: [...FACTS.definitions, parameter] });
            expect(await db.definitions_queryAt('src/a.ts', 4, 4)).toBe('src/a.ts#A.m');
            expect(await db.definitions_queryAt('src/a.ts', 9, 1)).toBeNull();
            expect(await db.definitions_queryAt('src/b.ts', 4, 4)).toBeNull();
        });
    });

    describe('シンボルの解決キー', () => {
        it('完全修飾名と export 名を保存・更新・読み戻せる', async () => {
            const db = open();
            await db.table_create();
            const position = new vscode.Position(0, 0);
            const symbol = new SYMBOL.SymbolModel('src/a.ts/Class.A@00', 'A', vscode.SymbolKind.Class, 'src/a.ts',
                position, position, new vscode.Position(3, 1), Buffer.alloc(1), 'src/a.ts');
            symbol.fqn = 'src/a.ts#A';
            symbol.exportName = 'A';
            await db.symbol_inserts([symbol]);
            expect((await db.symbol_query('src/a.ts')).map(found => [found.fqn, found.exportName])).toEqual([['src/a.ts#A', 'A']]);

            symbol.exportName = null;
            await db.symbol_update(symbol);
            expect((await db.symbol_quaryAll()).map(found => [found.fqn, found.exportName])).toEqual([['src/a.ts#A', null]]);
        });

        it('ID の配列でシンボルを削除する。空の配列なら何もしない', async () => {
            const db = open();
            await db.table_create();
            const position = new vscode.Position(0, 0);
            const symbolOf = (name: string) => new SYMBOL.SymbolModel(`src/a.ts/${name}`, name, vscode.SymbolKind.Class, 'src/a.ts',
                position, position, position, Buffer.alloc(1), 'src/a.ts');
            await db.symbol_inserts(['A', 'B', 'C'].map(symbolOf));
            await db.symbol_delete([]);
            await db.symbol_delete(['src/a.ts/A', 'src/a.ts/C']);
            expect((await db.symbol_query('src/a.ts')).map(found => found.name)).toEqual(['B']);
        });
    });

    describe('DuckDB の接続', () => {
        it('更新日時を Date で読み戻せる', async () => {
            const db = open();
            await db.table_create();
            const updated = new Date('2026-10-15T01:02:03.456Z');
            await db.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', updated));
            const [file] = await db.codeFile_query('src/a.ts');
            expect(file.updated).toBeInstanceOf(Date);
            expect(file.updated.toISOString()).toBe(updated.toISOString());
        });

        it('待たずに呼んだ問い合わせも、呼んだ順に実行する', async () => {
            const db = open();
            await db.table_create();
            const position = new vscode.Position(0, 0);
            const inserts = ['A', 'B', 'C'].map(name => db.symbol_inserts([new SYMBOL.SymbolModel(`src/a.ts/${name}`, name,
                vscode.SymbolKind.Class, 'src/a.ts', position, position, position, Buffer.alloc(1), 'src/a.ts')]));
            const count = countOf(db, 'table_symbols');
            await Promise.all(inserts);
            expect(await count).toBe(3);
        });

        it('同じファイルを2つの Db で開き、片方を破棄しても他方は使える', async () => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-db-'));
            temporaries.push(directory);
            const file = path.join(directory, 'crd.duckdb');
            const first = open(file);
            await first.table_create();
            await first.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', new Date()));

            const second = new codeDb.Db(file);
            expect((await second.codeFile_queryAll()).map(found => found.relative_path)).toEqual(['src/a.ts']);
            second.dispose();

            await first.codeFile_upsert(new codeFiles.File('src/b.ts', 'typescript', new Date()));
            expect(await countOf(first, 'table_files')).toBe(2);
        });

        it('開けないファイルは最初の問い合わせで失敗する', async () => {
            const db = open(path.join(os.tmpdir(), 'crd-db-missing', 'no', 'such', 'crd.duckdb'));
            await expect(db.table_create()).rejects.toThrow();
        });
    });

    // DuckDB 1.4〜1.5.6 は、WAL を再生した後の最初のチェックポイントが自動か終了時だと、再生した行の無い副索引を書き出す
    // (duckdb/duckdb#26828・#26106)。索引を通る `WHERE path = ?` が 0 件になり、ファイル単位の読み込みが空になる
    describe('WAL の再生で副索引が壊れる DuckDB の不具合', () => {
        const temporaryFile = (): string => {
            const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-db-'));
            temporaries.push(directory);
            return path.join(directory, 'crd.duckdb');
        };

        it('再生の後に閉じる時のチェックポイントで索引が壊れ、開いた直後の CHECKPOINT なら壊れない', async () => {
            // DuckDB を更新してこのテストが失敗したら、不具合が直っている。Db の CHECKPOINT と MIGRATION_V6 を外せるか検討する
            const broken = temporaryFile();
            leaveWal(broken);
            replayWal(broken, false);
            expect(await countSymbolsByPath(broken)).toEqual([0, 100]);

            const checkpointed = temporaryFile();
            leaveWal(checkpointed);
            replayWal(checkpointed, true);
            expect(await countSymbolsByPath(checkpointed)).toEqual([100, 100]);
        });

        it('Db は開いた直後にチェックポイントし、残っていた WAL を再生した行を索引ごと書き出す', async () => {
            const file = temporaryFile();
            leaveWal(file);
            expect(fs.existsSync(`${file}.wal`)).toBe(true);

            const db = open(file);
            expect(await countOf(db, 'table_symbols')).toBe(100);
            expect(fs.existsSync(`${file}.wal`)).toBe(false);
        });

        it('壊れた DB は v6 への移行で副索引を作り直し、パスで引けて削除できるようになる', async () => {
            const file = temporaryFile();
            leaveWal(file);
            replayWal(file, false);

            const db = open(file);
            await db.table_create();
            expect(await db.schema_version()).toBe(codeDb.SCHEMA_VERSION);
            expect(await db.symbol_query('src/a.ts')).toHaveLength(100);
            // 壊れた索引のままだと、表を走査する削除は FATAL (Failed to delete all rows from index) で DB を使えなくする
            await db.executeQuery("DELETE FROM table_symbols WHERE path || '' = 'src/a.ts'");
            expect(await countOf(db, 'table_symbols')).toBe(0);
        });
    });
});
