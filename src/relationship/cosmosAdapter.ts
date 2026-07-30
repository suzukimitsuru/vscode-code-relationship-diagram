/**
 * Cosmos.gl Adapter: GPU加速WebGLレンダリングで大規模グラフに対応
 *
 * シンボルデータをCosmos.gl形式に変換し、階層的レイアウトを計算する
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as SYMBOL from '../extruct/symbol';
import * as codeRelationships from './codeRelationships';

/**
 * Cosmos.glノードデータ
 */
export interface CosmosNode {
    /** 一意のID */
    id: string;
    /** X座標 */
    x: number;
    /** Y座標 */
    y: number;
    /** ノードサイズ */
    size: number;
    /** ノード色（16進数） */
    color: number;
    /** 親ノードID（階層構造用） */
    parentId: string | null;
    /** ノードレベル */
    level: 'directory' | 'file' | 'symbol';
    /** 表示ラベル */
    label: string;
    /** ファイルパス */
    path: string;
    /** シンボル種別（vscode.SymbolKind） */
    kind: number;
    /** 行番号 */
    line?: number;
    /** コミュニティID（クラスタリング用） */
    communityId?: number;
    /** 子ノード数（サイズ計算用） */
    childCount: number;
    /** 表示状態 */
    visible: boolean;
    /** コードの行数（ノードサイズ計算用） */
    lineCount: number;
    /** 入次数（このノードへの参照数） */
    inDegree: number;
    /** 出次数（このノードからの参照数） */
    outDegree: number;
    /** エントリポイントか */
    isEntryPoint: boolean;
    /** デッドコードか（in-degree=0 かつ非エントリポイント） */
    isDeadCode: boolean;
    /** 循環参照に含まれるか */
    isCyclic: boolean;
    /** 保守性スコア（0-1） */
    maintenanceScore: number;
    /** ホットスポットスコア */
    hotspotScore: number;
}

/**
 * 関係の詳細情報
 */
export interface RelationshipDetail {
    /** 参照元シンボル名 */
    sourceName: string;
    /** 参照先シンボル名 */
    targetName: string;
    /** 参照元行番号 */
    sourceLine: number;
    /** 参照先行番号 */
    targetLine: number;
    /** 参照元パス */
    sourcePath: string;
    /** 参照先パス */
    targetPath: string;
}

/**
 * Cosmos.glリンクデータ
 */
export interface CosmosLink {
    /** ソースノードインデックス */
    source: number;
    /** ターゲットノードインデックス */
    target: number;
    /** リンク幅（関係数に基づく） */
    width: number;
    /** リンク色（16進数） */
    color: number;
    /** 関係の詳細リスト */
    details: RelationshipDetail[];
    /** リンクレベル: file=ファイル間集約リンク、symbol=シンボル間リンク */
    level: 'file' | 'symbol';
}

/**
 * 変換結果
 */
export interface CosmosData {
    /** ノード配列 */
    nodes: CosmosNode[];
    /** リンク配列 */
    links: CosmosLink[];
    /** ノードID → インデックス マッピング */
    nodeIndex: Map<string, number>;
    /** ディレクトリパス一覧 */
    directories: string[];
    /** エントリポイントノードIDリスト */
    entryPoints: string[];
    /** 循環参照リンクインデックスリスト */
    circularLinkIndices: number[];
}

/**
 * ファイルノードサイズの基準行数（この行数のファイルが基準サイズになる）
 * 調整時はこの定数を変更する
 */
export const FILE_NODE_BASE_LINES = 100;
const FILE_NODE_BASE_SIZE = 12;   // 基準行数のときのサイズ（px）
const FILE_NODE_MIN_SIZE  = 5;    // 最小サイズ
const FILE_NODE_MAX_SIZE  = 60;   // 最大サイズ

/**
 * 色定義（ノードレベル別）
 */
const NODE_COLORS = {
    directory: 0x4a9eff,  // 青
    symbol: 0xff9800,     // オレンジ
};

/**
 * 保守性カラースキーム（circle-diagram.md 仕様）
 */
const MAINTENANCE_COLORS = {
    good:       0x4CAF50,  // 緑（スコア 0〜0.33）
    caution:    0xFFC107,  // 黄（スコア 0.33〜0.5）
    warning:    0xFF9800,  // 橙（スコア 0.5〜0.66）
    danger:     0xF44336,  // 赤（スコア 0.66〜1.0）
    deadCode:   0x9E9E9E,  // グレー（デッドコード）
    entryPoint: 0x2196F3,  // 青（エントリポイント）
    godFunc:    0xFFD700,  // 金（God Function）
};

