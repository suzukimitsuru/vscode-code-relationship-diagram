/**
 * Cosmos.gl Adapter
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
}

/**
 * 色定義（ノードレベル別）
 */
const NODE_COLORS = {
    directory: 0x4a9eff,  // 青
    file: 0x7cb342,       // 緑
    symbol: 0xff9800,     // オレンジ
};

/**
 * リンク色（#3498DB - graph-view.htmlと同じ青）
 */
const LINK_COLOR = 0x3498DB;

/**
 * コミュニティカラーパレット
 */
const COMMUNITY_COLORS = [
    0xe53935, 0x1e88e5, 0x43a047, 0xfb8c00, 0x8e24aa,
    0x00acc1, 0xffb300, 0x5e35b1, 0x00897b, 0xd81b60,
];

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

    // 1. ディレクトリノードを生成
    const directoryNodes = new Map<string, CosmosNode>();
    for (const symbol of symbols) {
        if (symbol.kind === vscode.SymbolKind.File) {
            const dirPath = path.dirname(symbol.path);
            collectDirectories(dirPath, directoryNodes, directorySet);
        }
    }

    // ディレクトリノードを追加
    for (const [dirPath, dirNode] of directoryNodes) {
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
                id: symbol.id,
                x: 0,
                y: 0,
                size: calculateFileSize(symbol),
                color: communityId !== undefined
                    ? COMMUNITY_COLORS[communityId % COMMUNITY_COLORS.length]
                    : NODE_COLORS.file,
                parentId: parentId,
                level: 'file',
                label: path.basename(symbol.path),
                path: symbol.path,
                kind: symbol.kind,
                line: symbol.define.line,
                communityId: communityId,
                childCount: countSymbols(symbol),
                visible: true,
            };

            fileNodes.set(symbol.path, fileNode);
            nodeIndex.set(fileNode.id, nodes.length);
            nodes.push(fileNode);

            // ディレクトリの子ノード数を更新
            const dirNode = directoryNodes.get(dirPath);
            if (dirNode) {
                dirNode.childCount++;
            }
        }
    }

    // 3. シンボルノードを生成
    for (const symbol of symbols) {
        if (symbol.kind !== vscode.SymbolKind.File) {
            const symbolNode: CosmosNode = {
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
                });
            }
        }
    }

    return {
        nodes,
        links,
        nodeIndex,
        directories: Array.from(directorySet).sort(),
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
    };

    directoryNodes.set(dirPath, dirNode);

    // 親ディレクトリも再帰的に収集
    if (parentPath !== '.' && parentPath !== '') {
        collectDirectories(parentPath, directoryNodes, directorySet);
    }
}

/**
 * ファイルサイズを計算（シンボル数に基づく）
 */
function calculateFileSize(fileSymbol: SYMBOL.SymbolModel): number {
    const symbolCount = countSymbols(fileSymbol);
    // 10-50の範囲でスケール
    return Math.min(10 + Math.sqrt(symbolCount) * 5, 50);
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

        const key = `${sourcePath}|||${targetPath}`;
        const reverseKey = `${targetPath}|||${sourcePath}`;

        // 双方向をまとめる
        const actualKey = fileRelations.has(key) ? key :
                          fileRelations.has(reverseKey) ? reverseKey : key;

        if (!fileRelations.has(actualKey)) {
            fileRelations.set(actualKey, []);
        }

        const sourceSymbol = symbolIndex.get(rel.reference.id);
        const targetSymbol = symbolIndex.get(rel.define.id);

        fileRelations.get(actualKey)!.push({
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
