/**
 * @file 関係の線の見た目 (種類の色・強さの太さ・閾値) — docs/ast-plan.md Stage 5
 * @description 拡張機能 (cosmosAdapter) と Webview (graphView) の両方から使う。VS Code API と DOM に依存しない
 */
import { RelationshipKind } from '../extruct/ast/relationshipKind';

/**
 * 種類ごとの強さ (種類 → Σ 基本重み × 確信度)
 * @description JSON で Webview へ送るため、キーは種類の数値。LSP 由来の関係は種類が分からないため unknown (0) に 1 件 = 1 を足す
 */
export type KindStrengths = { [kind: number]: number };

/** 図に出す関係の種類 (表示順。object_key は関係にしないため含めない) */
export interface LinkKindStyle {
    readonly kind: RelationshipKind;
    /** 操作パネル・凡例の表示名 */
    readonly label: string;
    /** 線の色 (16進数) */
    readonly color: number;
}

/** 種類ごとの線の色 (暗い背景で見分けやすく、循環参照の赤 #FF4444 と重ならない色) */
export const LINK_KIND_STYLES: readonly LinkKindStyle[] = [
    { kind: RelationshipKind.inheritance, label: '継承', color: 0xE040FB },
    { kind: RelationshipKind.implementation, label: '実装', color: 0xB388FF },
    { kind: RelationshipKind.instantiation, label: '生成', color: 0xFF9800 },
    { kind: RelationshipKind.call, label: '呼び出し', color: 0x42A5F5 },
    { kind: RelationshipKind.write, label: '書き込み', color: 0xFFEB3B },
    { kind: RelationshipKind.decorator, label: 'デコレータ', color: 0x00BCD4 },
    { kind: RelationshipKind.type_reference, label: '型の参照', color: 0x26A69A },
    { kind: RelationshipKind.read, label: '読み取り', color: 0x8BC34A },
    { kind: RelationshipKind.import, label: 'import', color: 0x9E9E9E },
    { kind: RelationshipKind.unknown, label: '参照（LSP）', color: 0x3498DB },
];

/** 種類が分からない (古い書き出しデータの線など) ときの色 */
export const DEFAULT_LINK_COLOR = 0x3498DB;

/** 循環参照の線の色 */
export const CIRCULAR_LINK_COLOR = 0xFF4444;

/** 線の太さの上限 (px) */
const MAX_LINK_WIDTH = 10;

/**
 * 強さを足し合わせる
 * @param target 足し込む先 (書き換える)
 * @param source 足すもの
 * @returns target
 */
export function addStrengths(target: KindStrengths, source: KindStrengths): KindStrengths {
    for (const [kind, strength] of Object.entries(source)) {
        target[Number(kind)] = (target[Number(kind)] ?? 0) + strength;
    }
    return target;
}

/**
 * 有効な種類の強さの合計
 * @param strengths 種類ごとの強さ
 * @param enabled 表示する種類 (省略時は全て)
 */
export function strengthOf(strengths: KindStrengths, enabled?: ReadonlySet<number>): number {
    let total = 0;
    for (const [kind, strength] of Object.entries(strengths)) {
        if (!enabled || enabled.has(Number(kind))) {
            total += strength;
        }
    }
    return total;
}

/**
 * 有効な種類のうち最も強い種類 (線の色にする)
 * @param strengths 種類ごとの強さ
 * @param enabled 表示する種類 (省略時は全て)
 * @returns 種類 (有効な種類の強さが無ければ null)。同じ強さなら表示順の先 (継承など構造の強いもの) を選ぶ
 */
export function dominantKindOf(strengths: KindStrengths, enabled?: ReadonlySet<number>): RelationshipKind | null {
    let found: RelationshipKind | null = null;
    let best = 0;
    for (const style of LINK_KIND_STYLES) {
        const strength = strengths[style.kind] ?? 0;
        if (strength > best && (!enabled || enabled.has(style.kind))) {
            found = style.kind;
            best = strength;
        }
    }
    return found;
}

/**
 * 種類の線の色
 * @param kind 種類 (null なら既定の色)
 */
export function linkColorOf(kind: RelationshipKind | null): number {
    return LINK_KIND_STYLES.find(style => style.kind === kind)?.color ?? DEFAULT_LINK_COLOR;
}

/**
 * 強さから線の太さ (対数。1 本の読み取りで約 2.5px、上限 10px)
 * @param strength 強さ
 */
export function linkWidthOf(strength: number): number {
    return Math.min(1 + Math.log2(Math.max(strength, 0) + 1) * 1.5, MAX_LINK_WIDTH);
}

/**
 * 強さの閾値 (上位の線だけを残す)
 * @param strengths 線の強さ
 * @param percentile 0〜100。この割合の線を隠す (90 なら上位 10% を残す)
 * @returns 閾値 (この値以上の線を表示する)。0 または線が無ければ 0
 */
export function strengthThresholdOf(strengths: readonly number[], percentile: number): number {
    if (percentile <= 0 || strengths.length === 0) {
        return 0;
    }
    const sorted = [...strengths].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((percentile / 100) * sorted.length));
    return sorted[index];
}

/**
 * 16進数の色を WebGL の RGBA (0〜1) にする
 * @param color 16進数の色
 * @param alpha 不透明度
 */
export function rgbaOf(color: number, alpha: number): [number, number, number, number] {
    return [((color >> 16) & 0xff) / 255, ((color >> 8) & 0xff) / 255, (color & 0xff) / 255, alpha];
}