/**
 * リンク色（#3498DB - 通常青）
 */
const LINK_COLOR = 0x3498DB;

/**
 * 循環参照リンク色（赤）
 */
const CIRCULAR_LINK_COLOR = 0xFF4444;

/**
 * エントリポイントとみなす命名パターン
 */
const ENTRY_POINT_PATTERNS = [
    /^(main|index|app|server|start|activate|bootstrap|init)\.(ts|js|tsx|jsx|py|go|rs|java|cs|cpp|c)$/i,
    /^(main|index|app|server|start|activate|bootstrap|init)$/i,
    /^App\.(ts|js|tsx|jsx)$/,
];

/**
 * コミュニティカラーパレット（非エントリポイント/非デッドコードのフォールバック）
 */
const COMMUNITY_COLORS = [
    0xe53935, 0x1e88e5, 0x43a047, 0xfb8c00, 0x8e24aa,
    0x00acc1, 0xffb300, 0x5e35b1, 0x00897b, 0xd81b60,
];

/**
 * 保守性スコアを算出（0.0〜1.0）
 */
function calcMaintenanceScore(lineCount: number, outDegree: number): number {
    const lineScore = Math.min(lineCount / 500, 1.0);
    const refScore = Math.min(outDegree / 20, 1.0);
    return lineScore * 0.6 + refScore * 0.4;
}

/**
 * 保守性スコアから色を取得
 */
function getMaintenanceColor(score: number): number {
    if (score < 0.33) { return MAINTENANCE_COLORS.good; }
    if (score < 0.5)  { return MAINTENANCE_COLORS.caution; }
    if (score < 0.66) { return MAINTENANCE_COLORS.warning; }
    return MAINTENANCE_COLORS.danger;
}

/**
 * ファイル行数からノードサイズを計算（√スケール、FILE_NODE_BASE_LINES行が基準）
 */
function calcNodeSizeByLineCount(lineCount: number): number {
    const ratio = Math.sqrt(Math.max(lineCount, 1) / FILE_NODE_BASE_LINES);
    return Math.min(Math.max(FILE_NODE_MIN_SIZE, FILE_NODE_BASE_SIZE * ratio), FILE_NODE_MAX_SIZE);
}

/**
 * 循環参照をDFS（バック辺検出）で特定
 * Returns { circularLinkIndices, cyclicNodeIndices }
 */
function detectCircularReferences(
    nodes: CosmosNode[],
    links: CosmosLink[]
): { circularLinkIndices: number[]; cyclicNodeIndices: Set<number> } {
    // ファイルノードのインデックスセット
    const fileNodeIndices = new Set<number>();
    nodes.forEach((node, i) => {
        if (node.level === 'file') { fileNodeIndices.add(i); }
    });

    // 隣接リスト（ファイル→ファイルのリンクのみ）
    const adj = new Map<number, Array<{ neighbor: number; linkIdx: number }>>();
    links.forEach((link, linkIdx) => {
        if (fileNodeIndices.has(link.source) && fileNodeIndices.has(link.target)) {
            if (!adj.has(link.source)) { adj.set(link.source, []); }
            adj.get(link.source)!.push({ neighbor: link.target, linkIdx });
        }
    });

    const visited = new Set<number>();
    const inStack = new Set<number>();
    const backEdgeKeys = new Set<string>(); // "source-target"

    function dfs(v: number): void {
        visited.add(v);
        inStack.add(v);
        for (const { neighbor } of (adj.get(v) || [])) {
            if (!visited.has(neighbor)) {
                dfs(neighbor);
            } else if (inStack.has(neighbor)) {
                backEdgeKeys.add(`${v}-${neighbor}`);
            }
        }
        inStack.delete(v);
    }

    for (const idx of fileNodeIndices) {
        if (!visited.has(idx)) { dfs(idx); }
    }

    // バック辺に対応するリンクインデックスを収集
    const circularLinkIndices: number[] = [];
    const cyclicNodeIndices = new Set<number>();
    links.forEach((link, i) => {
        if (backEdgeKeys.has(`${link.source}-${link.target}`)) {
            circularLinkIndices.push(i);
            cyclicNodeIndices.add(link.source);
            cyclicNodeIndices.add(link.target);
        }
    });

    return { circularLinkIndices, cyclicNodeIndices };
}

