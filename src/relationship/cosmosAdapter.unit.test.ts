import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import * as SYMBOL from '../extruct/symbol';
import * as codeRelationships from './codeRelationships';
import {
    convertToCosmosFormat,
    getPositionsAsFloat32Array,
    getLinksAsUint32Array,
    getSizesAsFloat32Array,
    getColorsAsFloat32Array,
    CosmosNode,
    CosmosLink,
} from './cosmosAdapter';
import { RelationshipKind } from '../extruct/ast/relationshipKind';
import { linkColorOf, linkWidthOf } from '../webview/linkStyle';

function fileSymbol(path: string, lineCount: number): SYMBOL.SymbolModel {
    return new SYMBOL.SymbolModel(
        `file:${path}`,
        path.split('/').pop()!,
        vscode.SymbolKind.File,
        path,
        new vscode.Position(0, 0),
        new vscode.Position(0, 0),
        new vscode.Position(lineCount - 1, 0),
        Buffer.from(''),
        null,
    );
}

function childSymbol(id: string, name: string, parentPath: string, parentId: string): SYMBOL.SymbolModel {
    return new SYMBOL.SymbolModel(
        id,
        name,
        vscode.SymbolKind.Function,
        parentPath,
        new vscode.Position(1, 0),
        new vscode.Position(1, 0),
        new vscode.Position(2, 0),
        Buffer.from(''),
        parentId,
    );
}

function relationship(refId: string, refPath: string, refLine: number, defId: string, defPath: string, defLine: number): codeRelationships.Relationship {
    return new codeRelationships.Relationship(
        new codeRelationships.SymbolLocation(refId, refPath, refLine),
        new codeRelationships.SymbolLocation(defId, defPath, defLine),
    );
}

describe('convertToCosmosFormat', () => {
    it('線に種類ごとの強さを集計し、色は最も強い種類・太さは強さの合計で決める (Stage 5)', () => {
        const a = fileSymbol('src/a.ts', 10);
        const b = fileSymbol('src/b.ts', 10);
        const aRun = childSymbol('a/run', 'run', 'src/a.ts', a.id);
        const aHelp = childSymbol('a/help', 'help', 'src/a.ts', a.id);
        const bBase = childSymbol('b/Base', 'Base', 'src/b.ts', b.id);
        const withStrengths = (refId: string, refPath: string, defId: string, defPath: string, strengths: Record<number, number>) =>
            new codeRelationships.Relationship(new codeRelationships.SymbolLocation(refId, refPath, 1),
                new codeRelationships.SymbolLocation(defId, defPath, 1), strengths);
        const data = convertToCosmosFormat([a, b, aRun, aHelp, bBase], [
            withStrengths(aRun.id, 'src/a.ts', bBase.id, 'src/b.ts', { [RelationshipKind.inheritance]: 9.5, [RelationshipKind.import]: 0.95 }),
            withStrengths(aHelp.id, 'src/a.ts', bBase.id, 'src/b.ts', { [RelationshipKind.call]: 2.85 }),
            withStrengths(aRun.id, 'src/a.ts', aHelp.id, 'src/a.ts', { [RelationshipKind.call]: 3 }),     // ファイル内
            relationship(bBase.id, 'src/b.ts', 1, aRun.id, 'src/a.ts', 1),                                  // LSP 由来 (種類無し)
        ]);
        const fileLink = data.links.find(link => link.level === 'file' && data.nodes[link.source].path === 'src/a.ts')!;
        expect(fileLink.strengths).toEqual({ [RelationshipKind.inheritance]: 9.5, [RelationshipKind.import]: 0.95, [RelationshipKind.call]: 2.85 });
        expect(fileLink.color).toBe(linkColorOf(RelationshipKind.inheritance));
        expect(fileLink.width).toBeCloseTo(linkWidthOf(13.3));
        expect(fileLink.intraFile).toBe(false);

        // LSP 由来の関係は種類不明 (unknown) に 1 件 = 1
        const lspLink = data.links.find(link => link.level === 'file' && data.nodes[link.source].path === 'src/b.ts')!;
        expect(lspLink.strengths).toEqual({ [RelationshipKind.unknown]: 1 });

        // ファイル内の関係はシンボル間の線だけになり、印が付く。ファイル間の線・次数には数えない
        const intra = data.links.filter(link => link.intraFile);
        expect(intra.map(link => [data.nodes[link.source].id, data.nodes[link.target].id, link.level])).toEqual([[aRun.id, aHelp.id, 'symbol']]);
        expect(data.links.filter(link => link.level === 'file')).toHaveLength(2);
    });

    it('参照も被参照も無い孤立ファイルはDead codeとして扱われる', () => {
        const foo = fileSymbol('src/foo.ts', 50);
        const data = convertToCosmosFormat([foo], []);
        const node = data.nodes.find(n => n.id === foo.id)!;
        expect(node.isEntryPoint).toBe(false);
        expect(node.isDeadCode).toBe(true);
        expect(node.inDegree).toBe(0);
        expect(node.outDegree).toBe(0);
    });

    it('エントリポイント命名パターンに一致するファイルはDead codeにならない', () => {
        const idx = fileSymbol('src/index.ts', 30);
        const data = convertToCosmosFormat([idx], []);
        const node = data.nodes.find(n => n.id === idx.id)!;
        expect(node.isEntryPoint).toBe(true);
        expect(node.isDeadCode).toBe(false);
        expect(data.entryPoints).toContain(idx.id);
    });

    it('ファイル間の参照からリンクとin/out次数を計算する', () => {
        const a = fileSymbol('src/a.ts', 20);
        const b = fileSymbol('src/b.ts', 20);
        const rel = relationship('sym-a', 'src/a.ts', 3, 'sym-b', 'src/b.ts', 5);
        const data = convertToCosmosFormat([a, b], [rel]);

        const fileLinks = data.links.filter(l => l.level === 'file');
        expect(fileLinks).toHaveLength(1);

        const nodeA = data.nodes.find(n => n.id === a.id)!;
        const nodeB = data.nodes.find(n => n.id === b.id)!;
        expect(nodeA.outDegree).toBe(1);
        expect(nodeA.inDegree).toBe(0);
        expect(nodeB.inDegree).toBe(1);
        expect(nodeB.outDegree).toBe(0);

        // 参照するだけで参照されないファイルは自動的にエントリポイント扱いになる
        expect(nodeA.isEntryPoint).toBe(true);
        expect(nodeB.isEntryPoint).toBe(false);
        expect(nodeB.isDeadCode).toBe(false);
    });

    it('相互参照は循環参照として検出され、対象ノード・リンクにフラグが立つ', () => {
        const a = fileSymbol('src/a.ts', 20);
        const b = fileSymbol('src/b.ts', 20);
        const relAB = relationship('sym-a', 'src/a.ts', 1, 'sym-b', 'src/b.ts', 1);
        const relBA = relationship('sym-b2', 'src/b.ts', 2, 'sym-a2', 'src/a.ts', 2);
        const data = convertToCosmosFormat([a, b], [relAB, relBA]);

        const nodeA = data.nodes.find(n => n.id === a.id)!;
        const nodeB = data.nodes.find(n => n.id === b.id)!;
        expect(nodeA.isCyclic).toBe(true);
        expect(nodeB.isCyclic).toBe(true);
        expect(data.circularLinkIndices.length).toBeGreaterThan(0);
        for (const idx of data.circularLinkIndices) {
            expect(data.links[idx].color).toBe(0xFF4444);
        }
    });

    it('保守性スコアは行数と出次数から計算される（lineScore*0.6 + refScore*0.4）', () => {
        const a = fileSymbol('src/a.ts', 250); // lineScore = min(250/500,1) = 0.5
        const data = convertToCosmosFormat([a], []);
        const nodeA = data.nodes.find(n => n.id === a.id)!;
        // outDegree=0 のため refScore=0 -> score = 0.5*0.6 = 0.3
        expect(nodeA.maintenanceScore).toBeCloseTo(0.3, 5);
    });

    it('子シンボルはchildCountに反映され、シンボルノードとして生成される', () => {
        const foo = fileSymbol('src/foo.ts', 20);
        const fn = childSymbol('sym-fn', 'doThing', 'src/foo.ts', foo.id);
        foo.addChild(fn);
        const data = convertToCosmosFormat([foo, fn], []);
        const fileNode = data.nodes.find(n => n.id === foo.id)!;
        const symbolNode = data.nodes.find(n => n.id === fn.id)!;
        expect(fileNode.childCount).toBe(1);
        expect(symbolNode.level).toBe('symbol');
        expect(symbolNode.parentId).toBe(foo.id);
    });

    it('ディレクトリノードがファイルの親として生成される', () => {
        const foo = fileSymbol('src/relationship/foo.ts', 10);
        const data = convertToCosmosFormat([foo], []);
        expect(data.directories).toContain('src/relationship');
        const dirNode = data.nodes.find(n => n.id === 'dir:src/relationship');
        expect(dirNode).toBeDefined();
        expect(dirNode!.level).toBe('directory');
    });
});

