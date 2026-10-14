/** @file シンボルへの解決キーの付与の単体テスト */
import * as path from 'path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as SYMBOL from './symbol';
import { attachAstKeys, extract } from './codeSymbols';
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

    it('引数の定義は付けない (同じ位置から始まるコールバックのシンボルと取り違えない)', async () => {
        const callbackFacts = await collectLocalFacts(parser, 'typescript', FILE, 'const files = rows.map(row => row);') as LocalFacts;
        // map() callback のシンボルは引数 row と同じ位置から始まる
        const symbols = [symbolOf('files', [0, 6], [0, 6, 0, 34]), symbolOf('map() callback', [0, 22], [0, 22, 0, 32], 'files')];
        expect(attachAstKeys(FILE, symbols, callbackFacts.definitions)).toBe(1);
        expect(symbols.map(symbol => symbol.fqn)).toEqual([`${FILE}#files`, null]);
    });

    it('1つの定義は1つのシンボルにしか付けない', () => {
        const symbols = [symbolOf('run', [1, 4], [1, 4, 1, 18]), symbolOf('run', [1, 4], [1, 4, 1, 18])];
        expect(attachAstKeys(FILE, symbols, facts.definitions)).toBe(1);
        expect(symbols.map(symbol => symbol.fqn)).toEqual([`${FILE}#Sample.run`, null]);
    });
});

describe('extract', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    /** DocumentSymbolProvider の結果 (本文は範囲の行の文字列) */
    const documentSymbol = (name: string, line: number, children: unknown[] = []): unknown => ({
        name: name, kind: vscode.SymbolKind.Variable,
        range: new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 10)),
        selectionRange: new vscode.Range(new vscode.Position(line, 6), new vscode.Position(line, 6 + name.length)),
        children: children,
    });

    it('種類・名前・本文が同じ兄弟の ID は文書順の番号で区別する (主キー違反でファイルの保存が失敗しないよう)', async () => {
        const lines = ['function f() {', 'for (const x of a) {}', 'for (const x of a) {}', 'for (const x of a) {}', '}'];
        vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue([
            documentSymbol('f', 0, [documentSymbol('x', 1), documentSymbol('x', 2), documentSymbol('x', 3)]),
        ] as never);
        const document = {
            uri: vscode.Uri.file('/w/a.ts'), lineCount: lines.length,
            getText: (range: vscode.Range) => lines[range.start.line],
        } as unknown as vscode.TextDocument;

        const symbols = await extract('a.ts', document);
        const ids = symbols.map(symbol => symbol.id);
        expect(new Set(ids).size).toBe(ids.length);
        const xs = symbols.filter(symbol => symbol.name === 'x').map(symbol => symbol.id);
        expect(xs[1]).toBe(`${xs[0]}~2`);
        expect(xs[2]).toBe(`${xs[0]}~3`);
    });
});
