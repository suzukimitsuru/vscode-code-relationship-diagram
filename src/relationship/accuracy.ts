/** @file 名前解決の精度検証: LSP 由来の関係と AST 由来の関係の突き合わせ (docs/ast-plan.md §11) */
import type { RelationshipV2 } from './resolve';
import { RelationshipKind } from '../extruct/ast/relationshipKind';

/** シンボル (table_symbols の必要な列) */
export interface AccuracySymbol {
    readonly id: string;
    readonly parentId: string | null;
    readonly path: string;
    readonly fqn: string | null;
}

/** LSP 由来の関係 (table_relationships の1行。参照元 → 定義のシンボル ID) */
export interface AccuracyLspRelationship {
    readonly referenceId: string;
    readonly defineId: string;
}

/** 割合 */
export interface AccuracyMetric {
    readonly matched: number;
    readonly total: number;
    readonly ratio: number;
}

/** 突き合わせの結果 */
export interface AccuracyReport {
    /** import 由来の関係 (定義がトップレベル) の再現率 — Stage 2 の受け入れ基準 */
    readonly importDerived: AccuracyMetric;
    /** シンボル単位の全ての関係の再現率 (メンバの参照を含む。Stage 3 の対象) */
    readonly symbolRecall: AccuracyMetric;
    /** シンボル単位の適合率 (AST のファイル間の関係のうち LSP にもあるもの) */
    readonly symbolPrecision: AccuracyMetric;
    /** ファイル単位の再現率 */
    readonly fileRecall: AccuracyMetric;
    /** ファイル単位の適合率 */
    readonly filePrecision: AccuracyMetric;
    /** LSP のみが見つけた import 由来の関係 (参照元 → 定義) */
    readonly missedImportDerived: readonly (readonly [string, string])[];
    /** LSP のみが見つけたファイルの組 (参照元ファイル → 定義ファイル) */
    readonly lspOnlyFiles: readonly (readonly [string, string])[];
    /** AST のみが見つけたファイルの組と、その関係の種類 (import だけか等の判断材料) */
    readonly astOnlyFiles: readonly (readonly [string, string, RelationshipKind[]])[];
    /** シンボルが解決キーに辿り着けず比較できなかった LSP の関係の数 */
    readonly unmappedLsp: number;
    /**
     * 定義側が名前付きの宣言でない LSP の関係の数 (比較から除く)
     * @description オブジェクトリテラルのメンバ・無名コールバックなど。TypeScript の構造的な型付けにより、
     *              インターフェースのプロパティへの参照がそれを満たすオブジェクトリテラルのメンバへの参照として
     *              記録される (本番コード → テストのオブジェクトリテラル のような依存ではない関係)
     */
    readonly structuralLsp: number;
}

const metric = (matched: number, total: number): AccuracyMetric =>
    ({ matched: matched, total: total, ratio: total > 0 ? matched / total : 1 });

/**
 * 完全修飾名を、言語サーバのシンボルに付いた最も近い祖先へ正規化する
 * @param fqn 完全修飾名
 * @param attached シンボルに付いた完全修飾名の集合
 * @returns 正規化した完全修飾名 (どの祖先も付いていなければファイルの完全修飾名)
 * @description AST はコールバックの中の参照を外側の名前付き定義に集約し、ローカル変数のように
 *              シンボルの無い定義も参照元にする。比較は双方をシンボルのある単位へ揃えて行う
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

/** トップレベルの定義か (`<path>#<名前>` で名前に . を含まない) */
const isTopLevel = (fqn: string): boolean => {
    const name = fqn.slice(fqn.lastIndexOf('#') + 1);
    return name !== '' && !name.includes('.');
};

/** ファイルの部分 */
const pathOf = (fqn: string): string => fqn.slice(0, fqn.lastIndexOf('#'));

/**
 * LSP 由来の関係と AST 由来の関係を突き合わせる
 * @param symbols シンボル (解決キー付き)
 * @param lsp LSP 由来の関係 (ファイル間のみ)
 * @param ast AST 由来の関係
 * @returns 再現率・適合率と、取りこぼした関係
 * @description
 * - LSP は同じファイル内の参照を記録しないため、ファイル間の関係だけを比べる
 * - シンボル単位の比較は import 関係 (ファイル → 取り込んだ定義) を除く。LSP は import 文の位置の参照を
 *   どのシンボルにも結び付けない (ルートシンボルを参照元にしない) ため
 * - 定義側が名前付きの宣言でない LSP の関係 (structuralLsp) は比較から除く。名前解決の対象ではないため
 */
