/**
 * Community Detection using Louvain Algorithm
 *
 * graphology-communities-louvain を使用してグラフのコミュニティ検出を行います。
 * 検出されたコミュニティは CiSE レイアウトのクラスタ情報として使用されます。
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

/**
 * コミュニティ検出結果
 */
export interface CommunityResult {
    /** ノードID -> コミュニティID のマッピング */
    communities: Map<string, number>;
    /** コミュニティ数 */
    communityCount: number;
    /** モジュラリティスコア（品質指標、0-1の範囲で高いほど良い） */
    modularity: number;
    /** 各コミュニティのノード数 */
    communitySizes: Map<number, number>;
}

/**
 * コミュニティ検出オプション
 */
export interface CommunityOptions {
    /** 解像度パラメータ（高いほど多くのコミュニティに分割、デフォルト: 1） */
    resolution?: number;
    /** ランダムウォークを使用するか（デフォルト: true） */
    randomWalk?: boolean;
    /** 重み属性名（エッジに重みがある場合） */
    weightAttribute?: string;
}

/**
 * ノード情報（コミュニティ検出用）
 */
export interface CommunityNode {
    id: string;
    label: string;
    kind?: number;  // VSCode SymbolKind (-1: directory, 0: file, others: symbols)
}

/**
 * エッジ情報（コミュニティ検出用）
 */
export interface CommunityEdge {
    source: string;
    target: string;
    weight?: number;
}

/**
 * コミュニティごとの色を生成
 * 視認性の高い色のパレットを使用
 */
export function generateCommunityColors(communityCount: number): Map<number, string> {
    // 視認性の高いカラーパレット（最大20色）
    const palette = [
        '#E53935',  // Red
        '#1E88E5',  // Blue
        '#43A047',  // Green
        '#FB8C00',  // Orange
        '#8E24AA',  // Purple
        '#00ACC1',  // Cyan
        '#FFB300',  // Amber
        '#5E35B1',  // Deep Purple
        '#00897B',  // Teal
        '#D81B60',  // Pink
        '#3949AB',  // Indigo
        '#7CB342',  // Light Green
        '#F4511E',  // Deep Orange
        '#039BE5',  // Light Blue
        '#C0CA33',  // Lime
        '#6D4C41',  // Brown
        '#546E7A',  // Blue Grey
        '#EC407A',  // Pink Light
        '#26A69A',  // Teal Light
        '#AB47BC',  // Purple Light
    ];

    const colors = new Map<number, string>();
    for (let i = 0; i < communityCount; i++) {
        colors.set(i, palette[i % palette.length]);
    }
    return colors;
}

/**
 * Louvainアルゴリズムでコミュニティを検出
 *
 * @param nodes ノード配列
 * @param edges エッジ配列
 * @param options コミュニティ検出オプション
 * @returns コミュニティ検出結果
 */
