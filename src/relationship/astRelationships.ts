/** @file AST 由来の関係 (完全修飾名の組) を、図に表示するシンボルの関係へ変換する (docs/ast-plan.md Stage 4) */
import type * as codeDb from '../codeDb';
import * as SYMBOL from '../extruct/symbol';
import { Relationship, SymbolLocation } from './codeRelationships';
import type { RelationshipV2 } from './resolve';
import { addStrengths } from '../webview/linkStyle';

/**
 * 完全修飾名を、言語サーバのシンボルに付いた最も近い祖先へ正規化する
 * @param fqn 完全修飾名
 * @param attached シンボルに付いた完全修飾名の集合
 * @returns 正規化した完全修飾名 (どの祖先も付いていなければファイルの完全修飾名)
 * @description AST はコールバックの中の参照を外側の名前付き定義に集約し、ローカル変数のように
 *              シンボルの無い定義も参照元にする。比較・表示は双方をシンボルのある単位へ揃えて行う
 */
export function normalizeFqn(fqn: string, attached: ReadonlySet<string>): string {
    let current = fqn;
    while (!attached.has(current)) {
        const hash = current.lastIndexOf('#');
        const name = current.slice(hash + 1);
        if (name === '') {
            return current;
        }
        const dot = name.lastIndexOf('.');
        current = dot < 0 ? current.slice(0, hash + 1) : current.slice(0, hash + 1 + dot);
    }
    return current;
}

/**
 * AST 由来の関係を、シンボル ID の関係 (図の入力) にする
 * @param symbols 全シンボル (解決キー付き。ファイルのルートシンボルの解決キーは `<path>#`)
 * @param relationships AST 由来の関係
 * @returns シンボルの関係 (参照元・定義の組で一意。種類ごとの強さ = Σ 基本重み × 確信度 を組ごとに足し合わせる)
 * @description 両端をシンボルのある最も近い祖先へ揃える。言語サーバのシンボルが無いファイル (言語サーバ未導入など) は
 *              ルートシンボル (ファイル) に揃うため、ファイル単位の関係として表示される。
 *              ファイル内の関係は、両端が別のシンボル (ルートシンボルを除く) になるものだけを残す (Stage 5 のファイル内の依存の表示)
 */
export function toSymbolRelationships(symbols: readonly SYMBOL.SymbolModel[], relationships: readonly RelationshipV2[]): Relationship[] {
    const byFqn = new Map<string, SYMBOL.SymbolModel>();
    for (const symbol of symbols) {
        if (symbol.fqn !== null && !byFqn.has(symbol.fqn)) {
            byFqn.set(symbol.fqn, symbol);
        }
    }
    const attached = new Set(byFqn.keys());
    const result = new Map<string, Relationship>();
    for (const relationship of relationships) {
        const reference = byFqn.get(normalizeFqn(relationship.referenceFqn, attached));
        const define = byFqn.get(normalizeFqn(relationship.defineFqn, attached));
        if (!reference || !define || reference.id === define.id ||
            (reference.path === define.path && (reference.parentId === null || define.parentId === null))) {
            continue;
        }
        const key = JSON.stringify([reference.id, define.id]);
        let found = result.get(key);
        if (!found) {
            found = new Relationship(
                new SymbolLocation(reference.id, reference.path, relationship.referenceLine),
                new SymbolLocation(define.id, define.path, define.start.line), {});
            result.set(key, found);
        }
        addStrengths(found.strengths!, { [relationship.kind]: relationship.weight * relationship.confidence });
    }
    return [...result.values()];
}

/** 図の関係の読み込みに使う DB の操作 */
export type DiagramDb = Pick<codeDb.Db, 'relationship_queryLspMode' | 'relationships_v2_queryAstMode'>;

/**
 * 図に表示する関係を読み込む
 * @param db DB
 * @param symbols 全シンボル
 * @param threshold AST 由来の関係の確信度の下限 (設定 ast.confidenceThreshold)
 * @returns LSP 由来の関係 (定義側を LSP の経路で調べたファイル) と AST 由来の関係 (参照元を AST の経路で調べたファイル)
 * @description ファイルごとに記録した調査経路で選ぶため、設定を切り替えた直後の調べ直しの途中でも二重に数えない
 */
export async function queryDiagramRelationships(db: DiagramDb, symbols: readonly SYMBOL.SymbolModel[], threshold: number):
    Promise<{ lsp: Relationship[], ast: Relationship[] }> {
    const lsp = await db.relationship_queryLspMode();
    const ast = toSymbolRelationships(symbols, await db.relationships_v2_queryAstMode(threshold));
    return { lsp, ast };
}
