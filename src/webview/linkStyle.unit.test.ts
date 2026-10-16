/** @file 関係の線の見た目 (種類の色・強さの太さ・閾値) の単体テスト */
import { describe, expect, it } from 'vitest';
import { RelationshipKind } from '../extruct/ast/relationshipKind';
import {
    CIRCULAR_LINK_COLOR, DEFAULT_LINK_COLOR, LINK_KIND_STYLES, addStrengths, dominantKindOf, linkColorOf, linkWidthOf, rgbaOf,
    strengthOf, strengthThresholdOf,
} from './linkStyle';

describe('linkStyle', () => {
    it('種類ごとに別の色を持ち、循環参照の赤とも重ならない (object_key は図に出さない)', () => {
        const colors = LINK_KIND_STYLES.map(style => style.color);
        expect(new Set(colors).size).toBe(colors.length);
        expect(colors).not.toContain(CIRCULAR_LINK_COLOR);
        expect(LINK_KIND_STYLES.map(style => style.kind)).not.toContain(RelationshipKind.object_key);
        // 受け入れ基準: 継承と import が区別できる
        expect(linkColorOf(RelationshipKind.inheritance)).not.toBe(linkColorOf(RelationshipKind.import));
        expect(linkColorOf(null)).toBe(DEFAULT_LINK_COLOR);
    });

    it('強さを種類ごとに足し合わせる', () => {
        const total = addStrengths({ [RelationshipKind.call]: 3 }, { [RelationshipKind.call]: 2.85, [RelationshipKind.read]: 1 });
        expect(total).toEqual({ [RelationshipKind.call]: 5.85, [RelationshipKind.read]: 1 });
    });

    it('表示する種類だけの強さと、最も強い種類', () => {
        const strengths = { [RelationshipKind.import]: 1, [RelationshipKind.call]: 6, [RelationshipKind.inheritance]: 9.5 };
        expect(strengthOf(strengths)).toBe(16.5);
        expect(dominantKindOf(strengths)).toBe(RelationshipKind.inheritance);
        const withoutInheritance = new Set([RelationshipKind.import, RelationshipKind.call]);
        expect(strengthOf(strengths, withoutInheritance)).toBe(7);
        expect(dominantKindOf(strengths, withoutInheritance)).toBe(RelationshipKind.call);
        expect(dominantKindOf(strengths, new Set([RelationshipKind.write]))).toBeNull();
    });

    it('同じ強さなら表示順の先 (構造の強い種類) を選ぶ', () => {
        expect(dominantKindOf({ [RelationshipKind.read]: 2, [RelationshipKind.type_reference]: 2 })).toBe(RelationshipKind.type_reference);
    });

    it('太さは強さの対数で、上限がある', () => {
        expect(linkWidthOf(0)).toBe(1);
        expect(linkWidthOf(1)).toBeCloseTo(2.5);
        expect(linkWidthOf(10)).toBeGreaterThan(linkWidthOf(3));
        expect(linkWidthOf(100000)).toBe(10);
    });

    it('閾値は下位の割合で決める (90 なら上位 10% を残す)', () => {
        const strengths = Array.from({ length: 100 }, (_, index) => index + 1);
        expect(strengthThresholdOf(strengths, 0)).toBe(0);
        expect(strengthThresholdOf(strengths, 90)).toBe(91);
        expect(strengths.filter(value => value >= strengthThresholdOf(strengths, 90))).toHaveLength(10);
        expect(strengthThresholdOf([], 50)).toBe(0);
        expect(strengthThresholdOf([5, 1, 3], 100)).toBe(5);
    });

    it('16進数の色を RGBA にする', () => {
        expect(rgbaOf(0xFF8000, 0.5)).toEqual([1, 128 / 255, 0, 0.5]);
    });
});