export function detectCommunities(
    nodes: CommunityNode[],
    edges: CommunityEdge[],
    options: CommunityOptions = {}
): CommunityResult {
    const startTime = Date.now();

    // graphologyグラフを構築
    const graph = new Graph({ type: 'undirected', allowSelfLoops: false });

    // ノードを追加
    for (const node of nodes) {
        if (!graph.hasNode(node.id)) {
            graph.addNode(node.id, {
                label: node.label,
                kind: node.kind
            });
        }
    }

    // エッジを追加（重複を避ける）
    const addedEdges = new Set<string>();
    for (const edge of edges) {
        // ソースまたはターゲットがグラフに存在しない場合はスキップ
        if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) {
            continue;
        }

        // 自己ループは除外
        if (edge.source === edge.target) {
            continue;
        }

        // 重複エッジは除外（無向グラフなので両方向チェック）
        const edgeKey1 = `${edge.source}->${edge.target}`;
        const edgeKey2 = `${edge.target}->${edge.source}`;
        if (addedEdges.has(edgeKey1) || addedEdges.has(edgeKey2)) {
            continue;
        }

        addedEdges.add(edgeKey1);
        graph.addEdge(edge.source, edge.target, {
            weight: edge.weight || 1
        });
    }

    console.log(`[CommunityDetection] Graph built: ${graph.order} nodes, ${graph.size} edges`);

    // Louvainアルゴリズムでコミュニティ検出
    const louvainOptions: {
        resolution?: number;
        randomWalk?: boolean;
        getEdgeWeight?: string | ((edge: string) => number);
    } = {};

    if (options.resolution !== undefined) {
        louvainOptions.resolution = options.resolution;
    }
    if (options.randomWalk !== undefined) {
        louvainOptions.randomWalk = options.randomWalk;
    }
    if (options.weightAttribute) {
        louvainOptions.getEdgeWeight = options.weightAttribute;
    }

    // コミュニティ検出を実行
    const communityAssignment = louvain(graph, louvainOptions);

    // 結果をMapに変換
    const communities = new Map<string, number>();
    const communitySizes = new Map<number, number>();
    let maxCommunityId = -1;

    for (const [nodeId, communityId] of Object.entries(communityAssignment)) {
        communities.set(nodeId, communityId);
        communitySizes.set(communityId, (communitySizes.get(communityId) || 0) + 1);
        if (communityId > maxCommunityId) {
            maxCommunityId = communityId;
        }
    }

    const communityCount = maxCommunityId + 1;

    // モジュラリティスコアを計算
    const modularity = louvain.detailed(graph, louvainOptions).modularity;

    const elapsed = (Date.now() - startTime) / 1000;
    console.log(`[CommunityDetection] Detected ${communityCount} communities in ${elapsed.toFixed(3)}s`);
    console.log(`[CommunityDetection] Modularity: ${modularity.toFixed(4)}`);
    console.log(`[CommunityDetection] Community sizes: ${Array.from(communitySizes.entries()).map(([id, size]) => `C${id}:${size}`).join(', ')}`);

    return {
        communities,
        communityCount,
        modularity,
        communitySizes
    };
}

/**
 * CiSEレイアウト用のクラスタ情報を生成
 *
 * @param communities コミュニティ検出結果
 * @returns CiSEレイアウト用のクラスタ配列（2D配列形式）
 */
export function generateCiseClusters(communities: Map<string, number>): string[][] {
    const clusterMap = new Map<number, string[]>();

    for (const [nodeId, communityId] of communities.entries()) {
        if (!clusterMap.has(communityId)) {
            clusterMap.set(communityId, []);
        }
        clusterMap.get(communityId)!.push(nodeId);
    }

    // コミュニティIDの順序でソートして配列に変換
    const sortedIds = Array.from(clusterMap.keys()).sort((a, b) => a - b);
    return sortedIds.map(id => clusterMap.get(id)!);
}

/**
 * コミュニティノード（折りたたみ用の親ノード）を生成
 *
 * @param communityResult コミュニティ検出結果
 * @param communityColors コミュニティ色マップ
 * @returns コミュニティノードの配列
 */
export function generateCommunityNodes(
    communityResult: CommunityResult,
    communityColors: Map<number, string>
): Array<{
    data: {
        id: string;
        label: string;
        isCommunity: boolean;
        communityId: number;
        memberCount: number;
        color: string;
    }
}> {
    const communityNodes = [];

    for (const [communityId, size] of communityResult.communitySizes.entries()) {
        communityNodes.push({
            data: {
                id: `community-${communityId}`,
                label: `Community ${communityId + 1} (${size} nodes)`,
                isCommunity: true,
                communityId: communityId,
                memberCount: size,
                color: communityColors.get(communityId) || '#888888'
            }
        });
    }

    return communityNodes;
}

/**
 * ファイルレベルのノードのみを抽出（コミュニティ検出用）
 *
 * @param elements ノード配列
 * @returns ファイルノードのみの配列
 */
