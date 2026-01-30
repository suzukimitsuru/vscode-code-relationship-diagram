/**
 * CiSE Layout Calculator (Extension Side)
 *
 * Node.js環境でCytoscape.jsをheadlessモードで実行し、
 * CiSEレイアウトを計算してノード座標を返す
 *
 * 階層的クラスタレイアウト機能:
 * - クラスタ間の引力・斥力を計算
 * - クラスタ内部でも再帰的にレイアウトを適用
 */

import { Logs } from '../logs';
import { HierarchicalCommunity, HierarchicalCommunityResult, CommunityEdge } from './communityDetection';

// Cytoscape.jsとCiSE拡張をNode.js環境で読み込み（遅延ロード）
let cytoscape: any = null;
let cytoscapeInitialized = false;

/**
 * Cytoscapeを遅延初期化
 * activate時ではなく、実際に使用する時に初めてロードする
 */
function initCytoscape(): any {
    if (!cytoscapeInitialized) {
        cytoscape = require('cytoscape');
        const cise = require('cytoscape-cise');
        cytoscape.use(cise);
        cytoscapeInitialized = true;
    }
    return cytoscape;
}

/**
 * レイアウト計算結果
 */
export interface LayoutPosition {
    id: string;
    x: number;
    y: number;
}

/**
 * CiSEレイアウト計算オプション
 */
export interface CiSELayoutOptions {
    /** クラスタ配列 */
    clusters: string[][];
    /** ノード間隔 */
    nodeSeparation?: number;
    /** クラスタ間エッジ長係数 */
    idealInterClusterEdgeLengthCoefficient?: number;
    /** スプリング係数 */
    springCoeff?: number;
    /** ノード反発力 */
    nodeRepulsion?: number;
    /** 重力 */
    gravity?: number;
    /** 重力範囲 */
    gravityRange?: number;
}

/**
 * 拡張機能側でCiSEレイアウトを計算
 *
 * @param nodes ノードデータ配列
 * @param edges エッジデータ配列
 * @param options レイアウトオプション
 * @param logs ログ出力
 * @returns 計算されたノード座標の配列
 */
export async function calculateCiSELayout(
    nodes: any[],
    edges: any[],
    options: CiSELayoutOptions,
    logs: Logs
): Promise<LayoutPosition[]> {
    const startTime = performance.now();
    logs.log(`[CiSE Layout] Starting calculation for ${nodes.length} nodes, ${edges.length} edges`);
    logs.log(`[CiSE Layout] Clusters: ${options.clusters.length}`);

    return new Promise((resolve, reject) => {
        try {
            // Cytoscape.jsをheadlessモードで初期化（遅延ロード）
            const cy = initCytoscape()({
                headless: true,
                styleEnabled: true,  // レイアウト計算にはスタイル情報が必要
                elements: {
                    nodes: nodes,
                    edges: edges
                }
            });

            logs.log(`[CiSE Layout] Cytoscape instance created: ${cy.nodes().length} nodes, ${cy.edges().length} edges`);

            // CiSEレイアウトを実行
            const layout = cy.layout({
                name: 'cise',
                clusters: options.clusters,
                animate: false,  // アニメーションなし（計算のみ）
                fit: true,
                padding: 50,
                nodeSeparation: options.nodeSeparation ?? 15,
                idealInterClusterEdgeLengthCoefficient: options.idealInterClusterEdgeLengthCoefficient ?? 3.5,
                allowNodesInsideCircle: false,
                maxRatioOfNodesInsideCircle: 0.1,
                springCoeff: options.springCoeff ?? 0.35,
                nodeRepulsion: options.nodeRepulsion ?? 12000,
                gravity: options.gravity ?? 0.15,
                gravityRange: options.gravityRange ?? 4.5,
                ready: function() {
                    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
                    logs.log(`[CiSE Layout] Layout ready: ${elapsed}s`);
                },
                stop: function() {
                    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
                    logs.log(`[CiSE Layout] Layout stop: ${elapsed}s`);

                    // 計算されたノード座標を取得
                    const positions: LayoutPosition[] = [];
                    cy.nodes().forEach((node: any) => {
                        const pos = node.position();
                        positions.push({
                            id: node.id(),
                            x: pos.x,
                            y: pos.y
                        });
                    });

                    logs.log(`[CiSE Layout] Extracted ${positions.length} node positions`);

                    // Cytoscapeインスタンスを破棄
                    cy.destroy();

                    const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(3);
                    logs.log(`[CiSE Layout] Calculation complete: ${totalElapsed}s`);

                    resolve(positions);
                }
            });

            // レイアウト実行
            logs.log(`[CiSE Layout] Running layout...`);
            layout.run();

        } catch (error) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
            logs.error(`[CiSE Layout] Error after ${elapsed}s: ${error instanceof Error ? error.message : error}`);
            reject(error);
        }
    });
}