describe('Cosmos.gl向け配列変換', () => {
    const nodes: CosmosNode[] = [
        {
            id: 'n1', x: 1, y: 2, size: 10, color: 0xff0000, parentId: null, level: 'file',
            label: 'n1', path: 'n1.ts', kind: 0, childCount: 0, visible: true, lineCount: 0,
            inDegree: 0, outDegree: 0, isEntryPoint: false, isDeadCode: false, isCyclic: false,
            maintenanceScore: 0, hotspotScore: 0,
        },
        {
            id: 'n2', x: 3, y: 4, size: 20, color: 0x00ff00, parentId: null, level: 'file',
            label: 'n2', path: 'n2.ts', kind: 0, childCount: 0, visible: true, lineCount: 0,
            inDegree: 0, outDegree: 0, isEntryPoint: false, isDeadCode: false, isCyclic: false,
            maintenanceScore: 0, hotspotScore: 0,
        },
    ];
    const links: CosmosLink[] = [
        { source: 0, target: 1, width: 1, color: 0x3498DB, details: [], level: 'file', strengths: {}, intraFile: false },
    ];

    it('getPositionsAsFloat32Arrayはx,yを交互に並べる', () => {
        expect(Array.from(getPositionsAsFloat32Array(nodes))).toEqual([1, 2, 3, 4]);
    });

    it('getLinksAsUint32Arrayはsource,targetを交互に並べる', () => {
        expect(Array.from(getLinksAsUint32Array(links))).toEqual([0, 1]);
    });

    it('getSizesAsFloat32Arrayはノードサイズを並べる', () => {
        expect(Array.from(getSizesAsFloat32Array(nodes))).toEqual([10, 20]);
    });

    it('getColorsAsFloat32Arrayは16進数色を正規化RGBAへ変換する', () => {
        const colors = getColorsAsFloat32Array(nodes);
        expect(colors[0]).toBeCloseTo(1, 5); // R of 0xff0000
        expect(colors[1]).toBeCloseTo(0, 5); // G
        expect(colors[2]).toBeCloseTo(0, 5); // B
        expect(colors[3]).toBe(1.0);         // A
        expect(colors[4]).toBeCloseTo(0, 5); // R of 0x00ff00
        expect(colors[5]).toBeCloseTo(1, 5); // G
    });
});