export function extractFileNodes(elements: { nodes: Array<{ data: { id: string; label: string; kind?: number } }> }): CommunityNode[] {
    return elements.nodes
        .filter(n => n.data.kind === 0 || n.data.kind === undefined)  // ファイルノード
        .map(n => ({
            id: n.data.id,
            label: n.data.label,
            kind: n.data.kind
        }));
}

/**
 * ファイル間のエッジのみを抽出（コミュニティ検出用）
 *
 * @param elements エッジ配列
 * @param fileNodeIds ファイルノードIDのセット
 * @returns ファイル間エッジの配列
 */
export function extractFileEdges(
    elements: { edges: Array<{ data: { source: string; target: string; weight?: number } }> },
    fileNodeIds: Set<string>
): CommunityEdge[] {
    return elements.edges
        .filter(e => fileNodeIds.has(e.data.source) && fileNodeIds.has(e.data.target))
        .map(e => ({
            source: e.data.source,
            target: e.data.target,
            weight: e.data.weight || 1
        }));
}

// ========================================
// 階層的（再帰的）コミュニティ検出
// ========================================

/**
 * 階層的コミュニティ構造
 */
export interface HierarchicalCommunity {
    /** コミュニティID（階層パス: "0", "0.1", "0.1.2" など） */
    id: string;
    /** 親コミュニティID（ルートの場合はnull） */
    parentId: string | null;
    /** このコミュニティに直接含まれるノードID */
    nodeIds: string[];
    /** 子コミュニティ（再帰的） */
    children: HierarchicalCommunity[];
    /** コミュニティの深さ（ルート=0） */
    depth: number;
    /** コミュニティの重心位置（レイアウト計算後に設定） */
    position?: { x: number, y: number };
    /** コミュニティの色 */
    color?: string;
}

/**
 * 階層的コミュニティ検出結果
 */
export interface HierarchicalCommunityResult {
    /** ルートコミュニティ（全体を包含） */
    root: HierarchicalCommunity;
    /** 全コミュニティのフラットリスト */
    allCommunities: HierarchicalCommunity[];
    /** ノードID -> 所属コミュニティID のマッピング（最深層） */
    nodeToCommunity: Map<string, string>;
    /** 最大深さ */
    maxDepth: number;
}

/**
 * 再帰的コミュニティ検出オプション
 */
export interface RecursiveCommunityOptions {
    /** コミュニティ分割を停止するノード数の閾値（デフォルト: 5） */
    minCommunitySize?: number;
    /** 最大再帰深さ（デフォルト: 5） */
    maxDepth?: number;
    /** サブコミュニティ検出時のモジュラリティ閾値（デフォルト: 0.1） */
    minModularity?: number;
    /** Louvainの解像度パラメータ（デフォルト: 1.0） */
    resolution?: number;
}

/**
 * 再帰的にコミュニティを検出し、階層的コミュニティ構造を構築
 *
 * @param nodes ノード配列
 * @param edges エッジ配列
 * @param options オプション
 * @returns 階層的コミュニティ検出結果
 */