/**
 * 全レベルのレイアウト座標
 */
export interface AllLevelPositions {
    'dir-only': LayoutPosition[];
    'dir-file': LayoutPosition[];
    'file-only': LayoutPosition[];
    'file-symbol': LayoutPosition[];
}

/**
 * ファイル座標から全レベルの座標を導出
 *
 * @param filePositions ファイルレベルで計算された座標
 * @param allNodes 全ノードデータ
 * @param logs ログ出力
 * @returns 全レベルの座標
 */
export function deriveAllLevelPositions(
    filePositions: LayoutPosition[],
    allNodes: any[],
    logs: Logs
): AllLevelPositions {
    const startTime = performance.now();
    logs.log(`[Derive Positions] Starting derivation from ${filePositions.length} file positions`);

    // ファイル座標をMapに変換（高速検索用）
    const filePositionMap = new Map<string, { x: number, y: number }>();
    filePositions.forEach(pos => {
        filePositionMap.set(pos.id, { x: pos.x, y: pos.y });
    });

    // ノードを分類
    const fileNodes = allNodes.filter(n => n.data.kind === 0);
    const symbolNodes = allNodes.filter(n => n.data.kind > 0);
    logs.log(`[Derive Positions] Nodes: ${fileNodes.length} files, ${symbolNodes.length} symbols`);

    // 1. ディレクトリ座標を導出（ファイル座標の重心）
    const dirPositions = deriveDirectoryPositions(fileNodes, filePositionMap, logs);

    // 2. dir-only: ディレクトリのみ
    const dirOnlyPositions: LayoutPosition[] = Array.from(dirPositions.entries()).map(([id, pos]) => ({
        id,
        x: pos.x,
        y: pos.y
    }));
    logs.log(`[Derive Positions] dir-only: ${dirOnlyPositions.length} positions`);

    // 3. dir-file: ディレクトリ + ファイル
    const dirFilePositions: LayoutPosition[] = [
        ...dirOnlyPositions,
        ...filePositions
    ];
    logs.log(`[Derive Positions] dir-file: ${dirFilePositions.length} positions`);

    // 4. file-only: ファイルのみ（計算済み座標をそのまま使用）
    const fileOnlyPositions: LayoutPosition[] = [...filePositions];
    logs.log(`[Derive Positions] file-only: ${fileOnlyPositions.length} positions`);

    // 5. file-symbol: ファイル + シンボル（シンボルは親ファイルの周囲に配置）
    const symbolPositions = deriveSymbolPositions(symbolNodes, filePositionMap, logs);
    const fileSymbolPositions: LayoutPosition[] = [
        ...filePositions,
        ...symbolPositions
    ];
    logs.log(`[Derive Positions] file-symbol: ${fileSymbolPositions.length} positions`);

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
    logs.log(`[Derive Positions] Derivation complete: ${elapsed}s`);

    return {
        'dir-only': dirOnlyPositions,
        'dir-file': dirFilePositions,
        'file-only': fileOnlyPositions,
        'file-symbol': fileSymbolPositions
    };
}

/**
 * ファイル座標からディレクトリ座標を導出（重心計算）
 */
function deriveDirectoryPositions(
    fileNodes: any[],
    filePositionMap: Map<string, { x: number, y: number }>,
    logs: Logs
): Map<string, { x: number, y: number }> {
    // ディレクトリごとにファイルをグループ化
    const dirToFiles = new Map<string, string[]>();

    fileNodes.forEach(node => {
        const filePath = node.data.path;
        const parts = filePath.split('/');
        parts.pop(); // ファイル名を除去

        // 各階層のディレクトリにファイルを追加
        for (let i = 1; i <= parts.length; i++) {
            const dirPath = parts.slice(0, i).join('/');
            const dirId = `dir:${dirPath}`;

            if (!dirToFiles.has(dirId)) {
                dirToFiles.set(dirId, []);
            }
            dirToFiles.get(dirId)!.push(node.data.id);
        }
    });

    logs.log(`[Derive Positions] Found ${dirToFiles.size} directories`);

    // 各ディレクトリの重心を計算
    const dirPositions = new Map<string, { x: number, y: number }>();

    dirToFiles.forEach((fileIds, dirId) => {
        let sumX = 0, sumY = 0, count = 0;

        fileIds.forEach(fileId => {
            const pos = filePositionMap.get(fileId);
            if (pos) {
                sumX += pos.x;
                sumY += pos.y;
                count++;
            }
        });

        if (count > 0) {
            dirPositions.set(dirId, {
                x: sumX / count,
                y: sumY / count
            });
        }
    });

    return dirPositions;
}

