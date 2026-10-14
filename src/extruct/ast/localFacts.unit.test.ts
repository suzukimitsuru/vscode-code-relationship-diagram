/** @file Phase A: ローカル事実抽出の単体テスト */
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AstParser } from './parser';
import { resolveAstResources } from './resources';
import { AstOccurrence, ELEMENT_MEMBER, LocalFacts, SELF_MODULE_SPEC, collectLocalFacts, fileFqn } from './localFacts';
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
    /** 構造を見るテストでは引数の定義 (Stage 3 の型推論の手掛かり) を除く */
    const fqns = (found: LocalFacts): string[] => found.definitions.filter(definition => definition.kind !== 'parameter').map(definition => definition.fqn);
    const typeOf = (found: LocalFacts, fqn: string): unknown => found.definitions.find(definition => definition.fqn === fqn)?.type;
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

        it('コンストラクタ引数のプロパティはクラスのメンバとして定義する', async () => {
            const found = await facts('class A {\n    constructor(public readonly a: X, readonly b: Y, private c?: Z, d: W) {}\n}');
            expect(fqns(found)).toEqual([`${FILE}#A`, `${FILE}#A.constructor`, `${FILE}#A.a`, `${FILE}#A.b`, `${FILE}#A.c`]);
            // 引数の型注釈の参照元はプロパティ (言語サーバのシンボルの単位と揃う)
            expect(occurrence(found, 'X')?.enclosingFqn).toBe(`${FILE}#A.a`);
            expect(occurrence(found, 'W')?.enclosingFqn).toBe(`${FILE}#A.constructor.d`);
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

        it('既に export している定義の別名 export は、自ファイルからの再エクスポートとして記録する', async () => {
            const found = await facts('export const a = 1;\nexport default a;\nexport { a as b };');
            expect(found.definitions.map(definition => [definition.name, definition.exportName])).toEqual([['a', 'a']]);
            expect(found.imports.map(entry => [entry.localName, entry.importedName, entry.exportName, entry.moduleSpec])).toEqual([
                [null, 'a', 'default', SELF_MODULE_SPEC],
                [null, 'a', 'b', SELF_MODULE_SPEC],
            ]);
        });

        it('import した名前の export は、import 先からの再エクスポートとして記録する', async () => {
            const found = await facts('import { x } from "./x";\nexport { x as y };');
            expect(found.imports.map(entry => [entry.localName, entry.importedName, entry.exportName, entry.moduleSpec])).toEqual([
                ['x', 'x', null, './x'],
                [null, 'x', 'y', './x'],
            ]);
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
            // 引数の型注釈の参照元は引数の定義 (言語サーバのシンボルが無いため、比較では外側の run に揃う)
            expect(occurrence(found, 'Target')).toMatchObject({ kind: RelationshipKind.type_reference, enclosingFqn: `${FILE}#Sample.run.helper` });
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

    describe('束縛している定義 (Stage 2)', () => {
        it('根の名前を束縛しているファイル内の定義の完全修飾名を付ける', async () => {
            const found = await facts([
                'import { helper } from "./helper";',               // 0
                'function top() {}',                                // 1
                'class Box { static create() {} }',                 // 2
                'export function run(param: number) {',             // 3
                '    function inner() {}',                          // 4
                '    top(); inner(); helper(); param.toFixed();',   // 5
                '    Box.create(); console.log(param);',            // 6
                '}',
            ].join('\n'));
            expect(occurrence(found, 'top')).toMatchObject({ scopeId: 0, bindingFqn: `${FILE}#top` });
            expect(occurrence(found, 'inner')?.bindingFqn).toBe(`${FILE}#run.inner`);
            expect(occurrence(found, 'Box', 'create')).toMatchObject({ scopeId: 0, bindingFqn: `${FILE}#Box` });
            // import・定義以外の束縛・ファイル内に束縛の無い名前は null
            expect(occurrence(found, 'helper')).toMatchObject({ scopeId: 0, bindingFqn: null });
            // 引数は定義 (Stage 3)。型推論の手掛かりにするため束縛している定義になる
            expect(occurrence(found, 'param', 'toFixed')?.bindingFqn).toBe(`${FILE}#run.param`);
            expect(occurrence(found, 'console', 'log')).toMatchObject({ scopeId: null, bindingFqn: null });
        });

        it('同じスコープで import と定義が同じ名前を束縛する時は import を優先する', async () => {
            const found = await facts('const fs = require("fs");\nfs.readFileSync("a");', 'javascript');
            expect(occurrence(found, 'fs', 'readFileSync')).toMatchObject({ scopeId: 0, bindingFqn: null });
        });
    });

    describe('型の手掛かり (Stage 3)', () => {
        it('引数・for-of の変数・コールバックの引数を定義にする', async () => {
            const found = await facts('function f(a: A, b?: B) { for (const x of xs) {} xs.map(y => y); xs.find((z) => z); }');
            expect(found.definitions.filter(definition => definition.kind === 'parameter').map(definition => definition.fqn))
                .toEqual([`${FILE}#f.a`, `${FILE}#f.b`, `${FILE}#f.y`, `${FILE}#f.z`]);
            expect(found.definitions.find(definition => definition.name === 'x')).toMatchObject({ fqn: `${FILE}#f.x`, kind: 'variable' });
        });

        it('型注釈から型名を取り出す (Promise<T> と T | null は T、配列は要素の型)', async () => {
            const found = await facts([
                'import * as ns from "./ns";',
                'let a: Foo;',
                'let b: ns.Bar | null;',
                'let c: Foo[];',
                'let d: ReadonlyArray<ns.Bar>;',
                'async function f(): Promise<Foo | undefined> { return undefined; }',
                'const g = async (): Promise<Foo> => new Foo();',
                'let h: string;',
            ].join('\n'));
            expect(typeOf(found, `${FILE}#a`)).toEqual({ mode: 'annotation', rootName: 'Foo', memberPath: null, scopeId: null, bindingFqn: null, array: false });
            expect(typeOf(found, `${FILE}#b`)).toMatchObject({ mode: 'annotation', rootName: 'ns', memberPath: 'Bar', scopeId: 0, array: false });
            expect(typeOf(found, `${FILE}#c`)).toMatchObject({ rootName: 'Foo', array: true });
            expect(typeOf(found, `${FILE}#d`)).toMatchObject({ rootName: 'ns', memberPath: 'Bar', array: true });
            expect(typeOf(found, `${FILE}#f`)).toMatchObject({ mode: 'annotation', rootName: 'Foo' });
            expect(typeOf(found, `${FILE}#g`)).toMatchObject({ mode: 'annotation', rootName: 'Foo' });
            expect(typeOf(found, `${FILE}#h`)).toBeNull();
        });

        it('初期化子から型の手掛かりを取り出す (new・呼び出し・値・as)', async () => {
            const found = await facts([
                'class C { m() {',
                '    const a = new Foo();',
                '    const b = await this.task.run();',
                '    const c = this.items;',
                '    const d = make() as Bar;',
                '} }',
            ].join('\n'));
            expect(typeOf(found, `${FILE}#C.m.a`)).toMatchObject({ mode: 'new', rootName: 'Foo', memberPath: null });
            expect(typeOf(found, `${FILE}#C.m.b`)).toMatchObject({ mode: 'call', rootName: 'this', memberPath: 'task.run', scopeId: null });
            expect(typeOf(found, `${FILE}#C.m.c`)).toMatchObject({ mode: 'value', rootName: 'this', memberPath: 'items' });
            expect(typeOf(found, `${FILE}#C.m.d`)).toMatchObject({ mode: 'annotation', rootName: 'Bar' });
        });

        it('for-of の変数と配列のメソッドに渡したコールバックの引数は、要素の型を手掛かりにする', async () => {
            const found = await facts('function f(items: Foo[]) { for (const x of items) {} items.forEach(y => y); items.sort((a, b) => 0); }');
            expect(typeOf(found, `${FILE}#f.x`)).toMatchObject({ mode: 'element', rootName: 'items', bindingFqn: `${FILE}#f.items` });
            expect(typeOf(found, `${FILE}#f.y`)).toMatchObject({ mode: 'element', rootName: 'items' });
            // sort の比較関数の引数は両方とも要素
            expect(typeOf(found, `${FILE}#f.a`)).toMatchObject({ mode: 'element', rootName: 'items' });
        });

        it('要素の型を変えない配列のメソッド・呼び出しの戻り値・要素を返すメソッドを辿る', async () => {
            const found = await facts([
                'function f(items: Foo[]) {',
                '    items.filter(a => a).slice(0).map(b => b);',
                '    (await load()).forEach(c => c);',
                '    const d = items.find(x => x);',
                '    const e = items.filter(x => x);',
                '    for (const g of this.list()) {}',
                '}',
            ].join('\n'));
            expect(typeOf(found, `${FILE}#f.b`)).toMatchObject({ mode: 'element', rootName: 'items', memberPath: null });
            expect(typeOf(found, `${FILE}#f.c`)).toMatchObject({ mode: 'element', rootName: 'load', memberPath: null });
            expect(typeOf(found, `${FILE}#f.d`)).toMatchObject({ mode: 'element', rootName: 'items' });
            expect(typeOf(found, `${FILE}#f.e`)).toMatchObject({ mode: 'value', rootName: 'items' });
            expect(typeOf(found, `${FILE}#f.g`)).toMatchObject({ mode: 'element', rootName: 'this', memberPath: 'list' });
        });

        it('sort / reduce / then のコールバックの引数と、連鎖した代入の右辺を辿る', async () => {
            const found = await facts([
                'function f(xs: Foo[]) {',
                '    xs.sort((a, b) => 0);',
                '    xs.reduce((acc, x) => acc, 0);',
                '    load().then(v => v);',
                '    const w = cache = new Foo();',
                '}',
            ].join('\n'));
            expect(typeOf(found, `${FILE}#f.a`)).toMatchObject({ mode: 'element', rootName: 'xs' });
            expect(typeOf(found, `${FILE}#f.b`)).toMatchObject({ mode: 'element', rootName: 'xs' });
            expect(typeOf(found, `${FILE}#f.acc`)).toBeNull();
            expect(typeOf(found, `${FILE}#f.x`)).toMatchObject({ mode: 'element', rootName: 'xs' });
            expect(typeOf(found, `${FILE}#f.v`)).toMatchObject({ mode: 'value', rootName: 'load' });
            expect(typeOf(found, `${FILE}#f.w`)).toMatchObject({ mode: 'new', rootName: 'Foo' });
        });

        it('添字で取り出した要素は、配列の値の要素を手掛かりにする', async () => {
            const found = await facts('function f(data: Data) { const node = data.nodes[i]; for (const x of rows[0]) {} }');
            expect(typeOf(found, `${FILE}#f.node`)).toMatchObject({ mode: 'value', rootName: 'data', memberPath: `nodes.${ELEMENT_MEMBER}` });
            expect(typeOf(found, `${FILE}#f.x`)).toMatchObject({ mode: 'element', rootName: 'rows', memberPath: ELEMENT_MEMBER });
        });

        it('分割代入で取り出した変数・引数は、取り出し元のメンバを手掛かりにし、キーを読み取りにする', async () => {
            const found = await facts([
                'function f(data: Data, { size }: Options, { name }: { name: Label }) {',
                '    const { nodes, links: edges = [] } = data;',
                '    const { a } = this.store;',
                '}',
            ].join('\n'));
            expect(typeOf(found, `${FILE}#f.nodes`)).toMatchObject({ mode: 'value', rootName: 'data', memberPath: 'nodes', bindingFqn: `${FILE}#f.data` });
            expect(typeOf(found, `${FILE}#f.edges`)).toMatchObject({ mode: 'value', rootName: 'data', memberPath: 'links' });
            expect(typeOf(found, `${FILE}#f.a`)).toMatchObject({ mode: 'value', rootName: 'this', memberPath: 'store.a' });
            // 型注釈の分割代入は型のメンバ、型リテラルの注釈はそのメンバの型
            expect(typeOf(found, `${FILE}#f.size`)).toMatchObject({ mode: 'value', rootName: 'Options', memberPath: 'size' });
            expect(typeOf(found, `${FILE}#f.name`)).toMatchObject({ mode: 'annotation', rootName: 'Label', memberPath: null });
            // キーは取り出し元のメンバの読み取り (省略記法は変数自身が囲む定義になる)
            expect(occurrence(found, 'data', 'nodes')).toMatchObject({ kind: RelationshipKind.read, enclosingFqn: `${FILE}#f.nodes`, line: 1 });
            expect(occurrence(found, 'data', 'links')).toMatchObject({ kind: RelationshipKind.read, enclosingFqn: `${FILE}#f` });
            expect(occurrence(found, 'Options', 'size')?.kind).toBe(RelationshipKind.read);
            // 変数自身は参照出現にしない
            expect(occurrence(found, 'nodes')).toBeUndefined();
        });

        it('require の分割代入は import 束縛のままにし、定義にしない', async () => {
            const found = await facts('const { readFile } = require("fs");', 'javascript');
            expect(found.definitions.map(definition => definition.name)).not.toContain('readFile');
            expect(found.imports).toEqual([expect.objectContaining({ localName: 'readFile', importedName: 'readFile', moduleSpec: 'fs' })]);
        });

        it('引数の型注釈に書いた型リテラルのメンバは、引数の入れ子の定義にする', async () => {
            const found = await facts('function f(input: { report: Report }) { const { report } = input; }');
            expect(typeOf(found, `${FILE}#f.input.report`)).toMatchObject({ mode: 'annotation', rootName: 'Report' });
            expect(typeOf(found, `${FILE}#f.report`)).toMatchObject({ mode: 'value', rootName: 'input', memberPath: 'report' });
        });

        it('Map<K, V> は値 V の配列として扱い、get() と ?? の左辺を辿る', async () => {
            const found = await facts('function f(m: Map<string, Foo>, xs: X[]) { const a = m.get("k"); const b = (await g()) ?? []; }');
            expect(typeOf(found, `${FILE}#f.m`)).toMatchObject({ mode: 'annotation', rootName: 'Foo', array: true });
            expect(typeOf(found, `${FILE}#f.a`)).toMatchObject({ mode: 'element', rootName: 'm' });
            expect(typeOf(found, `${FILE}#f.b`)).toMatchObject({ mode: 'call', rootName: 'g' });
        });
    });

    describe('メンバ参照の連鎖 (Stage 2)', () => {
        it('A.B.C を根 A と経路 B.C にまとめる', async () => {
            const found = await facts([
                'import * as Relationship from "./relationship";',
                'const queue = new Relationship.FileDifference.QueueProcessor();',
                'let item: Relationship.FileDifference.Item;',
                'Relationship.FileDifference.scan();',
            ].join('\n'));
            expect(occurrence(found, 'Relationship', 'FileDifference.QueueProcessor')).toMatchObject({ kind: RelationshipKind.instantiation, scopeId: 0 });
            expect(occurrence(found, 'Relationship', 'FileDifference.Item')?.kind).toBe(RelationshipKind.type_reference);
            expect(occurrence(found, 'Relationship', 'FileDifference.scan')?.kind).toBe(RelationshipKind.call);
            // 連鎖の内側 (Relationship / Relationship.FileDifference) を別の参照出現にしない
            expect(found.occurrences.filter(entry => entry.rootName === 'Relationship')).toHaveLength(3);
        });

        it('this をレシーバとする連鎖も根を this にする', async () => {
            const found = await facts('class A { m() { this.db.query(); } }');
            expect(occurrence(found, 'this', 'db.query')).toMatchObject({ kind: RelationshipKind.call, scopeId: null });
            expect(found.occurrences).toHaveLength(1);
        });

        it('途中に呼び出しを含む連鎖は根が定まらないため参照出現にしない', async () => {
            const found = await facts('make().run(); make().x = 1;');
            expect(found.occurrences.map(entry => `${entry.rootName}:${entry.memberPath}`)).toEqual(['make:null', 'make:null']);
        });

        it('添字は要素 [] (文字列の添字は同名のメンバ) として連鎖に含める (Stage 3)', async () => {
            const found = await facts('list[i].go(); a.b[0].c = 1; m["key"].run(); m["a-b"].x;');
            expect(found.occurrences.map(entry => `${entry.rootName}:${entry.memberPath}`)).toEqual([
                'i:null', 'list:[].go', 'a:b.[].c', 'm:key.run', 'm:[].x',
            ]);
            expect(occurrence(found, 'list', `${ELEMENT_MEMBER}.go`)?.kind).toBe(RelationshipKind.call);
            expect(occurrence(found, 'a', `b.${ELEMENT_MEMBER}.c`)?.kind).toBe(RelationshipKind.write);
        });
    });

    describe('値として現れる識別子 (Stage 2)', () => {
        it('二項演算・三項演算・条件など式中の識別子も読み取りとして捉える', async () => {
            const found = await facts([
                'import { Cancelled, A, B } from "./errors";',
                'function f(e: unknown, flag: boolean) {',
                '    if (e instanceof Cancelled) { return flag ? A : B; }',
                '}',
            ].join('\n'));
            for (const name of ['Cancelled', 'A', 'B']) {
                expect(occurrence(found, name), name).toMatchObject({ kind: RelationshipKind.read, scopeId: 0 });
            }
        });

        it('呼び出し・継承などのより具体的な種類が読み取りより優先される', async () => {
            const found = await facts('import { f, Base } from "./m";\nclass A extends Base { m() { f(); } }');
            expect(found.occurrences.map(entry => [entry.rootName, entry.kind])).toEqual([
                ['Base', RelationshipKind.inheritance],
                ['f', RelationshipKind.call],
            ]);
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