/**
 * シンボルとリレーションシップをCosmos.gl形式に変換
 */
export function convertToCosmosFormat(
    symbols: SYMBOL.SymbolModel[],
    relationships: codeRelationships.Relationship[],
    communities?: Map<string, number>
): CosmosData {
    const nodes: CosmosNode[] = [];
    const links: CosmosLink[] = [];
    const nodeIndex = new Map<string, number>();
    const directorySet = new Set<string>();

    /** 新フィールドのデフォルト値 */
    const newNodeDefaults = {
        lineCount: 0,
        inDegree: 0,
        outDegree: 0,
        isEntryPoint: false,
        isDeadCode: false,
        isCyclic: false,
        maintenanceScore: 0,
        hotspotScore: 0,
    };

    // 1. ディレクトリノードを生成
    const directoryNodes = new Map<string, CosmosNode>();
    for (const symbol of symbols) {
        if (symbol.kind === vscode.SymbolKind.File) {
            collectDirectories(path.dirname(symbol.path), directoryNodes, directorySet);
        }
    }

    // ディレクトリノードを追加
    for (const [, dirNode] of directoryNodes) {
        nodeIndex.set(dirNode.id, nodes.length);
        nodes.push(dirNode);
    }

    // 2. ファイルノードを生成
    const fileNodes = new Map<string, CosmosNode>();
    for (const symbol of symbols) {
        if (symbol.kind === vscode.SymbolKind.File) {
            const dirPath = path.dirname(symbol.path);
            const parentId = `dir:${dirPath}`;
            const communityId = communities?.get(symbol.id);

            const fileNode: CosmosNode = {
                ...newNodeDefaults,
                id: symbol.id,
                x: 0,
                y: 0,
                size: 12,  // 後でlineCountベースに更新
                color: communityId !== undefined
                    ? COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length]
                    : MAINTENANCE_COLORS.good,
                parentId: parentId,
                level: 'file',
                label: path.basename(symbol.path),
                path: symbol.path,
                kind: symbol.kind,
                line: symbol.define.line,
                communityId: communityId,
                childCount: countSymbols(symbol),
                visible: true,
                lineCount: symbol.lineCount,
            };

            fileNodes.set(symbol.path, fileNode);
            nodeIndex.set(fileNode.id, nodes.length);
            nodes.push(fileNode);

            // ディレクトリの子ノード数を更新
            const dirNode = directoryNodes.get(dirPath);
            if (dirNode) { dirNode.childCount++; }
        }
    }

    // 3. シンボルノードを生成
    for (const symbol of symbols) {
        if (symbol.kind !== vscode.SymbolKind.File) {
            const symbolNode: CosmosNode = {
                ...newNodeDefaults,
                id: symbol.id,
                x: 0,
                y: 0,
                size: 5,
                color: getSymbolColor(symbol.kind),
                parentId: symbol.parentId || null,
                level: 'symbol',
                label: symbol.name,
                path: symbol.path,
                kind: symbol.kind,
                line: symbol.define.line,
                childCount: 0,
                visible: true,
                lineCount: symbol.lineCount,
            };

            nodeIndex.set(symbolNode.id, nodes.length);
            nodes.push(symbolNode);
        }
    }

    // 4. ファイル間リンクを生成
    const fileRelations = aggregateFileRelationships(relationships, symbols);
    for (const [key, details] of fileRelations) {
        const [sourcePath, targetPath] = key.split('|||');
        const sourceFile = fileNodes.get(sourcePath);
        const targetFile = fileNodes.get(targetPath);

        if (sourceFile && targetFile) {
            const sourceIdx = nodeIndex.get(sourceFile.id);
            const targetIdx = nodeIndex.get(targetFile.id);

            if (sourceIdx !== undefined && targetIdx !== undefined) {
                links.push({
                    source: sourceIdx,
                    target: targetIdx,
                    width: calculateLinkWidth(details.length),
                    color: LINK_COLOR,
                    details: details,
                    level: 'file',
                });
            }
        }
    }

    // 5. 入次数・出次数を計算（ファイルノード対象）
    for (const link of links) {
        const srcNode = nodes[link.source];
        const tgtNode = nodes[link.target];
        if (srcNode) { srcNode.outDegree++; }
        if (tgtNode) { tgtNode.inDegree++; }
    }

    // 6. エントリポイント・デッドコードを判定
    const entryPoints: string[] = [];
    for (const node of nodes) {
        if (node.level !== 'file') { continue; }
        const isNaming = ENTRY_POINT_PATTERNS.some(re => re.test(node.label));
        node.isEntryPoint = (node.inDegree === 0 && node.outDegree > 0) || isNaming;
        if (node.isEntryPoint) { entryPoints.push(node.id); }
        node.isDeadCode = (node.inDegree === 0 && !node.isEntryPoint);
    }

    // 7. 循環参照を検出
    const { circularLinkIndices, cyclicNodeIndices } = detectCircularReferences(nodes, links);
    for (const idx of cyclicNodeIndices) {
        nodes[idx].isCyclic = true;
    }

    // 8. 循環リンクの色を変更
    for (const i of circularLinkIndices) {
        links[i].color = CIRCULAR_LINK_COLOR;
    }

    // 9. ファイルノードの保守性スコア・色・サイズを更新
    for (const node of nodes) {
        if (node.level !== 'file') { continue; }
        node.maintenanceScore = calcMaintenanceScore(node.lineCount, node.outDegree);
        node.hotspotScore = node.lineCount * (node.inDegree + node.outDegree + 1);
        node.size = calcNodeSizeByLineCount(node.lineCount);

        if (node.isEntryPoint) {
            node.color = MAINTENANCE_COLORS.entryPoint;
        } else if (node.isDeadCode) {
            node.color = MAINTENANCE_COLORS.deadCode;
        } else if (node.lineCount > 200 && node.outDegree > 20) {
            node.color = MAINTENANCE_COLORS.godFunc;  // God Function
        } else {
            node.color = getMaintenanceColor(node.maintenanceScore);
        }
    }

    // 10. シンボル間リンクを生成（シンボルモード表示用、§2-2-1）
    const symbolRelationMap = new Map<string, RelationshipDetail[]>();
    for (const rel of relationships) {
        const sourceIdx = nodeIndex.get(rel.reference.id);
        const targetIdx = nodeIndex.get(rel.define.id);
        if (sourceIdx === undefined || targetIdx === undefined) { continue; }
        if (sourceIdx === targetIdx) { continue; }

        const key = `${sourceIdx}|||${targetIdx}`;
        if (!symbolRelationMap.has(key)) {
            symbolRelationMap.set(key, []);
        }
        const sourceNode = nodes[sourceIdx];
        const targetNode = nodes[targetIdx];
        symbolRelationMap.get(key)!.push({
            sourceName: sourceNode?.label || 'Unknown',
            targetName: targetNode?.label || 'Unknown',
            sourceLine: rel.reference.startLine,
            targetLine: rel.define.startLine,
            sourcePath: rel.reference.path,
            targetPath: rel.define.path,
        });
    }
    for (const [key, details] of symbolRelationMap) {
        const parts = key.split('|||');
        links.push({
            source: parseInt(parts[0]),
            target: parseInt(parts[1]),
            width: calculateLinkWidth(details.length),
            color: LINK_COLOR,
            details,
            level: 'symbol',
        });
    }

    return {
        nodes,
        links,
        nodeIndex,
        directories: Array.from(directorySet).sort(),
        entryPoints,
        circularLinkIndices,
    };
}

