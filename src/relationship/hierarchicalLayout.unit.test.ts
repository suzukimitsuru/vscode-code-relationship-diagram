import { describe, it, expect } from 'vitest';
import {
    calculateHierarchicalLayout,
    applyForceLayout,
    filterByDirectory,
    getRelatedNodes,
    calculateBoundingBox,
} from './hierarchicalLayout';
import { CosmosData, CosmosNode, CosmosLink } from './cosmosAdapter';

function makeNode(overrides: Partial<CosmosNode> & { id: string }): CosmosNode {
    return {
        x: 0, y: 0, size: 10, color: 0, parentId: null, level: 'file',
        label: overrides.id, path: overrides.id, kind: 0, childCount: 0, visible: true,
        lineCount: 0, inDegree: 0, outDegree: 0, isEntryPoint: false, isDeadCode: false,
        isCyclic: false, maintenanceScore: 0, hotspotScore: 0,
        ...overrides,
    };
}

function makeData(nodes: CosmosNode[], links: CosmosLink[] = []): CosmosData {
    const nodeIndex = new Map<string, number>();
    nodes.forEach((n, i) => nodeIndex.set(n.id, i));
    return { nodes, links, nodeIndex, directories: [], entryPoints: [], circularLinkIndices: [] };
}

describe('calculateBoundingBox', () => {
    it('空配列の場合はデフォルトの矩形を返す', () => {
        expect(calculateBoundingBox([])).toEqual({ minX: 0, minY: 0, maxX: 100, maxY: 100 });
    });

    it('ノードサイズを考慮した外接矩形を返す', () => {
        const nodes = [
            makeNode({ id: 'a', x: 0, y: 0, size: 10 }),
            makeNode({ id: 'b', x: 100, y: 50, size: 20 }),
        ];
        const box = calculateBoundingBox(nodes);
        expect(box.minX).toBe(-5);
        expect(box.minY).toBe(-5);
        expect(box.maxX).toBe(110);
        expect(box.maxY).toBe(60);
    });
});

describe('getRelatedNodes', () => {
    it('depth=1では直接リンクしたノードのみ含む', () => {
        const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c' })];
        const links: CosmosLink[] = [
            { source: 0, target: 1, width: 1, color: 0, details: [], level: 'file' },
            { source: 1, target: 2, width: 1, color: 0, details: [], level: 'file' },
        ];
        const data = makeData(nodes, links);
        const related = getRelatedNodes(data, 'a', 1);
        expect(new Set(related)).toEqual(new Set(['a', 'b']));
    });

    it('depthを増やすと間接的につながるノードも含む', () => {
        const nodes = [makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c' })];
        const links: CosmosLink[] = [
            { source: 0, target: 1, width: 1, color: 0, details: [], level: 'file' },
            { source: 1, target: 2, width: 1, color: 0, details: [], level: 'file' },
        ];
        const data = makeData(nodes, links);
        const related = getRelatedNodes(data, 'a', 2);
        expect(new Set(related)).toEqual(new Set(['a', 'b', 'c']));
    });
});

describe('filterByDirectory', () => {
    it('ディレクトリ・ファイル・シンボルの可視性を階層に沿って設定する', () => {
        const dir = makeNode({ id: 'dir:src', level: 'directory', path: 'src' });
        const file = makeNode({ id: 'file:src/a.ts', level: 'file', path: 'src/a.ts', parentId: 'dir:src' });
        const symbol = makeNode({ id: 'sym:1', level: 'symbol', parentId: 'file:src/a.ts' });
        const data = makeData([dir, file, symbol]);

        filterByDirectory(data, new Set(['src']));

        expect(dir.visible).toBe(true);
        expect(file.visible).toBe(true);
        expect(symbol.visible).toBe(true);
    });

    it('対象外ディレクトリのファイル・シンボルは非表示になる', () => {
        const dir = makeNode({ id: 'dir:other', level: 'directory', path: 'other' });
        const file = makeNode({ id: 'file:other/a.ts', level: 'file', path: 'other/a.ts', parentId: 'dir:other' });
        const symbol = makeNode({ id: 'sym:1', level: 'symbol', parentId: 'file:other/a.ts' });
        const data = makeData([dir, file, symbol]);

        filterByDirectory(data, new Set(['src']));

        expect(dir.visible).toBe(false);
        expect(file.visible).toBe(false);
        expect(symbol.visible).toBe(false);
    });
});

describe('calculateHierarchicalLayout', () => {
    it('単一ルートディレクトリはキャンバス中央に配置される', () => {
        const dir = makeNode({ id: 'dir:src', level: 'directory', path: 'src', parentId: null });
        const file = makeNode({ id: 'file:src/a.ts', level: 'file', path: 'src/a.ts', parentId: 'dir:src' });
        const data = makeData([dir, file]);

        calculateHierarchicalLayout(data, { width: 2000, height: 2000 });

        expect(dir.x).toBe(1000);
        expect(dir.y).toBe(1000);
        expect(Number.isNaN(file.x)).toBe(false);
        expect(Number.isNaN(file.y)).toBe(false);
    });

    it('親を持たないトップレベルシンボルは親ファイルの周囲に配置される', () => {
        const dir = makeNode({ id: 'dir:src', level: 'directory', path: 'src', parentId: null });
        const file = makeNode({ id: 'file:src/a.ts', level: 'file', path: 'src/a.ts', parentId: 'dir:src', size: 12 });
        const symbol = makeNode({ id: 'sym:1', level: 'symbol', parentId: 'file:src/a.ts' });
        const data = makeData([dir, file, symbol]);

        calculateHierarchicalLayout(data);

        // parentFile.size * 0.7 を半径として file.x/y からオフセットされる
        const dx = symbol.x - file.x;
        const dy = symbol.y - file.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        expect(dist).toBeCloseTo(file.size * 0.7, 5);
    });
});

describe('applyForceLayout', () => {
    it('近すぎるノードは斥力で離れる', () => {
        const a = makeNode({ id: 'a', x: 100, y: 100, size: 10 });
        const b = makeNode({ id: 'b', x: 101, y: 100, size: 10 });
        const data = makeData([a, b]);

        const distBefore = Math.abs(b.x - a.x);
        applyForceLayout(data, 20);
        const distAfter = Math.hypot(b.x - a.x, b.y - a.y);

        expect(distAfter).toBeGreaterThan(distBefore);
        expect(Number.isNaN(a.x)).toBe(false);
        expect(Number.isNaN(b.x)).toBe(false);
    });

    it('リンクしたノードは引力で理想距離に近づく', () => {
        const a = makeNode({ id: 'a', x: 0, y: 0, size: 10 });
        const b = makeNode({ id: 'b', x: 1000, y: 0, size: 10 });
        const links: CosmosLink[] = [{ source: 0, target: 1, width: 1, color: 0, details: [], level: 'file' }];
        const data = makeData([a, b], links);

        applyForceLayout(data, 50, { gravity: 0 });
        const dist = Math.hypot(b.x - a.x, b.y - a.y);

        // idealDist = (10+10)/2 + 50 = 60 に向かって縮む
        expect(dist).toBeLessThan(1000);
    });
});
