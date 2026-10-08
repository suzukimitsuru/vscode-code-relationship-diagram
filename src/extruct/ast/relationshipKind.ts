/** @file 関係の種類 (docs/ast-plan.md §5.3) */

/**
 * 関係の種類
 * @description 値は DuckDB に保存するため変更しない事。追加は末尾に行う
 */
export enum RelationshipKind {
    unknown = 0,
    import = 1,
    inheritance = 2,
    implementation = 3,
    instantiation = 4,
    call = 5,
    type_reference = 6,
    read = 7,
    write = 8,
    decorator = 9,
}

/**
 * 種類ごとの基本重み (docs/ast-plan.md §5.3)
 * @description 関係の強さ strength = Σ(基本重み × confidence)
 */
export const RELATIONSHIP_WEIGHTS: Readonly<Record<RelationshipKind, number>> = {
    [RelationshipKind.unknown]: 1,
    [RelationshipKind.import]: 1,
    [RelationshipKind.inheritance]: 10,
    [RelationshipKind.implementation]: 8,
    [RelationshipKind.instantiation]: 5,
    [RelationshipKind.call]: 3,
    [RelationshipKind.type_reference]: 2,
    [RelationshipKind.read]: 1,
    [RelationshipKind.write]: 4,
    [RelationshipKind.decorator]: 5,
};

/**
 * 同じ識別子を複数のパターンが捉えた時に残す種類の優先順位 (先頭ほど強い)
 * @description tree-sitter のクエリはパターン間に優先順位が無く、例えば `this.m()` の `m` は
 *              呼び出しとメンバ読み取りの両方に一致する。より具体的な種類を残す
 */
const PRIORITY: readonly RelationshipKind[] = [
    RelationshipKind.inheritance,
    RelationshipKind.implementation,
    RelationshipKind.decorator,
    RelationshipKind.instantiation,
    RelationshipKind.call,
    RelationshipKind.write,
    RelationshipKind.type_reference,
    RelationshipKind.read,
    RelationshipKind.import,
    RelationshipKind.unknown,
];

/**
 * 種類の強さ (小さいほど優先)
 * @param kind 関係の種類
 * @returns 優先順位
 */
export function relationshipKindRank(kind: RelationshipKind): number {
    const rank = PRIORITY.indexOf(kind);
    return rank >= 0 ? rank : PRIORITY.length;
}

/**
 * キャプチャ名から関係の種類を得る
 * @param captureName `ref.<kind>` 形式のキャプチャ名 (`ref.read.member` のような補足付きも可)
 * @returns 関係の種類。`ref.` で始まらない、または未知の種類なら null
 */
export function relationshipKindOf(captureName: string): RelationshipKind | null {
    const [prefix, kind] = captureName.split('.');
    if (prefix !== 'ref' || !kind || kind === 'receiver') {
        return null;
    }
    const value = (RelationshipKind as unknown as Record<string, number>)[kind];
    return typeof value === 'number' ? value as RelationshipKind : RelationshipKind.unknown;
}