/**
 * ディレクトリ階層を収集
 */
function collectDirectories(
    dirPath: string,
    directoryNodes: Map<string, CosmosNode>,
    directorySet: Set<string>
): void {
    if (dirPath === '.' || dirPath === '' || directoryNodes.has(dirPath)) {
        return;
    }

    directorySet.add(dirPath);

    const parentPath = path.dirname(dirPath);
    const parentId = parentPath === '.' || parentPath === ''
        ? null
        : `dir:${parentPath}`;

    const dirNode: CosmosNode = {
        id: `dir:${dirPath}`,
        x: 0,
        y: 0,
        size: 20,
        color: NODE_COLORS.directory,
        parentId: parentId,
        level: 'directory',
        label: path.basename(dirPath),
        path: dirPath,
        kind: -1,  // ディレクトリ用の特殊値
        childCount: 0,
        visible: true,
        lineCount: 0,
        inDegree: 0,
        outDegree: 0,
        isEntryPoint: false,
        isDeadCode: false,
        isCyclic: false,
        maintenanceScore: 0,
        hotspotScore: 0,
    };

    directoryNodes.set(dirPath, dirNode);

    // 親ディレクトリも再帰的に収集
    if (parentPath !== '.' && parentPath !== '') {
        collectDirectories(parentPath, directoryNodes, directorySet);
    }
}

/**
 * シンボル数をカウント
 */
