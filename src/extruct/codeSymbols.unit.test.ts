/** @file シンボルへの解決キーの付与の単体テスト */
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import * as SYMBOL from './symbol';
import { attachAstKeys } from './codeSymbols';
import { AstParser, LocalFacts, collectLocalFacts, resolveAstResources } from './ast';

const FILE = 'src/sample.ts';

/** DocumentSymbolProvider 相当のシンボル (名前の開始位置 = selectionRange.start) */
const symbolOf = (name: string, define: [number, number], range: [number, number, number, number], parentId: string | null = FILE): SYMBOL.SymbolModel =>
    new SYMBOL.SymbolModel(`${parentId}/${name}@${define.join(':')}`, name, vscode.SymbolKind.Variable, FILE,
        new vscode.Position(define[0], define[1]),
        new vscode.Position(range[0], range[1]), new vscode.Position(range[2], range[3]),
        Buffer.alloc(1), parentId);

describe('attachAstKeys', () => {
    let parser: AstParser;
    let facts: LocalFacts;
    const source = [
        'export class Sample {',          // 0
        '    run(): void {}',             // 1
        '    get x() { return 1; }',      // 2
        '    set x(v: number) {}',        // 3
        '}',                              // 4
        'const helper = () => 1;',        // 5
        'export { helper as h };',        // 6
    ].join('\n');

    beforeAll(async () => {
        parser = await AstParser.create(resolveAstResources(path.resolve(process.cwd())));
        facts = await collectLocalFacts(parser, 'typescript', FILE, source) as LocalFacts;
    });

    afterAll(() => {
        parser?.dispose();
    });

    it('名前の開始位置が一致する定義を付ける', () => {
        const root = symbolOf('sample.ts', [0, 0], [0, 0, 6, 0], null);
        const symbols = [
            root,
            symbolOf('Sample', [0, 13], [0, 0, 4, 1]),
            symbolOf('run', [1, 4], [1, 4, 1, 18], 'Sample'),
            symbolOf('x', [2, 8], [2, 4, 2, 25], 'Sample'),
            symbolOf('x', [3, 8], [3, 4, 3, 23], 'Sample'),
            symbolOf('helper', [5, 6], [5, 6, 5, 22]),
        ];
        expect(attachAstKeys(FILE, symbols, facts.definitions)).toBe(5);
        expect(symbols.map(symbol => [symbol.fqn, symbol.exportName])).toEqual([
            [`${FILE}#`, null],
            [`${FILE}#Sample`, 'Sample'],
            [`${FILE}#Sample.run`, null],
            [`${FILE}#Sample.x`, null],
            [`${FILE}#Sample.x~2`, null],
            [`${FILE}#helper`, 'h'],
        ]);
    });

    it('位置が一致しなければ、シンボルの範囲内にある同名の定義を付ける', () => {
        // selectionRange が宣言の先頭を指す言語サーバの場合
        const symbols = [symbolOf('Sample', [0, 0], [0, 0, 4, 1])];
        expect(attachAstKeys(FILE, symbols, facts.definitions)).toBe(1);
        expect(symbols[0].fqn).toBe(`${FILE}#Sample`);
    });

    it('対応する定義が無いシンボルの解決キーは null にする (以前の値を残さない)', () => {
        const symbol = symbolOf('callback', [5, 15], [5, 15, 5, 22]);
        symbol.fqn = 'stale';
        symbol.exportName = 'stale';
        expect(attachAstKeys(FILE, [symbol], facts.definitions)).toBe(0);
        expect([symbol.fqn, symbol.exportName]).toEqual([null, null]);
    });

    it('1つの定義は1つのシンボルにしか付けない', () => {
        const symbols = [symbolOf('run', [1, 4], [1, 4, 1, 18]), symbolOf('run', [1, 4], [1, 4, 1, 18])];
        expect(attachAstKeys(FILE, symbols, facts.definitions)).toBe(1);
        expect(symbols.map(symbol => symbol.fqn)).toEqual([`${FILE}#Sample.run`, null]);
    });
});