export function detectCommunitiesRecursive(
    nodes: CommunityNode[],
    edges: CommunityEdge[],
    options: RecursiveCommunityOptions = {}
): HierarchicalCommunityResult {
    const minCommunitySize = options.minCommunitySize ?? 5;
    const maxDepth = options.maxDepth ?? 5;
    const minModularity = options.minModularity ?? 0.1;
    const resolution = options.resolution ?? 1.0;

    console.log(`[RecursiveCommunity] Starting with ${nodes.length} nodes, ${edges.length} edges`);
    console.log(`[RecursiveCommunity] Options: minCommunitySize=${minCommunitySize}, maxDepth=${maxDepth}, minModularity=${minModularity}`);

    const allCommunities: HierarchicalCommunity[] = [];
    const nodeToCommunity = new Map<string, string>();

    // ルートコミュニティを作成
    const root: HierarchicalCommunity = {
        id: 'root',
        parentId: null,
        nodeIds: nodes.map(n => n.id),
        children: [],
        depth: 0
    };

    // 再帰的にコミュニティを検出
    function detectRecursive(
        community: HierarchicalCommunity,
        communityNodes: CommunityNode[],
        communityEdges: CommunityEdge[],
        depth: number
    ): void {
        // 終了条件チェック
        if (communityNodes.length <= minCommunitySize) {
            console.log(`[RecursiveCommunity] Community ${community.id}: ${communityNodes.length} nodes (below threshold, stopping)`);
            // 最終コミュニティとして登録
            communityNodes.forEach(n => nodeToCommunity.set(n.id, community.id));
            allCommunities.push(community);
            return;
        }

        if (depth >= maxDepth) {
            console.log(`[RecursiveCommunity] Community ${community.id}: max depth reached (${depth})`);
            communityNodes.forEach(n => nodeToCommunity.set(n.id, community.id));
            allCommunities.push(community);
            return;
        }

        // このコミュニティ内でLouvainを実行
        const result = detectCommunities(communityNodes, communityEdges, { resolution });

        // サブコミュニティが1つのみ、またはモジュラリティが低い場合は終了
        if (result.communityCount <= 1 || result.modularity < minModularity) {
            console.log(`[RecursiveCommunity] Community ${community.id}: no significant sub-communities (count=${result.communityCount}, modularity=${result.modularity.toFixed(3)})`);
            communityNodes.forEach(n => nodeToCommunity.set(n.id, community.id));
            allCommunities.push(community);
            return;
        }

        console.log(`[RecursiveCommunity] Community ${community.id}: found ${result.communityCount} sub-communities (modularity=${result.modularity.toFixed(3)})`);

        // サブコミュニティを作成
        const subCommunityMap = new Map<number, CommunityNode[]>();
        for (const node of communityNodes) {
            const subCommunityId = result.communities.get(node.id);
            if (subCommunityId !== undefined) {
                if (!subCommunityMap.has(subCommunityId)) {
                    subCommunityMap.set(subCommunityId, []);
                }
                subCommunityMap.get(subCommunityId)!.push(node);
            }
        }

        // 各サブコミュニティに対して再帰
        let subIndex = 0;
        for (const [, subNodes] of subCommunityMap.entries()) {
            const childCommunity: HierarchicalCommunity = {
                id: community.id === 'root' ? `${subIndex}` : `${community.id}.${subIndex}`,
                parentId: community.id,
                nodeIds: subNodes.map(n => n.id),
                children: [],
                depth: depth + 1
            };

            community.children.push(childCommunity);

            // サブコミュニティ内のエッジを抽出
            const subNodeIds = new Set(subNodes.map(n => n.id));
            const subEdges = communityEdges.filter(e =>
                subNodeIds.has(e.source) && subNodeIds.has(e.target)
            );

            // 再帰
            detectRecursive(childCommunity, subNodes, subEdges, depth + 1);
            subIndex++;
        }
    }

    // ルートから再帰開始
    detectRecursive(root, nodes, edges, 0);

    // 最大深さを計算
    let maxDepthFound = 0;
    for (const community of allCommunities) {
        if (community.depth > maxDepthFound) {
            maxDepthFound = community.depth;
        }
    }

    console.log(`[RecursiveCommunity] Complete: ${allCommunities.length} leaf communities, maxDepth=${maxDepthFound}`);

    return {
        root,
        allCommunities,
        nodeToCommunity,
        maxDepth: maxDepthFound
    };
}

/**
 * 階層的コミュニティの色を生成
 * 同じ親を持つコミュニティは似た色相を持つ
 */
