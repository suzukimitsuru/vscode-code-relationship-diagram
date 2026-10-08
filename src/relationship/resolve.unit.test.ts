/** @file Phase B: 名前解決の単体テスト (実際のパーサで抽出した複数ファイルの事実を解決する) */
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    AstDefinition, AstImport, AstOccurrence, AstParser, FactsExtractor, ModuleResolution, ModuleResolver,
    RelationshipKind, resolveAstResources,
} from '../extruct/ast';
import { CONFIDENCE, RelationshipV2, ResolutionLookup, ResolutionStats, resolveFile } from './resolve';

const WORKSPACE = path.resolve('/workspace');

/** メモリ上の複数ファイルのプロジェクト (キーはワークスペース相対パス・`/` 区切り) */
const PROJECT: Record<string, string> = {
    'src/base.ts': [
        'export class Base { static create() {} run() {} }',
        'export function helper() {}',
        'export default function main() {}',
        'export const VALUE = 1;',
    ].join('\n'),
    'src/anonymous.ts': 'export default function () {}',
    'src/lib/queue.ts': 'export class QueueProcessor {}\nexport class Item {}',
    'src/lib/index.ts': 'export * from "./queue";\nexport { helper as renamed } from "../base";',
    'src/barrel.ts': 'export * as FileDifference from "./lib/index";',
    'src/cycle/a.ts': 'export * from "./b";',
    'src/cycle/b.ts': 'export * from "./a";',
    'src/side.ts': 'export {};',
    'src/alias.ts': 'export const target = () => 1;\nexport default target;',
    'src/typed.ts': [
        'import { Base } from "./base";',
        'interface Point { x: number; run(): void }',
        'interface Data { points: Point[] }',
        'export function layout(data: Data, input: { base: Base }) {',
        '    const { points } = data;',
        '    points[0].x;',
        '    const point = data.points[1]; point.run();',
        '    const { base } = input; base.run();',
        '}',
    ].join('\n'),
    'src/main.ts': [
        'import main, { Base, helper } from "./base";',              // 0
        'import * as Barrel from "./barrel";',                         // 1
        'import { renamed, QueueProcessor } from "./lib/index";',      // 2
        'import def from "./anonymous";',                              // 3
        'import * as vscode from "vscode";',                           // 4
        'import { gone } from "./missing";',                           // 5
        'import { nothing } from "./cycle/a";',                        // 6
        'import "./side"; import aliased from "./alias";',             // 7
        'class Local extends Base {',                                  // 8
        '    m(param: number): void {',                                // 9
        '        helper(); main(); renamed(); def();',                 // 10
        '        Base.create(); Base.unknown();',                      // 11
        '        new Barrel.FileDifference.QueueProcessor();',         // 12
        '        let item: Barrel.FileDifference.Item;',               // 13
        '        new QueueProcessor(); vscode.window; gone(); nothing();', // 14
        '        this.m(param); console.log(param); top(); this.local(); aliased();', // 15
        '    }',                                                       // 16
        '    local() { this.m(1); }',                                  // 17
        '}',                                                           // 18
        'function top() { top(); }',                                   // 19
        'export { Local };',                                           // 20
    ].join('\n'),
};

