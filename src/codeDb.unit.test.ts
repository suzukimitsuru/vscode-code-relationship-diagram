/** @file DuckDB 操作の単体テスト (スキーマ移行・事実の保存) */
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
            expect(await countOf(db, 'view_relationship_strength')).toBe(0);
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

        it('関係 (v2) を参照元ファイル単位で置き換える', async () => {
            const db = open();
            await db.table_create();
            await db.codeFile_upsert(new codeFiles.File('src/a.ts', 'typescript', new Date()), 1);
            const relationship: RelationshipV2 = {
                referencePath: 'src/a.ts', referenceFqn: 'src/a.ts#A', definePath: 'src/b.ts', defineFqn: 'src/b.ts#B',
                kind: RelationshipKind.inheritance, weight: 10, confidence: 0.95, referenceLine: 3, isIntraFile: false,
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
    });
});
