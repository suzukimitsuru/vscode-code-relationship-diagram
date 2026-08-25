import { describe, it, expect } from 'vitest';
import {
    generateCommunityColors,
    detectCommunities,
    generateCiseClusters,
    CommunityNode,
    CommunityEdge,
} from './communityDetection';

describe('generateCommunityColors', () => {
    it('要求した数だけ色を割り当てる', () => {
        const colors = generateCommunityColors(3);
        expect(colors.size).toBe(3);
        expect(colors.get(0)).toBeDefined();
        expect(colors.get(2)).toBeDefined();
    });

    it('パレットのサイズを超えると色を循環させる', () => {
        const colors = generateCommunityColors(21);
        expect(colors.get(0)).toBe(colors.get(20));
    });
});

describe('detectCommunities', () => {
    it('孤立した2つのクラスタを別コミュニティとして検出する（決定的なオプション使用）', () => {
        const nodes: CommunityNode[] = [
            { id: 'a1', label: 'a1' }, { id: 'a2', label: 'a2' }, { id: 'a3', label: 'a3' },
            { id: 'b1', label: 'b1' }, { id: 'b2', label: 'b2' }, { id: 'b3', label: 'b3' },
        ];
        const edges: CommunityEdge[] = [
            { source: 'a1', target: 'a2' }, { source: 'a2', target: 'a3' }, { source: 'a1', target: 'a3' },
            { source: 'b1', target: 'b2' }, { source: 'b2', target: 'b3' }, { source: 'b1', target: 'b3' },
        ];

        const result = detectCommunities(nodes, edges, { randomWalk: false });

        expect(result.communities.get('a1')).toBe(result.communities.get('a2'));
        expect(result.communities.get('a1')).toBe(result.communities.get('a3'));
        expect(result.communities.get('b1')).toBe(result.communities.get('b2'));
        expect(result.communities.get('a1')).not.toBe(result.communities.get('b1'));
        expect(result.communityCount).toBe(2);
        expect(result.communitySizes.get(result.communities.get('a1')!)).toBe(3);
    });

    it('存在しないノードを参照するエッジは無視される', () => {
        const nodes: CommunityNode[] = [{ id: 'a', label: 'a' }];
        const edges: CommunityEdge[] = [{ source: 'a', target: 'missing' }];
        const result = detectCommunities(nodes, edges, { randomWalk: false });
        expect(result.communities.get('a')).toBeDefined();
        expect(result.communityCount).toBe(1);
    });
});

describe('generateCiseClusters', () => {
    it('コミュニティIDごとにノードIDをグループ化し、ID昇順で返す', () => {
        const communities = new Map<string, number>([
            ['n1', 1], ['n2', 0], ['n3', 1], ['n4', 0],
        ]);
        const clusters = generateCiseClusters(communities);
        expect(clusters).toEqual([
            ['n2', 'n4'],
            ['n1', 'n3'],
        ]);
    });
});
