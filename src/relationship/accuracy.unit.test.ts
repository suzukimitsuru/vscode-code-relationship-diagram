/** @file 名前解決の精度検証の突き合わせの単体テスト */
import { describe, expect, it } from 'vitest';
import { RelationshipKind } from '../extruct/ast/relationshipKind';
import { AccuracySymbol, compareRelationships, normalizeFqn } from './accuracy';
import { RelationshipV2 } from './resolve';

/** a.ts と b.ts のシンボル (b.ts の callback は解決キーを持たない) */
const SYMBOLS: AccuracySymbol[] = [
    { id: 'a', parentId: null, path: 'a.ts', fqn: 'a.ts#' },
    { id: 'a/A', parentId: 'a', path: 'a.ts', fqn: 'a.ts#A' },
    { id: 'a/A.m', parentId: 'a/A', path: 'a.ts', fqn: 'a.ts#A.m' },
    { id: 'b', parentId: null, path: 'b.ts', fqn: 'b.ts#' },
    { id: 'b/f', parentId: 'b', path: 'b.ts', fqn: 'b.ts#f' },
    { id: 'b/f/callback', parentId: 'b/f', path: 'b.ts', fqn: null },
    { id: 'b/C', parentId: 'b', path: 'b.ts', fqn: 'b.ts#C' },
    { id: 'b/C.run', parentId: 'b/C', path: 'b.ts', fqn: 'b.ts#C.run' },
];

const ast = (referenceFqn: string, defineFqn: string, kind: RelationshipKind = RelationshipKind.call): RelationshipV2 => ({
    referencePath: referenceFqn.slice(0, referenceFqn.indexOf('#')), referenceFqn: referenceFqn,
    definePath: defineFqn.slice(0, defineFqn.indexOf('#')), defineFqn: defineFqn,
    kind: kind, weight: 1, confidence: 1, referenceLine: 0, isIntraFile: false,
});

describe('normalizeFqn', () => {
    const attached = new Set(SYMBOLS.map(symbol => symbol.fqn).filter((fqn): fqn is string => fqn !== null));

    it('シンボルに付いた完全修飾名はそのまま', () => {
        expect(normalizeFqn('a.ts#A.m', attached)).toBe('a.ts#A.m');
    });

    it('シンボルの無い定義は、シンボルのある最も近い祖先へ揃える', () => {
        expect(normalizeFqn('a.ts#A.m.local', attached)).toBe('a.ts#A.m');
        expect(normalizeFqn('a.ts#A.x~2', attached)).toBe('a.ts#A');
        expect(normalizeFqn('a.ts#Unknown', attached)).toBe('a.ts#');
        expect(normalizeFqn('c.ts#X', attached)).toBe('c.ts#');
    });

    it('パスに . や # を含んでも名前の部分だけを辿る', () => {
        expect(normalizeFqn('dir.v1/a#b.ts#A.m.x', new Set(['dir.v1/a#b.ts#A']))).toBe('dir.v1/a#b.ts#A');
    });
});