/**
 * ファイル座標からシンボル座標を導出（親ファイルの周囲に円形配置）
 */
function deriveSymbolPositions(
    symbolNodes: any[],
    filePositionMap: Map<string, { x: number, y: number }>,
    logs: Logs
): LayoutPosition[] {
    // 親ファイルごとにシンボルをグループ化
    const fileToSymbols = new Map<string, any[]>();

    symbolNodes.forEach(node => {
        const parentId = node.data.parent;
        if (parentId) {
            if (!fileToSymbols.has(parentId)) {
                fileToSymbols.set(parentId, []);
            }
            fileToSymbols.get(parentId)!.push(node);
        }
    });

    const positions: LayoutPosition[] = [];
    const BASE_RADIUS = 50;  // 基本半径
    const RADIUS_PER_SYMBOL = 5;  // シンボル数に応じた半径増加

    fileToSymbols.forEach((symbols, parentId) => {
        const parentPos = filePositionMap.get(parentId);
        if (!parentPos) {
            // 親ファイルの座標がない場合はランダム配置
            symbols.forEach((symbol, index) => {
                positions.push({
                    id: symbol.data.id,
                    x: Math.random() * 1000,
                    y: Math.random() * 1000
                });
            });
            return;
        }

        // シンボル数に応じて半径を調整
        const radius = BASE_RADIUS + symbols.length * RADIUS_PER_SYMBOL;

        // 円周上に均等配置
        symbols.forEach((symbol, index) => {
            const angle = (2 * Math.PI * index) / symbols.length;
            positions.push({
                id: symbol.data.id,
                x: parentPos.x + radius * Math.cos(angle),
                y: parentPos.y + radius * Math.sin(angle)
            });
        });
    });

    // 親がないシンボル（孤立シンボル）の処理
    const orphanSymbols = symbolNodes.filter(n => !n.data.parent);
    if (orphanSymbols.length > 0) {
        logs.log(`[Derive Positions] Warning: ${orphanSymbols.length} symbols without parent`);
        orphanSymbols.forEach(symbol => {
            positions.push({
                id: symbol.data.id,
                x: Math.random() * 1000,
                y: Math.random() * 1000
            });
        });
    }

    return positions;
}

/**
 * COSEフォールバックレイアウトを計算
 *
 * @param nodes ノードデータ配列
 * @param edges エッジデータ配列
 * @param logs ログ出力
 * @returns 計算されたノード座標の配列
 */
export async function calculateCOSELayout(
    nodes: any[],
    edges: any[],
    logs: Logs
): Promise<LayoutPosition[]> {
    const startTime = performance.now();
    logs.log(`[COSE Layout] Starting calculation for ${nodes.length} nodes, ${edges.length} edges`);

    return new Promise((resolve, reject) => {
        try {
            // Cytoscape.jsをheadlessモードで初期化（遅延ロード）
            const cy = initCytoscape()({
                headless: true,
                styleEnabled: true,
                elements: {
                    nodes: nodes,
                    edges: edges
                }
            });

            logs.log(`[COSE Layout] Cytoscape instance created`);

            // COSEレイアウトを実行
            const layout = cy.layout({
                name: 'cose',
                animate: false,
                fit: true,
                padding: 50,
                nodeRepulsion: function() { return 200000; },
                idealEdgeLength: function() { return 300; },
                edgeElasticity: function() { return 100; },
                gravity: 30,
                numIter: 1000,
                randomize: false,
                ready: function() {
                    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
                    logs.log(`[COSE Layout] Layout ready: ${elapsed}s`);
                },
                stop: function() {
                    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
                    logs.log(`[COSE Layout] Layout stop: ${elapsed}s`);

                    // 計算されたノード座標を取得
                    const positions: LayoutPosition[] = [];
                    cy.nodes().forEach((node: any) => {
                        const pos = node.position();
                        positions.push({
                            id: node.id(),
                            x: pos.x,
                            y: pos.y
                        });
                    });

                    logs.log(`[COSE Layout] Extracted ${positions.length} node positions`);

                    // Cytoscapeインスタンスを破棄
                    cy.destroy();

                    const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(3);
                    logs.log(`[COSE Layout] Calculation complete: ${totalElapsed}s`);

                    resolve(positions);
                }
            });

            // レイアウト実行
            logs.log(`[COSE Layout] Running layout...`);
            layout.run();

        } catch (error) {
            const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
            logs.error(`[COSE Layout] Error after ${elapsed}s: ${error instanceof Error ? error.message : error}`);
            reject(error);
        }
    });
}