describe('resolveFile', () => {
    let parser: AstParser;
    const definitions = new Map<string, AstDefinition[]>();
    const imports = new Map<string, (AstImport & ModuleResolution)[]>();
    const occurrences = new Map<string, AstOccurrence[]>();
    let relationships: RelationshipV2[];
    let stats: ResolutionStats;

    /** メモリ上の事実を引く (DB の代わり) */
    const lookup: ResolutionLookup = {
        definitions: async (file) => definitions.get(file) ?? [],
        imports: async (file) => imports.get(file) ?? [],
        occurrences: async (file) => occurrences.get(file) ?? [],
        definitionsNamed: async (name) => [...definitions.entries()]
            .flatMap(([file, entries]) => entries.filter(entry => entry.name === name).map(entry => ({ path: file, definition: entry }))),
    };
    const native = (file: string): string => file.split('/').join(path.sep);
    const fqn = (file: string, name: string): string => `${native(file)}#${name}`;
    const edgesFrom = (reference: string): string[] =>
        relationships.filter(entry => entry.referenceFqn === reference && entry.kind !== RelationshipKind.import)
            .map(entry => `${RelationshipKind[entry.kind]}:${entry.defineFqn}`);

    beforeAll(async () => {
        parser = await AstParser.create(resolveAstResources(path.resolve(process.cwd())));
        const files = new Map(Object.entries(PROJECT).map(([file, source]) => [path.resolve(WORKSPACE, file), source]));
        const extractor = new FactsExtractor(parser, new ModuleResolver(WORKSPACE, {
            fileExists: (file) => files.has(file),
            readFile: (file) => files.get(file),
        }));
        for (const [file, source] of Object.entries(PROJECT)) {
            const facts = await extractor.extract(native(file), 'typescript', source);
            definitions.set(native(file), facts?.definitions ?? []);
            imports.set(native(file), facts?.imports ?? []);
            occurrences.set(native(file), facts?.occurrences ?? []);
            if (file === 'src/main.ts') {
                const resolved = await resolveFile({ path: native(file), imports: facts?.imports ?? [], occurrences: facts?.occurrences ?? [] }, lookup);
                relationships = resolved.relationships;
                stats = resolved.stats;
            }
        }
    });

    afterAll(() => {
        parser?.dispose();
    });

    it('段2: 名前付き・default import を import 先の export へ解決する', () => {
        const m = fqn('src/main.ts', 'Local.m');
        expect(edgesFrom(fqn('src/main.ts', 'Local'))).toEqual([`inheritance:${fqn('src/base.ts', 'Base')}`]);
        expect(edgesFrom(m)).toEqual(expect.arrayContaining([
            `call:${fqn('src/base.ts', 'helper')}`,
            `call:${fqn('src/base.ts', 'main')}`,
        ]));
    });

    it('段2: メンバは入れ子の定義として引き、定義が無ければその手前で止まる', () => {
        const m = fqn('src/main.ts', 'Local.m');
        expect(edgesFrom(m)).toEqual(expect.arrayContaining([
            `call:${fqn('src/base.ts', 'Base.create')}`,
            `read:${fqn('src/base.ts', 'Base')}`,  // Base.create() は途中で Base も参照している
            `call:${fqn('src/base.ts', 'Base')}`,  // Base.unknown は定義が無いので Base
        ]));
    });

    it('段2: 名前空間 import の連鎖を export * as / export * / 名前を変えた再エクスポートを辿って解決する', () => {
        const m = fqn('src/main.ts', 'Local.m');
        expect(edgesFrom(m)).toEqual(expect.arrayContaining([
            `instantiation:${fqn('src/lib/queue.ts', 'QueueProcessor')}`,
            `call:${fqn('src/base.ts', 'helper')}`,  // renamed → base.ts の helper
        ]));
        // 型注釈は変数 item の定義の内側なので、参照元は最内の定義 Local.m.item
        expect(edgesFrom(fqn('src/main.ts', 'Local.m.item'))).toEqual([`type_reference:${fqn('src/lib/queue.ts', 'Item')}`]);
        // 名前付き import が export * の先にある定義
        expect(edgesFrom(m).filter(edge => edge === `instantiation:${fqn('src/lib/queue.ts', 'QueueProcessor')}`)).toHaveLength(2);
    });

    it('段2: 別名 export (export default <定義名>) は自ファイルの再エクスポートとして定義へ解決する', () => {
        const aliased = relationships.find(entry => entry.kind === RelationshipKind.call && entry.defineFqn === fqn('src/alias.ts', 'target'));
        expect(aliased?.confidence).toBe(CONFIDENCE.import);
    });

    it('段2: export 名の定義が見つからなければモジュール単位で解決し、確信度を下げる', () => {
        const toModule = relationships.filter(entry => entry.defineFqn === fqn('src/anonymous.ts', '') && entry.kind === RelationshipKind.call);
        expect(toModule).toHaveLength(1);
        expect(toModule[0].confidence).toBe(CONFIDENCE.module);
        // 循環する再エクスポートは深さの上限で止まり、モジュール単位になる
        expect(relationships.some(entry => entry.defineFqn === fqn('src/cycle/a.ts', '') && entry.kind === RelationshipKind.call)).toBe(true);
    });

    it('段1: ファイル内の定義へ解決し、自分自身と自分の内側への参照は関係にしない', () => {
        const m = fqn('src/main.ts', 'Local.m');
        expect(edgesFrom(m)).toContain(`call:${fqn('src/main.ts', 'top')}`);
        const local = relationships.find(entry => entry.defineFqn === fqn('src/main.ts', 'top') && entry.referenceFqn === m);
        expect(local).toMatchObject({ isIntraFile: true, confidence: CONFIDENCE.local });
        // top() の中の top() (再帰) は自分自身
        expect(edgesFrom(fqn('src/main.ts', 'top'))).toEqual([]);
        expect(stats.self).toBeGreaterThan(0);
    });

    it('import 文はファイルから取り込んだ定義・モジュールへの import 関係になる', () => {
        const importEdges = relationships.filter(entry => entry.kind === RelationshipKind.import).map(entry => entry.defineFqn);
        expect(importEdges).toEqual(expect.arrayContaining([
            fqn('src/base.ts', 'main'), fqn('src/base.ts', 'Base'), fqn('src/base.ts', 'helper'),
            fqn('src/barrel.ts', ''), fqn('src/lib/queue.ts', 'QueueProcessor'), fqn('src/side.ts', ''),
        ]));
        expect(relationships.filter(entry => entry.kind === RelationshipKind.import).every(entry => entry.referenceFqn === fqn('src/main.ts', ''))).toBe(true);
    });

    it('解決しないものは理由ごとに数える', () => {
        expect(stats.external).toBe(2);           // vscode.window と import 文
        expect(stats.unresolvedImport).toBe(2);   // gone() と import 文
        expect(stats.unbound).toBe(1);            // console.log (組込み)
        expect(stats.thisOrSuper).toBe(0);        // this のメンバは段3 で囲むクラスから引く
    });

    it('段3: this のメンバは囲むクラスから引き、再帰 (自分自身) は関係にしない', () => {
        const local = (name: string): string => fqn('src/main.ts', name);
        const inferred = relationships.filter(entry => entry.confidence === CONFIDENCE.inferred).map(entry => `${entry.referenceFqn} -> ${entry.defineFqn}`);
        expect(inferred).toEqual(expect.arrayContaining([
            `${local('Local.m')} -> ${local('Local.local')}`,
            `${local('Local.local')} -> ${local('Local.m')}`,
        ]));
        expect(inferred).not.toContain(`${local('Local.m')} -> ${local('Local.m')}`);
        expect(stats.inferred).toBe(2);
        expect(stats.self).toBeGreaterThan(0);
    });

    it('段3: 添字は配列の要素の型、分割代入は取り出し元のメンバの型として引く', async () => {
        const file = native('src/typed.ts');
        const resolved = await resolveFile({ path: file, imports: imports.get(file) ?? [], occurrences: occurrences.get(file) ?? [] }, lookup);
        const inferred = resolved.relationships.filter(entry => entry.confidence === CONFIDENCE.inferred)
            .map(entry => `${entry.referenceFqn} -> ${entry.defineFqn}`);
        const local = (name: string): string => fqn('src/typed.ts', name);
        expect(inferred).toEqual(expect.arrayContaining([
            `${local('layout')} -> ${local('Point.x')}`,                 // points[0].x (const { points } = data)
            `${local('layout')} -> ${local('Point.run')}`,               // const point = data.points[1]; point.run()
            `${local('layout')} -> ${fqn('src/base.ts', 'Base.run')}`,  // const { base } = input (型リテラルの注釈)
        ]));
        // 分割代入のキーは取り出し元のメンバの読み取り
        expect(resolved.relationships.map(entry => `${entry.referenceFqn} -> ${entry.defineFqn}`))
            .toContain(`${local('layout.points')} -> ${local('Data.points')}`);
    });

    it('重みは種類ごとの基本重み、ファイルの両端と行を記録する', () => {
        const inheritance = relationships.find(entry => entry.kind === RelationshipKind.inheritance);
        expect(inheritance).toMatchObject({
            referencePath: native('src/main.ts'), definePath: native('src/base.ts'),
            weight: 10, confidence: CONFIDENCE.import, referenceLine: 8, isIntraFile: false,
        });
    });
});
