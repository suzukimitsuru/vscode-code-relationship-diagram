/** @file ファイル差分キュー: AST の事実の埋め戻し (facts 項目) の結合テスト */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import * as codeDb from '../../codeDb';
import * as SYMBOL from '../../extruct/symbol';
import { AstParser, FACTS_VERSION, FactsExtractor, ModuleResolver, RelationshipKind, resolveAstResources } from '../../extruct/ast';
import { scanDifference } from '../examine';
import { Completed, QueueProcessor } from './queue';

const ASSOCIATIONS = { '**/*.ts': 'typescript', '**/*.c': 'c' };

describe('QueueProcessor (facts 項目)', () => {
    let workspace: string;
    let db: codeDb.Db;
    let parser: AstParser;
    let processor: QueueProcessor | null;
    const errors: unknown[] = [];

    beforeEach(async () => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-queue-'));
        fs.mkdirSync(path.join(workspace, 'src'));
        fs.writeFileSync(path.join(workspace, 'src', 'a.ts'), 'import { B } from "./b";\nexport class A extends B {}\n');
        // BOM 付き。1行目の参照出現の桁で、BOM を内容に含めていない事を確かめる
        fs.writeFileSync(path.join(workspace, 'src', 'b.ts'), '\uFEFFexport class B extends Base {}\n');
        fs.writeFileSync(path.join(workspace, 'src', 'main.c'), 'int main(void) { return 0; }\n');
        db = new codeDb.Db(':memory:');
        await db.table_create();
        parser = await AstParser.create(resolveAstResources(path.resolve(process.cwd())));
        processor = null;
        errors.length = 0;
    });

    afterEach(async () => {
        await processor?.dispose();
        parser.dispose();
        db.dispose();
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    /** v1 の DB 相当の状態: ファイルとシンボルは登録済みで、事実は未抽出 */
    const registerAsV1 = async (): Promise<void> => {
        const difference = await scanDifference(workspace, ASSOCIATIONS, db, () => {}, () => {});
        for (const file of difference.additions) {
            await db.codeFile_upsert(file, null);
        }
        const position = (line: number, character: number) => new vscode.Position(line, character);
        const root = new SYMBOL.SymbolModel(path.join('src', 'a.ts'), 'a.ts', vscode.SymbolKind.File, path.join('src', 'a.ts'),
            position(0, 0), position(0, 0), position(2, 0), Buffer.alloc(32), null);
        const symbolA = new SYMBOL.SymbolModel(`${root.id}/Class.A@00`, 'A', vscode.SymbolKind.Class, root.path,
            position(1, 13), position(1, 0), position(1, 27), Buffer.alloc(1), root.id);
        await db.symbol_inserts([root, symbolA]);
    };

    const run = async (): Promise<Completed> => {
        processor = new QueueProcessor({
            workspaceFolder: workspace, db, concurrency: 1,
            facts: new FactsExtractor(parser, new ModuleResolver(workspace)),
            log: () => {}, error: (_message, error) => errors.push(error), progress: () => {},
        });
        const completed = new Promise<Completed>(resolve => processor!.onCompleted(resolve));
        const difference = await scanDifference(workspace, ASSOCIATIONS, db, () => {}, () => {});
        expect(difference.toItems()).toEqual([]);   // 内容は変わっていないので upsert は起きない
        processor.enqueueDifference(difference);
        return completed;
    };

    it('変更の無いファイルの事実を LSP を使わずに埋め戻す', async () => {
        await registerAsV1();
        await run();
        expect(errors).toEqual([]);

        const a = path.join('src', 'a.ts');
        const b = path.join('src', 'b.ts');
        const facts = await db.facts_query(a);
        expect(facts.imports).toMatchObject([{ localName: 'B', importedName: 'B', resolvedPath: b, isExternal: false }]);
        expect(facts.occurrences).toMatchObject([{ rootName: 'B', kind: RelationshipKind.inheritance, enclosingFqn: `${a}#A`, scopeId: 0 }]);

        // 既存のシンボルへ解決キーが付く
        expect((await db.symbol_query(a)).map(symbol => [symbol.fqn, symbol.exportName])).toEqual([[`${a}#`, null], [`${a}#A`, 'A']]);

        // 版数が記録され、AST 未対応の言語 (C) は対象外のまま
        const versions = await db.codeFile_queryFactsVersions();
        expect(versions.get(a)).toBe(FACTS_VERSION);
        expect(versions.get(b)).toBe(FACTS_VERSION);
        expect(versions.get(path.join('src', 'main.c'))).toBeNull();
    });

    it('BOM 付きのファイルも1行目の桁がずれない (VSCode の TextDocument と同じく BOM を含めない)', async () => {
        await registerAsV1();
        await run();
        const facts = await db.facts_query(path.join('src', 'b.ts'));
        expect(facts.occurrences).toMatchObject([{ rootName: 'Base', line: 0, character: 'export class B extends '.length }]);
    });

    it('埋め戻した後の全走査では facts 項目を作らない', async () => {
        await registerAsV1();
        await run();
        const again = await scanDifference(workspace, ASSOCIATIONS, db, () => {}, () => {});
        expect(again.factsStale).toEqual([]);
    });

    it('事実抽出器が無ければ facts 項目を処理しない (パーサが使えない環境)', async () => {
        await registerAsV1();
        processor = new QueueProcessor({
            workspaceFolder: workspace, db, facts: null,
            log: () => {}, error: (_message, error) => errors.push(error), progress: () => {},
        });
        const difference = await scanDifference(workspace, ASSOCIATIONS, db, () => {}, () => {});
        expect(difference.factsStale.length).toBe(2);
        processor.enqueueDifference(difference);
        expect(processor.isProcessing).toBe(false);
    });
});
