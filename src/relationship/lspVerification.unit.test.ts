/** @file 低確信度の関係の LSP による確定の単体テスト */
import { describe, expect, it } from 'vitest';
import { RelationshipKind } from '../extruct/ast/relationshipKind';
import { DefinitionLocation, LspVerifier, VerificationDb, lastNameOf, locateName } from './lspVerification';
import { CONFIDENCE, RelationshipV2 } from './resolve';

describe('lastNameOf', () => {
    it('完全修飾名の最後の名前 (同名の兄弟の番号を除く)', () => {
        expect(lastNameOf('src/a.ts#A.run')).toBe('run');
        expect(lastNameOf('src/a.ts#helper~2')).toBe('helper');
        expect(lastNameOf('dir.v1/a.ts#B')).toBe('B');
    });
});

describe('locateName', () => {
    const source = 'const a = 1;\nvalue\n    .items[0]\n    .run($x);\nrun();\n';

    it('参照出現の開始から、名前の最初の出現を探す (改行をまたぐメンバの連鎖)', () => {
        expect(locateName(source, 1, 0, 'value')).toEqual({ line: 1, character: 0 });
        expect(locateName(source, 1, 0, 'run')).toEqual({ line: 3, character: 5 });
        expect(locateName(source, 4, 0, 'run')).toEqual({ line: 4, character: 0 });
    });

    it('識別子の一部には一致しない ($ を含む名前も扱う)', () => {
        expect(locateName('items item', 0, 0, 'item')).toEqual({ line: 0, character: 6 });
        expect(locateName('a.$x', 0, 0, '$x')).toEqual({ line: 0, character: 2 });
    });

    it('見つからない・行が無いなら null', () => {
        expect(locateName(source, 0, 0, 'missing')).toBeNull();
        expect(locateName(source, 99, 0, 'run')).toBeNull();
    });
});

describe('LspVerifier', () => {
    // a.ts の2行目 `  value.run();` の value (段4: メンバ名 run の候補が b.ts と c.ts の2つ)
    const weak = (definePath: string, confidence: number = CONFIDENCE.ambiguous / 2): RelationshipV2 => ({
        referencePath: 'a.ts', referenceFqn: 'a.ts#f', definePath: definePath, defineFqn: `${definePath}#C.run`,
        kind: RelationshipKind.call, weight: 5, confidence: confidence, referenceLine: 1, referenceCharacter: 2, isIntraFile: false,
    });
    const SOURCE = 'function f(value) {\n  value.run();\n}\n';
    /** 定義の位置 → 完全修飾名 (b.ts と c.ts の run は 3 行目 4 桁目、d.ts は 0 行目) */
    const DEFINITIONS: Record<string, string> = { 'b.ts:3:4': 'b.ts#C.run', 'c.ts:3:4': 'c.ts#C.run', 'd.ts:0:0': 'd.ts#run' };

    const verifierOf = (rows: RelationshipV2[], answer: DefinitionLocation[] | null) => {
        const asked: string[] = [];
        const db: VerificationDb = {
            relationships_v2_queryUncertain: async (_paths, threshold) => rows.filter(row => row.confidence < threshold),
            relationships_v2_confirm: async () => {},
            definitions_queryAt: async (path, line, character) => DEFINITIONS[`${path}:${line}:${character}`] ?? null,
        };
        const verifier = new LspVerifier(db, async (path, line, character) => {
            asked.push(`${path}:${line}:${character}`);
            return answer;
        }, async () => SOURCE);
        return { verifier, asked };
    };

    it('候補のどれかが定義なら、それだけを確定した確信度で残す', async () => {
        const rows = [weak('b.ts'), weak('c.ts')];
        const { verifier, asked } = verifierOf(rows, [{ path: 'c.ts', line: 3, character: 4 }]);
        const result = await verifier.verify(['a.ts'], 0.7);
        // 位置ごと・名前ごとに1回だけ問い合わせる。位置はメンバ run の位置
        expect(asked).toEqual(['a.ts:1:8']);
        expect(result.removes).toEqual(rows);
        expect(result.inserts).toEqual([{ ...weak('c.ts'), confidence: CONFIDENCE.confirmed }]);
        expect(result.stats).toMatchObject({ queried: 1, confirmed: 1, replaced: 0, dropped: 0 });
    });

    it('候補に無い定義が返れば、その定義へ置き換える', async () => {
        const { verifier } = verifierOf([weak('b.ts')], [{ path: 'd.ts', line: 0, character: 0 }]);
        const result = await verifier.verify(['a.ts'], 0.7);
        expect(result.inserts).toEqual([{ ...weak('b.ts'), definePath: 'd.ts', defineFqn: 'd.ts#run', confidence: CONFIDENCE.confirmed }]);
        expect(result.stats.replaced).toBe(1);
    });

    it('定義がプロジェクトの外 (組込み・パッケージ) なら候補を全て消す', async () => {
        const { verifier } = verifierOf([weak('b.ts')], [{ path: null, line: 10, character: 2 }]);
        const result = await verifier.verify(['a.ts'], 0.7);
        expect(result.removes).toHaveLength(1);
        expect(result.inserts).toEqual([]);
        expect(result.stats.dropped).toBe(1);
    });

    it('言語サーバが答えなければ、関係はそのまま残す', async () => {
        for (const answer of [null, []]) {
            const { verifier } = verifierOf([weak('b.ts')], answer);
            const result = await verifier.verify(['a.ts'], 0.7);
            expect(result).toMatchObject({ removes: [], inserts: [] });
            expect(result.stats.unanswered).toBe(1);
        }
    });

    it('閾値以上の関係・モジュール単位の関係は問い合わせない', async () => {
        const module = { ...weak('b.ts', CONFIDENCE.module), defineFqn: 'b.ts#' };
        const { verifier, asked } = verifierOf([weak('b.ts', CONFIDENCE.inferred), module], [{ path: 'b.ts', line: 3, character: 4 }]);
        const result = await verifier.verify(['a.ts'], 0.7);
        expect(asked).toEqual([]);
        expect(result).toMatchObject({ removes: [], inserts: [] });
    });

    it('自分自身・自分の内側の定義へは置き換えない', async () => {
        const { verifier } = verifierOf([{ ...weak('b.ts'), referenceFqn: 'd.ts#run', referencePath: 'd.ts' }], [{ path: 'd.ts', line: 0, character: 0 }]);
        const result = await verifier.verify(['d.ts'], 0.7);
        expect(result.removes).toHaveLength(1);
        expect(result.inserts).toEqual([]);
    });
});