describe('compareRelationships', () => {
    it('import 由来の関係 (定義がトップレベル) の再現率を数え、取りこぼしを返す', () => {
        const report = compareRelationships(SYMBOLS,
            [
                { referenceId: 'b/f/callback', defineId: 'a/A' },    // コールバックの中 → b.ts#f として比べる
                { referenceId: 'b/C.run', defineId: 'a/A' },
                { referenceId: 'b/C.run', defineId: 'a/A.m' },       // メンバの参照 (import 由来ではない)
            ],
            [
                ast('b.ts#f', 'a.ts#A', RelationshipKind.instantiation),
                ast('b.ts#C.run.local', 'a.ts#A.m'),                  // ローカル変数の定義 → b.ts#C.run として比べる
                ast('b.ts#', 'a.ts#A', RelationshipKind.import),      // import 関係はシンボル単位の比較から除く
            ]);
        expect(report.importDerived).toEqual({ matched: 1, total: 2, ratio: 0.5 });
        expect(report.missedImportDerived).toEqual([['b.ts#C.run', 'a.ts#A']]);
        expect(report.symbolRecall).toEqual({ matched: 2, total: 3, ratio: 2 / 3 });
        expect(report.symbolPrecision).toEqual({ matched: 2, total: 2, ratio: 1 });
        expect(report.fileRecall).toEqual({ matched: 1, total: 1, ratio: 1 });
        expect(report.filePrecision).toEqual({ matched: 1, total: 1, ratio: 1 });
        expect(report.lspOnlyFiles).toEqual([]);
        expect(report.astOnlyFiles).toEqual([]);
    });

    it('確信度の閾値ごとの再現率・適合率と、帯ごとの適合率を数える', () => {
        const withConfidence = (relationship: RelationshipV2, confidence: number): RelationshipV2 => ({ ...relationship, confidence });
        const report = compareRelationships(SYMBOLS,
            [{ referenceId: 'b/f', defineId: 'a/A' }, { referenceId: 'b/C.run', defineId: 'a/A.m' }],
            [
                withConfidence(ast('b.ts#f', 'a.ts#A'), 0.95),         // 段2: LSP にもある
                withConfidence(ast('b.ts#C.run', 'a.ts#A.m'), 0.8),    // 段3: LSP にもある
                withConfidence(ast('b.ts#C', 'a.ts#A'), 0.6),          // 段4: LSP に無い
            ]);
        const at = (threshold: number) => report.byThreshold.find(entry => entry.threshold === threshold);
        expect(at(0)).toMatchObject({ recall: { matched: 2, total: 2 }, precision: { matched: 2, total: 3 } });
        expect(at(0.7)).toMatchObject({ recall: { matched: 2, total: 2 }, precision: { matched: 2, total: 2 } });
        expect(at(0.9)).toMatchObject({ recall: { matched: 1, total: 2 }, precision: { matched: 1, total: 1 } });
        expect(report.byBand.map(band => [band.precision.matched, band.precision.total])).toEqual([[0, 0], [1, 1], [1, 1], [0, 1], [0, 0]]);
    });

    it('片方だけが見つけたファイルの組を返す (AST 側は関係の種類も)', () => {
        const report = compareRelationships(SYMBOLS, [{ referenceId: 'b/f', defineId: 'a/A' }],
            [ast('a.ts#', 'b.ts#C', RelationshipKind.import), ast('a.ts#A.m', 'b.ts#C')]);
        expect(report.lspOnlyFiles).toEqual([['b.ts', 'a.ts']]);
        expect(report.astOnlyFiles).toEqual([['a.ts', 'b.ts', [RelationshipKind.import, RelationshipKind.call]]]);
    });

    it('同じファイル内の関係は比べない (LSP は記録しない)', () => {
        const report = compareRelationships(SYMBOLS, [], [ast('b.ts#f', 'b.ts#C')]);
        expect(report.symbolPrecision.total).toBe(0);
        expect(report.filePrecision.total).toBe(0);
    });

    it('定義側が名前付きの宣言でない関係 (オブジェクトリテラルのメンバ等) は構造的な参照として比較から除く', () => {
        const report = compareRelationships(SYMBOLS,
            [{ referenceId: 'a/A.m', defineId: 'b/f/callback' }, { referenceId: 'a/A.m', defineId: 'b/C' }],
            [ast('a.ts#A.m', 'b.ts#C')]);
        expect(report.structuralLsp).toBe(1);
        expect(report.importDerived).toEqual({ matched: 1, total: 1, ratio: 1 });
        expect(report.fileRecall).toEqual({ matched: 1, total: 1, ratio: 1 });
    });

    it('オブジェクトリテラルのキーとしてだけ現れる名前の関係は、文脈による参照として比較から除く', () => {
        const occurrence = (enclosingFqn: string, kind: RelationshipKind, rootName: string, memberPath: string | null = null) =>
            ({ enclosingFqn, kind, rootName, memberPath });
        const report = compareRelationships(SYMBOLS,
            [{ referenceId: 'a/A.m', defineId: 'b/C.run' }, { referenceId: 'a/A', defineId: 'b/C.run' }],
            [],
            [
                occurrence('a.ts#A.m', RelationshipKind.object_key, 'run'),            // { run: … } だけ → 除く
                occurrence('a.ts#A', RelationshipKind.object_key, 'run'),
                occurrence('a.ts#A', RelationshipKind.call, 'c', 'run'),                // c.run() もある → 残す
            ]);
        expect(report.contextualLsp).toBe(1);
        expect(report.symbolRecall.total).toBe(1);
    });

    it('省略記法のキー { run } は変数の読み取りでもあるが、メンバの定義に対しては文脈による参照として除く', () => {
        const occurrence = (enclosingFqn: string, kind: RelationshipKind, rootName: string) =>
            ({ enclosingFqn, kind, rootName, memberPath: null });
        const report = compareRelationships(SYMBOLS,
            [{ referenceId: 'a/A.m', defineId: 'b/C.run' }, { referenceId: 'a/A.m', defineId: 'b/f' }],
            [],
            [
                occurrence('a.ts#A.m', RelationshipKind.object_key, 'run'),     // { run } → C.run は除く
                occurrence('a.ts#A.m', RelationshipKind.read, 'run'),
                occurrence('a.ts#A.m', RelationshipKind.object_key, 'f'),       // { f } → トップレベルの f は変数 f の参照として残す
                occurrence('a.ts#A.m', RelationshipKind.read, 'f'),
            ]);
        expect(report.contextualLsp).toBe(1);
        expect(report.symbolRecall.total).toBe(1);
    });

    it('解決キーに辿り着けないシンボルの関係は比較から除いて数える', () => {
        const report = compareRelationships([{ id: 'x', parentId: null, path: 'x.c', fqn: null }, ...SYMBOLS],
            [{ referenceId: 'x', defineId: 'a/A' }], []);
        expect(report.unmappedLsp).toBe(1);
        expect(report.importDerived.total).toBe(0);
    });
});
