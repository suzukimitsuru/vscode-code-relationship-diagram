/**
 * Dagre Layout Calculation (Extension-side)
 *
 * 拡張機能側でDagreレイアウトを計算することで、Webview側のUIフリーズを防ぎます。
 * Node.js環境で実行されるため、大規模なグラフでも安定して計算できます。
 */

import * as dagre from 'dagre';

/**
 * レイアウト計算オプション
 */
export interface LayoutOptions {
    rankDir?: 'TB' | 'BT' | 'LR' | 'RL';  // 方向
    nodeSep?: number;   // ノード間の水平間隔
    rankSep?: number;   // ランク間の垂直間隔
    ranker?: 'network-simplex' | 'tight-tree' | 'longest-path';  // ランキングアルゴリズム
}

/**
 * ノードの位置情報
 */
export interface Position {
    x: number;
    y: number;
}

/**
 * ノード情報（最小限の情報）
 */
export interface LayoutNode {
    id: string;
    label: string;
    kind?: number;  // VSCode SymbolKind
}

/**
 * エッジ情報
 */
export interface LayoutEdge {
    source: string;
    target: string;
}

/**
 * プログレスコールバック関数の型
 */
export type ProgressCallback = (percent: number, message: string) => void;

/**
 * ノードの幅を推定（ピクセル単位）
 * @param node ノード情報
 * @returns 推定幅（ピクセル）
 */
function estimateNodeWidth(node: LayoutNode): number {
    const label = node.label;
    const fontSize = node.kind === 0 ? 14 : 12;  // ファイルノードは大きめ
    const avgCharWidth = fontSize * 0.6;  // 英数字の平均幅
    const padding = node.kind === 0 ? 40 : 30;

    // 日本語文字は幅が広い（全角）
    const japaneseChars = (label.match(/[\u3040-\u30ff\u4e00-\u9faf]/g) || []).length;
    const otherChars = label.length - japaneseChars;

    const estimatedWidth = japaneseChars * fontSize + otherChars * avgCharWidth;
    return Math.max(node.kind === 0 ? 100 : 80, estimatedWidth + padding);
}

/**
 * ノードの高さを推定（ピクセル単位）
 * @param node ノード情報
 * @returns 推定高さ（ピクセル）
 */
function estimateNodeHeight(node: LayoutNode): number {
    // ファイルノード（kind=0）は大きめ、その他のシンボルは小さめ
    return node.kind === 0 ? 50 : 40;
}

/**
 * Dagreレイアウトを計算
 *
 * @param nodes ノード配列
 * @param edges エッジ配列
 * @param options レイアウトオプション
 * @param progressCallback プログレス通知コールバック（オプション）
 * @param signal キャンセル用のAbortSignal（オプション）
 * @returns 各ノードIDと座標のマップ
 */