export function generateHierarchicalColors(result: HierarchicalCommunityResult): Map<string, string> {
    const colors = new Map<string, string>();
    const palette = [
        '#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA',
        '#00ACC1', '#FFB300', '#5E35B1', '#00897B', '#D81B60',
        '#3949AB', '#7CB342', '#F4511E', '#039BE5', '#C0CA33',
        '#6D4C41', '#546E7A', '#EC407A', '#26A69A', '#AB47BC'
    ];

    function assignColors(community: HierarchicalCommunity, baseHue: number, hueRange: number): void {
        if (community.children.length === 0) {
            // 葉コミュニティには色を割り当て
            const index = result.allCommunities.indexOf(community);
            colors.set(community.id, palette[index % palette.length]);
        } else {
            // 子コミュニティに色相を分配
            const childHueStep = hueRange / community.children.length;
            community.children.forEach((child: HierarchicalCommunity, i: number) => {
                assignColors(child, baseHue + i * childHueStep, childHueStep);
            });
        }
    }

    assignColors(result.root, 0, 360);
    return colors;
}

/**
 * 指定された深さのコミュニティを取得
 */
export function getCommunitiesAtDepth(root: HierarchicalCommunity, targetDepth: number): HierarchicalCommunity[] {
    const communities: HierarchicalCommunity[] = [];

    function traverse(community: HierarchicalCommunity): void {
        if (community.depth === targetDepth) {
            communities.push(community);
        } else if (community.depth < targetDepth) {
            if (community.children.length > 0) {
                community.children.forEach(traverse);
            } else {
                // 葉コミュニティで目標深さに達していない場合、そのコミュニティを含める
                communities.push(community);
            }
        }
    }

    traverse(root);
    return communities;
}

/**
 * 階層的コミュニティ結果からトップレベル（depth=1）のコミュニティマッピングを抽出
 * 色付け用に使用（各ノードがどのトップレベルコミュニティに属するか）
 *
 * @param result 階層的コミュニティ検出結果
 * @returns ノードID -> トップレベルコミュニティインデックス（0始まり）のマッピング
 */
export function extractTopLevelCommunityMapping(result: HierarchicalCommunityResult): {
    communities: Map<string, number>;
    communityCount: number;
    communitySizes: Map<number, number>;
} {
    const communities = new Map<string, number>();
    const communitySizes = new Map<number, number>();

    // トップレベル（depth=1）のコミュニティを取得
    const topLevelCommunities = getCommunitiesAtDepth(result.root, 1);

    // 各トップレベルコミュニティに数値インデックスを割り当て
    topLevelCommunities.forEach((community, index) => {
        // このコミュニティ配下の全ノードを取得
        const allNodesInCommunity = getAllNodesInCommunity(community);
        allNodesInCommunity.forEach(nodeId => {
            communities.set(nodeId, index);
        });
        communitySizes.set(index, allNodesInCommunity.length);
    });

    console.log(`[TopLevelMapping] Extracted ${topLevelCommunities.length} top-level communities from hierarchical result`);
    console.log(`[TopLevelMapping] Community sizes: ${Array.from(communitySizes.entries()).map(([id, size]) => `C${id}:${size}`).join(', ')}`);

    return {
        communities,
        communityCount: topLevelCommunities.length,
        communitySizes
    };
}

/**
 * コミュニティ配下の全ノードIDを再帰的に取得
 */
function getAllNodesInCommunity(community: HierarchicalCommunity): string[] {
    if (community.children.length === 0) {
        // 葉コミュニティの場合、直接のノードIDを返す
        return community.nodeIds;
    }

    // 子コミュニティのノードを再帰的に収集
    const allNodes: string[] = [];
    for (const child of community.children) {
        allNodes.push(...getAllNodesInCommunity(child));
    }
    return allNodes;
}

/**
 * 階層的コミュニティ結果からCiSEレイアウト用のクラスタ配列を生成
 * トップレベルコミュニティをクラスタとして使用
 *
 * @param result 階層的コミュニティ検出結果
 * @returns CiSEレイアウト用のクラスタ配列（2D配列形式）
 */
export function generateCiseClustersFromHierarchical(result: HierarchicalCommunityResult): string[][] {
    const topLevelCommunities = getCommunitiesAtDepth(result.root, 1);

    return topLevelCommunities.map(community => getAllNodesInCommunity(community));
}