function countSymbols(symbol: SYMBOL.SymbolModel): number {
    let count = 0;
    const countRecursive = (s: SYMBOL.SymbolModel) => {
        count++;
        s.children.forEach(child => countRecursive(child));
    };
    symbol.children.forEach(child => countRecursive(child));
    return count;
}

/**
 * シンボル種別に応じた色を取得
 */
function getSymbolColor(kind: vscode.SymbolKind): number {
    switch (kind) {
        case vscode.SymbolKind.Class:
        case vscode.SymbolKind.Interface:
            return 0x9c27b0;  // 紫
        case vscode.SymbolKind.Function:
        case vscode.SymbolKind.Method:
            return 0x2196f3;  // 青
        case vscode.SymbolKind.Variable:
        case vscode.SymbolKind.Constant:
            return 0x4caf50;  // 緑
        case vscode.SymbolKind.Enum:
        case vscode.SymbolKind.EnumMember:
            return 0xff9800;  // オレンジ
        default:
            return NODE_COLORS.symbol;
    }
}

/**
 * ファイル間の関係を集約
 */
function aggregateFileRelationships(
    relationships: codeRelationships.Relationship[],
    symbols: SYMBOL.SymbolModel[]
): Map<string, RelationshipDetail[]> {
    const symbolIndex = new Map<string, SYMBOL.SymbolModel>();
    for (const symbol of symbols) {
        symbolIndex.set(symbol.id, symbol);
    }

    const fileRelations = new Map<string, RelationshipDetail[]>();

    for (const rel of relationships) {
        const sourcePath = rel.reference.path;
        const targetPath = rel.define.path;

        // 同一ファイル内の関係は除外
        if (sourcePath === targetPath) {
            continue;
        }

        // 方向付きリンク: 参照元(source) → 定義先(target)
        const key = `${sourcePath}|||${targetPath}`;

        if (!fileRelations.has(key)) {
            fileRelations.set(key, []);
        }

        const sourceSymbol = symbolIndex.get(rel.reference.id);
        const targetSymbol = symbolIndex.get(rel.define.id);

        fileRelations.get(key)!.push({
            sourceName: sourceSymbol?.name || 'Unknown',
            targetName: targetSymbol?.name || 'Unknown',
            sourceLine: rel.reference.startLine,
            targetLine: rel.define.startLine,
            sourcePath: sourcePath,
            targetPath: targetPath,
        });
    }

    return fileRelations;
}

/**
 * リンク幅を計算（関係数に基づく対数スケール）
 */
function calculateLinkWidth(relationshipCount: number): number {
    // 1-10の範囲で対数スケール
    return Math.min(1 + Math.log2(relationshipCount + 1) * 2, 10);
}

/**
 * Float32Arrayとして座標を取得（Cosmos.gl用）
 */
export function getPositionsAsFloat32Array(nodes: CosmosNode[]): Float32Array {
    const positions = new Float32Array(nodes.length * 2);
    for (let i = 0; i < nodes.length; i++) {
        positions[i * 2] = nodes[i].x;
        positions[i * 2 + 1] = nodes[i].y;
    }
    return positions;
}

/**
 * Uint32Arrayとしてリンクを取得（Cosmos.gl用）
 */
export function getLinksAsUint32Array(links: CosmosLink[]): Uint32Array {
    const linkArray = new Uint32Array(links.length * 2);
    for (let i = 0; i < links.length; i++) {
        linkArray[i * 2] = links[i].source;
        linkArray[i * 2 + 1] = links[i].target;
    }
    return linkArray;
}

/**
 * ノードサイズをFloat32Arrayで取得
 */
export function getSizesAsFloat32Array(nodes: CosmosNode[]): Float32Array {
    const sizes = new Float32Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        sizes[i] = nodes[i].size;
    }
    return sizes;
}

/**
 * ノード色をFloat32Arrayで取得（正規化RGB）
 */
export function getColorsAsFloat32Array(nodes: CosmosNode[]): Float32Array {
    const colors = new Float32Array(nodes.length * 4);
    for (let i = 0; i < nodes.length; i++) {
        const color = nodes[i].color;
        colors[i * 4] = ((color >> 16) & 0xff) / 255;     // R
        colors[i * 4 + 1] = ((color >> 8) & 0xff) / 255;  // G
        colors[i * 4 + 2] = (color & 0xff) / 255;         // B
        colors[i * 4 + 3] = 1.0;                          // A
    }
    return colors;
}
