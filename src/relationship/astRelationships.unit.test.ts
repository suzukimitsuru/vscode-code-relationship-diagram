/** @file AST 由来の関係を図のシンボルの関係へ変換する単体テスト */
import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import * as SYMBOL from '../extruct/symbol';
import { RelationshipKind } from '../extruct/ast/relationshipKind';
import { queryDiagramRelationships, toSymbolRelationships } from './astRelationships';
import { Relationship, SymbolLocation } from './codeRelationships';
import { RelationshipV2 } from './resolve';

const symbolOf = (id: string, path: string, fqn: string | null, parentId: string | null, line: number = 0): SYMBOL.SymbolModel => {
    const position = new vscode.Position(line, 0);
    const symbol = new SYMBOL.SymbolModel(id, id, parentId ? vscode.SymbolKind.Class : vscode.SymbolKind.File, path,
        position, position, position, Buffer.alloc(1), parentId);
    symbol.fqn = fqn;
    return symbol;
};

/** a.ts は言語サーバのシンボルあり、b.ts はルートシンボルだけ (言語サーバ未導入の状態) */
const SYMBOLS = [
    symbolOf('a', 'a.ts', 'a.ts#', null),
    symbolOf('a/A', 'a.ts', 'a.ts#A', 'a', 3),
    symbolOf('a/A.m', 'a.ts', 'a.ts#A.m', 'a/A', 4),
    symbolOf('b', 'b.ts', 'b.ts#', null),
];

const v2 = (referenceFqn: string, defineFqn: string, referenceLine: number = 7): RelationshipV2 => ({
    referencePath: referenceFqn.slice(0, referenceFqn.indexOf('#')), referenceFqn: referenceFqn,
    definePath: defineFqn.slice(0, defineFqn.indexOf('#')), defineFqn: defineFqn,
    kind: RelationshipKind.call, weight: 5, confidence: 0.95, referenceLine: referenceLine, referenceCharacter: 0, isIntraFile: false,
});

const pairs = (relationships: Relationship[]): string[] => relationships.map(entry => `${entry.reference.id}->${entry.define.id}`);

describe('toSymbolRelationships', () => {
    it('両端をシンボルのある最も近い祖先へ揃える', () => {
        const found = toSymbolRelationships(SYMBOLS, [v2('a.ts#A.m.local', 'b.ts#helper')]);
        expect(found).toEqual([new Relationship(new SymbolLocation('a/A.m', 'a.ts', 7), new SymbolLocation('b', 'b.ts', 0))]);
    });

    it('言語サーバのシンボルが無いファイル同士は、ファイル (ルートシンボル) の関係になる', () => {
        expect(pairs(toSymbolRelationships(SYMBOLS, [v2('b.ts#f', 'a.ts#A')]))).toEqual(['b->a/A']);
    });

    it('参照元・定義の組で一意にし、ファイル内の関係とシンボルの無いファイルは除く', () => {
        const found = toSymbolRelationships(SYMBOLS, [
            v2('a.ts#A.m', 'b.ts#x'), v2('a.ts#A.m', 'b.ts#y', 9),     // b.ts#x と b.ts#y はどちらも b.ts に揃う
            v2('a.ts#A.m', 'a.ts#A'),                                // ファイル内
            v2('a.ts#A', 'c.ts#C'),                                  // c.ts のシンボルが無い (未調査)
        ]);
        expect(pairs(found)).toEqual(['a/A.m->b']);
        expect(found[0].reference.startLine).toBe(7);
    });
});

describe('queryDiagramRelationships', () => {
    it('LSP 由来の関係と、AST 由来の関係を閾値で選んで変換したものを返す', async () => {
        const lsp = [new Relationship(new SymbolLocation('b', 'b.ts', 0), new SymbolLocation('a/A', 'a.ts', 3))];
        let threshold = -1;
        const loaded = await queryDiagramRelationships({
            relationship_queryLspMode: async () => lsp,
            relationships_v2_queryAstMode: async (value) => { threshold = value; return [v2('a.ts#A', 'b.ts#f')]; },
        }, SYMBOLS, 0.7);
        expect(threshold).toBe(0.7);
        expect(loaded.lsp).toBe(lsp);
        expect(pairs(loaded.ast)).toEqual(['a/A->b']);
    });
});