export async function calculateDagreLayout(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    options: LayoutOptions = {},
    progressCallback?: ProgressCallback,
    signal?: AbortSignal
): Promise<Map<string, Position>> {
    const startTime = Date.now();

    // デフォルトオプション
    const rankDir = options.rankDir || 'TB';
    const nodeSep = options.nodeSep || 50;
    const rankSep = options.rankSep || 100;
    const ranker = options.ranker || 'tight-tree';  // tight-treeはnetwork-simplexより高速

    if (progressCallback) {
        progressCallback(0, 'Initializing Dagre graph...');
    }

    // グラフを作成
    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: rankDir,
        nodesep: nodeSep,
        ranksep: rankSep,
        ranker: ranker
    });
    g.setDefaultEdgeLabel(() => ({}));

    if (signal?.aborted) {
        throw new Error('Layout calculation cancelled');
    }

    if (progressCallback) {
        progressCallback(10, `Registering ${nodes.length} nodes...`);
    }

    // ノードを登録（幅と高さを推定）
    for (let i = 0; i < nodes.length; i++) {
        if (signal?.aborted) {
            throw new Error('Layout calculation cancelled');
        }

        const node = nodes[i];
        g.setNode(node.id, {
            label: node.label,
            width: estimateNodeWidth(node),
            height: estimateNodeHeight(node)
        });

        // 進捗通知（1000ノードごと）
        if (progressCallback && i > 0 && i % 1000 === 0) {
            const percent = 10 + (i / nodes.length) * 20;
            progressCallback(percent, `Registered ${i}/${nodes.length} nodes...`);
        }
    }

    if (signal?.aborted) {
        throw new Error('Layout calculation cancelled');
    }

    if (progressCallback) {
        progressCallback(30, `Registering ${edges.length} edges...`);
    }

    // エッジを登録
    for (let i = 0; i < edges.length; i++) {
        if (signal?.aborted) {
            throw new Error('Layout calculation cancelled');
        }

        const edge = edges[i];
        g.setEdge(edge.source, edge.target);

        // 進捗通知（1000エッジごと）
        if (progressCallback && i > 0 && i % 1000 === 0) {
            const percent = 30 + (i / edges.length) * 10;
            progressCallback(percent, `Registered ${i}/${edges.length} edges...`);
        }
    }

    if (signal?.aborted) {
        throw new Error('Layout calculation cancelled');
    }

    if (progressCallback) {
        progressCallback(40, 'Computing layout...');
    }

    // レイアウトを計算（同期処理だが、Node.jsのメインスレッドで実行）
    // この処理は時間がかかる可能性がある
    dagre.layout(g);

    if (signal?.aborted) {
        throw new Error('Layout calculation cancelled');
    }

    if (progressCallback) {
        progressCallback(80, 'Extracting positions...');
    }

    // 座標を取得
    const positions = new Map<string, Position>();
    const nodeIds = g.nodes();

    for (let i = 0; i < nodeIds.length; i++) {
        if (signal?.aborted) {
            throw new Error('Layout calculation cancelled');
        }

        const nodeId = nodeIds[i];
        const node = g.node(nodeId);

        // Dagreが返す座標はノードの中心位置
        positions.set(nodeId, {
            x: node.x,
            y: node.y
        });

        // 進捗通知（1000ノードごと）
        if (progressCallback && i > 0 && i % 1000 === 0) {
            const percent = 80 + (i / nodeIds.length) * 15;
            progressCallback(percent, `Extracted ${i}/${nodeIds.length} positions...`);
        }
    }

    const elapsed = (Date.now() - startTime) / 1000;

    if (progressCallback) {
        progressCallback(95, `Layout calculation completed in ${elapsed.toFixed(2)}s`);
    }

    console.log(`[DagreLayout] Calculated positions for ${positions.size} nodes in ${elapsed.toFixed(2)}s`);
    console.log(`[DagreLayout] Options: rankDir=${rankDir}, nodeSep=${nodeSep}, rankSep=${rankSep}, ranker=${ranker}`);

    return positions;
}

/**
 * エッジのルーティングパスを取得（オプション機能）
 *
 * Dagreはエッジのルーティングパスも計算します。
 * 必要に応じてこの情報も取得できます。
 *
 * @param nodes ノード配列
 * @param edges エッジ配列
 * @param options レイアウトオプション
 * @returns エッジIDとパスポイントのマップ
 */
export async function calculateEdgePaths(
    nodes: LayoutNode[],
    edges: LayoutEdge[],
    options: LayoutOptions = {}
): Promise<Map<string, Position[]>> {
    const rankDir = options.rankDir || 'TB';
    const nodeSep = options.nodeSep || 50;
    const rankSep = options.rankSep || 100;
    const ranker = options.ranker || 'tight-tree';

    const g = new dagre.graphlib.Graph();
    g.setGraph({
        rankdir: rankDir,
        nodesep: nodeSep,
        ranksep: rankSep,
        ranker: ranker
    });
    g.setDefaultEdgeLabel(() => ({}));

    // ノードを登録
    nodes.forEach(node => {
        g.setNode(node.id, {
            label: node.label,
            width: estimateNodeWidth(node),
            height: estimateNodeHeight(node)
        });
    });

    // エッジを登録
    edges.forEach(edge => {
        g.setEdge(edge.source, edge.target);
    });

    // レイアウト計算
    dagre.layout(g);

    // エッジパスを取得
    const edgePaths = new Map<string, Position[]>();
    g.edges().forEach(edgeObj => {
        const edge = g.edge(edgeObj);
        const edgeId = `${edgeObj.v}-${edgeObj.w}`;

        if (edge.points) {
            edgePaths.set(edgeId, edge.points.map(p => ({ x: p.x, y: p.y })));
        }
    });

    return edgePaths;
}