// ========================================
// 階層的クラスタレイアウト
// ========================================

/**
 * 階層的レイアウトオプション
 */
export interface HierarchicalLayoutOptions {
    /** クラスタ間の間隔 */
    clusterSpacing?: number;
    /** クラスタ内のノード間隔 */
    nodeSpacing?: number;
    /** クラスタ間エッジの理想長 */
    interClusterEdgeLength?: number;
    /** クラスタ間の反発力 */
    clusterRepulsion?: number;
    /** 重力（中心への引力） */
    gravity?: number;
}

/**
 * コミュニティ位置情報
 */
interface CommunityPosition {
    communityId: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

/**
 * 階層的クラスタ間レイアウトを計算
 *
 * アルゴリズム:
 * 1. トップレベルのクラスタを仮想ノードとして扱い、クラスタ間のエッジで力学的レイアウトを計算
 * 2. 各クラスタ内で再帰的に同じ処理を実行
 * 3. 最終的にノード座標を算出
 *
 * @param hierarchicalResult 階層的コミュニティ検出結果
 * @param nodes 全ノードデータ
 * @param edges 全エッジデータ
 * @param options レイアウトオプション
 * @param logs ログ出力
 * @returns 計算されたノード座標の配列
 */
export async function calculateHierarchicalClusterLayout(
    hierarchicalResult: HierarchicalCommunityResult,
    nodes: any[],
    edges: CommunityEdge[],
    options: HierarchicalLayoutOptions,
    logs: Logs
): Promise<LayoutPosition[]> {
    const startTime = performance.now();
    logs.log(`[Hierarchical Layout] Starting calculation`);
    logs.log(`[Hierarchical Layout] Communities: ${hierarchicalResult.allCommunities.length}, Max depth: ${hierarchicalResult.maxDepth}`);

    const clusterSpacing = options.clusterSpacing ?? 200;
    const nodeSpacing = options.nodeSpacing ?? 50;
    const interClusterEdgeLength = options.interClusterEdgeLength ?? 300;
    const clusterRepulsion = options.clusterRepulsion ?? 50000;
    const gravity = options.gravity ?? 0.1;

    // ノードIDからノードデータへのマップを作成
    const nodeMap = new Map<string, any>();
    nodes.forEach(n => nodeMap.set(n.data.id, n));

    // 最終的なノード座標
    const finalPositions = new Map<string, { x: number, y: number }>();

    /**
     * 再帰的にコミュニティのレイアウトを計算
     */
    async function layoutCommunity(
        community: HierarchicalCommunity,
        offsetX: number,
        offsetY: number,
        availableWidth: number,
        availableHeight: number
    ): Promise<void> {
        const communityName = community.id === 'root' ? 'root' : `community-${community.id}`;

        // 子コミュニティがある場合
        if (community.children.length > 0) {
            logs.log(`[Hierarchical Layout] Processing ${communityName}: ${community.children.length} sub-communities`);

            // 子コミュニティ間のエッジを抽出
            const childCommunityIds = new Set(community.children.map(c => c.id));
            const childCommunityNodeSets = new Map<string, Set<string>>();
            community.children.forEach(child => {
                childCommunityNodeSets.set(child.id, new Set(getAllNodesInCommunity(child)));
            });

            // コミュニティ間エッジを計算
            const interCommunityEdges: { source: string, target: string, weight: number }[] = [];
            edges.forEach(edge => {
                let sourceCommunity: string | null = null;
                let targetCommunity: string | null = null;

                for (const [communityId, nodeIds] of childCommunityNodeSets.entries()) {
                    if (nodeIds.has(edge.source)) {
                        sourceCommunity = communityId;
                    }
                    if (nodeIds.has(edge.target)) {
                        targetCommunity = communityId;
                    }
                }

                if (sourceCommunity && targetCommunity && sourceCommunity !== targetCommunity) {
                    // 既存のエッジを探す
                    const existingEdge = interCommunityEdges.find(
                        e => (e.source === sourceCommunity && e.target === targetCommunity) ||
                             (e.source === targetCommunity && e.target === sourceCommunity)
                    );
                    if (existingEdge) {
                        existingEdge.weight += edge.weight || 1;
                    } else {
                        interCommunityEdges.push({
                            source: sourceCommunity,
                            target: targetCommunity,
                            weight: edge.weight || 1
                        });
                    }
                }
            });

            logs.log(`[Hierarchical Layout] ${communityName}: ${interCommunityEdges.length} inter-community edges`);

            // 子コミュニティを仮想ノードとして力学的レイアウトを計算
            const communityPositions = await calculateCommunityPositions(
                community.children,
                childCommunityNodeSets,
                interCommunityEdges,
                availableWidth,
                availableHeight,
                clusterSpacing,
                clusterRepulsion,
                gravity,
                logs
            );

            // 各子コミュニティを再帰的にレイアウト
            for (const child of community.children) {
                const childPos = communityPositions.get(child.id);
                if (childPos) {
                    const childWidth = childPos.width;
                    const childHeight = childPos.height;
                    await layoutCommunity(
                        child,
                        offsetX + childPos.x - childWidth / 2,
                        offsetY + childPos.y - childHeight / 2,
                        childWidth,
                        childHeight
                    );
                }
            }
        } else {
            // 葉コミュニティ：ノードを配置
            const communityNodes = community.nodeIds;
            logs.log(`[Hierarchical Layout] Leaf ${communityName}: ${communityNodes.length} nodes`);

            if (communityNodes.length === 0) {
                return;
            }

            // コミュニティ内のノードを配置（円形配置）
            const radius = Math.max(nodeSpacing, nodeSpacing * communityNodes.length / (2 * Math.PI));
            const centerX = offsetX + availableWidth / 2;
            const centerY = offsetY + availableHeight / 2;

            if (communityNodes.length === 1) {
                // 1ノードの場合は中心に配置
                finalPositions.set(communityNodes[0], { x: centerX, y: centerY });
            } else {
                // 複数ノードの場合は円周上に配置
                communityNodes.forEach((nodeId, index) => {
                    const angle = (2 * Math.PI * index) / communityNodes.length - Math.PI / 2;
                    finalPositions.set(nodeId, {
                        x: centerX + radius * Math.cos(angle),
                        y: centerY + radius * Math.sin(angle)
                    });
                });
            }
        }
    }

    /**
     * コミュニティ内の全ノードIDを再帰的に取得
     */
    function getAllNodesInCommunity(community: HierarchicalCommunity): string[] {
        if (community.children.length === 0) {
            return community.nodeIds;
        }
        const allNodes: string[] = [];
        for (const child of community.children) {
            allNodes.push(...getAllNodesInCommunity(child));
        }
        return allNodes;
    }

    // エッジを持つノードと持たないノードを分離
    const nodesWithEdges = new Set<string>();
    edges.forEach(edge => {
        nodesWithEdges.add(edge.source);
        nodesWithEdges.add(edge.target);
    });

    const allNodeIds = new Set<string>();
    nodes.forEach(n => allNodeIds.add(n.data.id));

    const isolatedNodeIds = Array.from(allNodeIds).filter(id => !nodesWithEdges.has(id));
    logs.log(`[Hierarchical Layout] Isolated nodes (no edges): ${isolatedNodeIds.length}`);

    // ルートからレイアウト開始（エッジを持つノードのみ）
    const canvasWidth = 2000;
    const canvasHeight = 2000;
    await layoutCommunity(hierarchicalResult.root, 0, 0, canvasWidth, canvasHeight);

    // 孤立ノードを別エリアに配置（右側に縦並び）
    if (isolatedNodeIds.length > 0) {
        // 配置済みノードの右端を取得
        let maxX = 0;
        finalPositions.forEach((pos) => {
            if (pos.x > maxX) {
                maxX = pos.x;
            }
        });

        // 孤立ノードを右側に配置（縦に並べる）
        const isolatedStartX = maxX + clusterSpacing * 2;
        const isolatedSpacingY = nodeSpacing * 1.5;
        const isolatedStartY = 0;

        isolatedNodeIds.forEach((nodeId, index) => {
            finalPositions.set(nodeId, {
                x: isolatedStartX + (Math.floor(index / 20) * nodeSpacing * 2), // 20個ごとに列を変える
                y: isolatedStartY + (index % 20) * isolatedSpacingY
            });
        });

        logs.log(`[Hierarchical Layout] Placed ${isolatedNodeIds.length} isolated nodes at x=${isolatedStartX}`);
    }

    // 結果を配列に変換
    const positions: LayoutPosition[] = [];
    finalPositions.forEach((pos, id) => {
        positions.push({ id, x: pos.x, y: pos.y });
    });

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(3);
    logs.log(`[Hierarchical Layout] Complete: ${positions.length} positions in ${elapsed}s`);

    return positions;
}

/**
 * コミュニティ位置を力学的シミュレーションで計算
 */
async function calculateCommunityPositions(
    communities: HierarchicalCommunity[],
    communityNodeSets: Map<string, Set<string>>,
    interCommunityEdges: { source: string, target: string, weight: number }[],
    canvasWidth: number,
    canvasHeight: number,
    clusterSpacing: number,
    clusterRepulsion: number,
    gravity: number,
    logs: Logs
): Promise<Map<string, CommunityPosition>> {
    // コミュニティをノードとして、Cytoscapeで力学的レイアウトを計算
    const communityNodes = communities.map(c => ({
        data: {
            id: c.id,
            label: c.id,
            // コミュニティサイズに基づいてノードサイズを決定
            size: Math.sqrt(communityNodeSets.get(c.id)?.size || 1) * 30 + 50
        }
    }));

    const communityEdges = interCommunityEdges.map((e, i) => ({
        data: {
            id: `community-edge-${i}`,
            source: e.source,
            target: e.target,
            weight: e.weight
        }
    }));

    logs.log(`[Community Positions] Calculating for ${communityNodes.length} communities, ${communityEdges.length} edges`);

    // Cytoscape.jsでレイアウト計算（遅延ロード）
    const cy = initCytoscape()({
        headless: true,
        styleEnabled: true,
        elements: {
            nodes: communityNodes,
            edges: communityEdges
        },
        style: [
            {
                selector: 'node',
                style: {
                    'width': 'data(size)',
                    'height': 'data(size)'
                }
            }
        ]
    });

    return new Promise((resolve) => {
        const layout = cy.layout({
            name: 'cose',
            animate: false,
            fit: false,
            padding: clusterSpacing,
            nodeRepulsion: function() { return clusterRepulsion; },
            idealEdgeLength: function() { return clusterSpacing * 2; },
            edgeElasticity: function() { return 100; },
            gravity: gravity,
            numIter: 500,
            randomize: true,
            stop: function() {
                const positions = new Map<string, CommunityPosition>();

                cy.nodes().forEach((node: any) => {
                    const pos = node.position();
                    const size = node.data('size') || 100;
                    positions.set(node.id(), {
                        communityId: node.id(),
                        x: pos.x,
                        y: pos.y,
                        width: size * 2,
                        height: size * 2
                    });
                });

                cy.destroy();
                resolve(positions);
            }
        });

        layout.run();
    });
}

/**
 * 階層的レイアウトの結果から全レベル座標を導出
 */
export function deriveAllLevelPositionsFromHierarchical(
    hierarchicalPositions: LayoutPosition[],
    allNodes: any[],
    logs: Logs
): AllLevelPositions {
    const startTime = performance.now();
    logs.log(`[Derive Hierarchical] Starting from ${hierarchicalPositions.length} positions`);

    // 座標をMapに変換
    const positionMap = new Map<string, { x: number, y: number }>();
    hierarchicalPositions.forEach(pos => {
        positionMap.set(pos.id, { x: pos.x, y: pos.y });
    });

    // ノードを分類
    const fileNodes = allNodes.filter(n => n.data.kind === 0);
    const symbolNodes = allNodes.filter(n => n.data.kind > 0);
    logs.log(`[Derive Hierarchical] Nodes: ${fileNodes.length} files, ${symbolNodes.length} symbols`);

    // ファイル座標（計算済み）
    const filePositions: LayoutPosition[] = [];
    fileNodes.forEach(node => {
        const pos = positionMap.get(node.data.id);
        if (pos) {
            filePositions.push({ id: node.data.id, x: pos.x, y: pos.y });
        }
    });

    // 残りは既存関数で導出
    return deriveAllLevelPositions(filePositions, allNodes, logs);
}
