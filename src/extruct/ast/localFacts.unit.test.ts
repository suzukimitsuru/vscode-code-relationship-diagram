/** @file Phase A: ローカル事実抽出の単体テスト */
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AstParser } from './parser';
import { resolveAstResources } from './resources';
import { AstOccurrence, LocalFacts, collectLocalFacts, fileFqn } from './localFacts';
import { RelationshipKind } from './relationshipKind';

// 資産は dist/ 配下に置かれる (vitest.config.mts の globalSetup が配置する)
const resources = resolveAstResources(path.resolve(process.cwd()));
const FILE = 'src/sample.ts';

describe('localFacts', () => {
    let parser: AstParser;

    beforeAll(async () => {
        parser = await AstParser.create(resources);
    });

    afterAll(() => {
        parser?.dispose();
    });

    const facts = async (source: string, languageId: string = 'typescript'): Promise<LocalFacts> => {
        const found = await collectLocalFacts(parser, languageId, FILE, source);
        expect(found).not.toBeNull();
        return found as LocalFacts;
    };
    const fqns = (found: LocalFacts): string[] => found.definitions.map(definition => definition.fqn);
    const occurrence = (found: LocalFacts, rootName: string, memberPath: string | null = null): AstOccurrence | undefined =>
        found.occurrences.find(entry => entry.rootName === rootName && entry.memberPath === memberPath);

    describe('完全修飾名', () => {
        it('入れ子の定義を . で連結する', async () => {
            const found = await facts([
                'export class Sample {',
                '    private value: number = 0;',
                '    public run(): void {',
                '        const helper = () => 1;',
                '    }',
                '}',
                'function top() {}',
            ].join('\n'));
            expect(fqns(found)).toEqual([
                `${FILE}#Sample`,
                `${FILE}#Sample.value`,
                `${FILE}#Sample.run`,
                `${FILE}#Sample.run.helper`,
                `${FILE}#top`,
            ]);
            expect(found.definitions.find(definition => definition.name === 'run')?.parentFqn).toBe(`${FILE}#Sample`);
            expect(found.definitions.find(definition => definition.name === 'top')?.parentFqn).toBe(fileFqn(FILE));
        });

        it('同じ親・同じ名前の2つ目以降に ~N を付けてファイル内で一意にする', async () => {
            const found = await facts('class A { get x() { return 1; } set x(v: number) {} }');
            expect(fqns(found)).toEqual([`${FILE}#A`, `${FILE}#A.x`, `${FILE}#A.x~2`]);
        });

        it('オーバーロードの宣言は本体を持つ定義へまとめる', async () => {
            const found = await facts([
                'function f(a: string): void;',
                'function f(a: number): void;',
                'function f(a: any) {}',
                'class C { m(a: string): void; m(a: any) {} }',
            ].join('\n'));
            expect(fqns(found)).toEqual([`${FILE}#f`, `${FILE}#C`, `${FILE}#C.m`]);
            // 残るのは本体を持つ定義 (名前の位置が本体側)
            expect(found.definitions[0].nameLine).toBe(2);
        });

        it('本体の無い宣言だけなら最初の1つを残す (インターフェース・宣言ファイル)', async () => {
            const found = await facts([
                'interface I { m(a: string): void; m(a: number): void; p: string; }',
                'declare function g(): void;',
                'declare function g(a: number): void;',
            ].join('\n'));
            expect(fqns(found)).toEqual([`${FILE}#I`, `${FILE}#I.m`, `${FILE}#I.p`, `${FILE}#g`]);
        });

        it('型注釈の型リテラルのメンバは定義にしない (同名のローカル変数の完全修飾名をずらさない)', async () => {
            const found = await facts([
                'type Pair = { left: number; swap(): Pair };',
                'class A {',
                '    m(): Promise<{ doc: string, symbols: number }> {',
                '        const doc = "";',
                '        return Promise.resolve({ doc, symbols: 0 });',
                '    }',
                '}',
            ].join('\n'));
            expect(fqns(found)).toEqual([`${FILE}#Pair`, `${FILE}#Pair.left`, `${FILE}#Pair.swap`, `${FILE}#A`, `${FILE}#A.m`, `${FILE}#A.m.doc`]);
        });

        it('列挙子と名前空間を定義として扱う', async () => {
            const found = await facts('enum E { A, B = 2 }\nnamespace N { export function f() {} }');
            expect(fqns(found)).toEqual([`${FILE}#E`, `${FILE}#E.A`, `${FILE}#E.B`, `${FILE}#N`, `${FILE}#N.f`]);
        });

        it('名前の位置は UTF-16 の桁で数える (VSCode の Position と同じ単位)', async () => {
            const found = await facts('const あい = 1; const b = 2;');
            expect(found.definitions.find(definition => definition.name === 'b')?.nameCharacter).toBe(20);
        });
    });

    describe('export 名', () => {
        it('export 文の宣言はトップレベルの名前で export される', async () => {
            const found = await facts([
                'export class A {}',
                'export const b = 1, c = 2;',
                'export default class D {}',
                'export interface I {}',
                'class Hidden { export() {} }',
            ].join('\n'));
            const names = Object.fromEntries(found.definitions.map(definition => [definition.fqn, definition.exportName]));
            expect(names[`${FILE}#A`]).toBe('A');
            expect(names[`${FILE}#b`]).toBe('b');
            expect(names[`${FILE}#c`]).toBe('c');
            expect(names[`${FILE}#D`]).toBe('default');
            expect(names[`${FILE}#I`]).toBe('I');
            expect(names[`${FILE}#Hidden`]).toBeNull();
            expect(names[`${FILE}#Hidden.export`]).toBeNull();
        });

        it('export 句と export default <識別子> を反映する', async () => {
            const found = await facts('class A {}\nfunction b() {}\nconst c = 1;\nexport { A, b as renamed };\nexport default c;');
            const names = Object.fromEntries(found.definitions.map(definition => [definition.name, definition.exportName]));
            expect(names).toEqual({ A: 'A', b: 'renamed', c: 'default' });
        });

        it('入れ子の定義には export 名を付けない', async () => {
            const found = await facts('export class A { m() {} }');
            expect(found.definitions.find(definition => definition.name === 'm')?.exportName).toBeNull();
        });
    });

    describe('import', () => {
        it('import の各形式を1束縛1行で取り出す', async () => {
            const found = await facts([
                'import { a, b as c } from "./named";',
                'import D from "./default";',
                'import * as ns from "./namespace";',
                'import type { T } from "./types";',
                'import "./side-effect";',
                'import x = require("./legacy");',
            ].join('\n'));
            expect(found.imports.map(entry => [entry.localName, entry.importedName, entry.exportName, entry.moduleSpec])).toEqual([
                ['a', 'a', null, './named'],
                ['c', 'b', null, './named'],
                ['D', 'default', null, './default'],
                ['ns', '*', null, './namespace'],
                ['T', 'T', null, './types'],
                ['x', '*', null, './legacy'],
                [null, null, null, './side-effect'],
            ]);
        });

        it('require を import として扱う', async () => {
            const found = await facts([
                'const fs = require("fs");',
                'const { join, resolve: r } = require("path");',
                'require("./register");',
            ].join('\n'), 'javascript');
            expect(found.imports.map(entry => [entry.localName, entry.importedName, entry.moduleSpec])).toEqual([
                ['fs', '*', 'fs'],
                ['join', 'join', 'path'],
                ['r', 'resolve', 'path'],
                [null, null, './register'],
            ]);
            // require 自体は呼び出しの参照出現にしない
            expect(occurrence(found, 'require')).toBeUndefined();
        });

        it('再エクスポートは公開名付きで取り出す', async () => {
            const found = await facts([
                'export { a } from "./a";',
                'export { b as c } from "./b";',
                'export * from "./all";',
                'export * as ns from "./ns";',
            ].join('\n'));
            expect(found.imports.map(entry => [entry.localName, entry.importedName, entry.exportName, entry.moduleSpec])).toEqual([
                [null, 'a', 'a', './a'],
                [null, 'b', 'c', './b'],
                [null, '*', '*', './all'],
                [null, '*', 'ns', './ns'],
            ]);
        });
    });

    describe('参照出現', () => {
        const source = [
            'import * as vscode from "vscode";',                 // 0
            'import { Base, helper } from "./base";',            // 1
            'export class Sample extends Base implements Marker {', // 2
            '    private position: vscode.Position | null = null;', // 3
            '    public run(helper: Target): void {',             // 4
            '        const created = new Helper();',              // 5
            '        created.execute(this.position);',            // 6
            '        this.update();',                             // 7
            '        this.count = 1;',                            // 8
            '        helper.go();',                               // 9
            '        console.log(created);',                      // 10
            '    }',                                              // 11
            '}',                                                  // 12
        ].join('\n');

        it('キャプチャ名から種類を判別し、囲む定義を付ける', async () => {
            const found = await facts(source);
            expect(occurrence(found, 'Base')).toMatchObject({ kind: RelationshipKind.inheritance, enclosingFqn: `${FILE}#Sample` });
            expect(occurrence(found, 'Marker')).toMatchObject({ kind: RelationshipKind.implementation });
            expect(occurrence(found, 'vscode', 'Position')).toMatchObject({ kind: RelationshipKind.type_reference, enclosingFqn: `${FILE}#Sample.position` });
            expect(occurrence(found, 'Target')).toMatchObject({ kind: RelationshipKind.type_reference, enclosingFqn: `${FILE}#Sample.run` });
            expect(occurrence(found, 'Helper')).toMatchObject({ kind: RelationshipKind.instantiation, enclosingFqn: `${FILE}#Sample.run.created`, line: 5 });
            expect(occurrence(found, 'created', 'execute')).toMatchObject({ kind: RelationshipKind.call, line: 6 });
        });

        it('同じ識別子を捉えた複数のパターンから最も具体的な種類を残す', async () => {
            const found = await facts(source);
            // this.update() は呼び出しとメンバ読み取りの両方に一致するが、呼び出しだけが残る
            const update = found.occurrences.filter(entry => entry.memberPath === 'update');
            expect(update).toHaveLength(1);
            expect(update[0]).toMatchObject({ rootName: 'this', kind: RelationshipKind.call, scopeId: null });
            // this.count = 1 は書き込み
            expect(found.occurrences.filter(entry => entry.memberPath === 'count').map(entry => entry.kind)).toEqual([RelationshipKind.write]);
            // this.position は引数として渡されるメンバ読み取り
            expect(occurrence(found, 'this', 'position')).toMatchObject({ kind: RelationshipKind.read });
        });

        it('定義名・import 名は参照出現にしない', async () => {
            const found = await facts(source);
            expect(found.occurrences.some(entry => entry.rootName === 'Sample')).toBe(false);
            expect(found.occurrences.filter(entry => entry.rootName === 'Base').map(entry => entry.line)).toEqual([2]);
        });

        it('根の名前を束縛しているスコープを求める', async () => {
            const found = await facts(source);
            // import はモジュールスコープ
            expect(occurrence(found, 'Base')?.scopeId).toBe(0);
            expect(occurrence(found, 'vscode', 'Position')?.scopeId).toBe(0);
            // 引数 helper は同名の import を隠す (ローカルスコープ)
            const shadowed = occurrence(found, 'helper', 'go');
            expect(shadowed?.scopeId).not.toBeNull();
            expect(shadowed?.scopeId).toBeGreaterThan(0);
            // ローカル変数
            expect(occurrence(found, 'created', 'execute')?.scopeId).toBeGreaterThan(0);
            // ファイル内に束縛の無い名前 (グローバル・組込み・未解決の型)
            expect(occurrence(found, 'console', 'log')?.scopeId).toBeNull();
            expect(occurrence(found, 'Marker')?.scopeId).toBeNull();
            expect(occurrence(found, 'Helper')?.scopeId).toBeNull();
        });

        it('トップレベルの定義はモジュールスコープ、関数名は外側のスコープで束縛される', async () => {
            const found = await facts('function outer() { inner(); function inner() {} }\nouter();');
            const calls = found.occurrences.filter(entry => entry.kind === RelationshipKind.call);
            expect(calls.find(entry => entry.rootName === 'outer')).toMatchObject({ scopeId: 0, enclosingFqn: fileFqn(FILE) });
            const inner = calls.find(entry => entry.rootName === 'inner');
            expect(inner?.enclosingFqn).toBe(`${FILE}#outer`);
            expect(inner?.scopeId).toBeGreaterThan(0);
        });

        it('型引数は型参照の束縛になる', async () => {
            const found = await facts('class Box<T> { value: T; map<U>(f: (v: T) => U): U { return f(this.value); } }');
            const typeReferences = found.occurrences.filter(entry => entry.kind === RelationshipKind.type_reference);
            expect(typeReferences.length).toBeGreaterThan(0);
            expect(typeReferences.every(entry => entry.scopeId !== null && entry.scopeId > 0)).toBe(true);
        });

        it('JavaScript でも参照出現を取り出せる', async () => {
            const found = await facts('class A extends B { m() { new C(); this.n(); } }', 'javascript');
            expect(occurrence(found, 'B')?.kind).toBe(RelationshipKind.inheritance);
            expect(occurrence(found, 'C')).toMatchObject({ kind: RelationshipKind.instantiation, enclosingFqn: `${FILE}#A.m` });
            expect(occurrence(found, 'this', 'n')?.kind).toBe(RelationshipKind.call);
        });
    });

    describe('構文エラー', () => {
        it('構文エラーを含んでも抽出し、その旨を返す', async () => {
            const found = await facts('class A { m() { new B(); } \nclass {{{');
            expect(found.hasError).toBe(true);
            expect(occurrence(found, 'B')?.kind).toBe(RelationshipKind.instantiation);
        });

        it('未対応の language id は null を返す', async () => {
            expect(await collectLocalFacts(parser, 'rust', 'a.rs', 'fn main() {}')).toBeNull();
        });
    });
});