export function compareRelationships(symbols: readonly AccuracySymbol[], lsp: readonly AccuracyLspRelationship[],
    ast: readonly RelationshipV2[]): AccuracyReport {
    const byId = new Map(symbols.map(symbol => [symbol.id, symbol]));
    const attached = new Set(symbols.map(symbol => symbol.fqn).filter((fqn): fqn is string => fqn !== null));
    const fqnOfSymbol = (id: string): string | null => {
        for (let symbol = byId.get(id); symbol; symbol = symbol.parentId ? byId.get(symbol.parentId) : undefined) {
            if (symbol.fqn !== null) {
                return symbol.fqn;
            }
        }
        return null;
    };
    const key = (reference: string, define: string): string => JSON.stringify([reference, define]);

    // LSP: シンボル ID → 解決キー (参照元は祖先へ揃え、定義は名前付きの宣言そのものに限る)
    const lspPairs = new Map<string, [string, string]>();
    let unmappedLsp = 0;
    let structuralLsp = 0;
    for (const relationship of lsp) {
        const reference = fqnOfSymbol(relationship.referenceId);
        const defineSymbol = byId.get(relationship.defineId);
        const define = defineSymbol ? fqnOfSymbol(defineSymbol.id) : null;
        if (reference === null || define === null) {
            unmappedLsp++;
        } else if (defineSymbol?.fqn === null) {
            structuralLsp++;
        } else if (pathOf(reference) !== pathOf(define)) {
            lspPairs.set(key(reference, define), [reference, define]);
        }
    }

    // AST: 完全修飾名をシンボルのある単位へ正規化する
    const astPairs = new Set<string>();
    const astFiles = new Map<string, Set<RelationshipKind>>();
    for (const relationship of ast) {
        if (relationship.definePath === relationship.referencePath) {
            continue;
        }
        const files = key(relationship.referencePath, relationship.definePath);
        astFiles.set(files, (astFiles.get(files) ?? new Set<RelationshipKind>()).add(relationship.kind));
        if (relationship.kind !== RelationshipKind.import) {
            astPairs.add(key(normalizeFqn(relationship.referenceFqn, attached), normalizeFqn(relationship.defineFqn, attached)));
        }
    }

    const imported = [...lspPairs.entries()].filter(([, [, define]]) => isTopLevel(define));
    const missed = imported.filter(([pair]) => !astPairs.has(pair)).map(([, pair]) => pair);
    const lspFiles = new Set([...lspPairs.values()].map(([reference, define]) => key(pathOf(reference), pathOf(define))));
    const unkey = (pair: string): [string, string] => JSON.parse(pair) as [string, string];
    const byPair = (a: readonly [string, string, ...unknown[]], b: readonly [string, string, ...unknown[]]): number =>
        a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]);
    return {
        importDerived: metric(imported.length - missed.length, imported.length),
        symbolRecall: metric([...lspPairs.keys()].filter(pair => astPairs.has(pair)).length, lspPairs.size),
        symbolPrecision: metric([...astPairs].filter(pair => lspPairs.has(pair)).length, astPairs.size),
        fileRecall: metric([...lspFiles].filter(pair => astFiles.has(pair)).length, lspFiles.size),
        filePrecision: metric([...astFiles.keys()].filter(pair => lspFiles.has(pair)).length, astFiles.size),
        missedImportDerived: missed.sort(byPair),
        lspOnlyFiles: [...lspFiles].filter(pair => !astFiles.has(pair)).map(unkey).sort(byPair),
        astOnlyFiles: [...astFiles.entries()].filter(([pair]) => !lspFiles.has(pair))
            .map(([pair, kinds]) => [...unkey(pair), [...kinds].sort((a, b) => a - b)] as [string, string, RelationshipKind[]]).sort(byPair),
        unmappedLsp: unmappedLsp,
        structuralLsp: structuralLsp,
    };
}
