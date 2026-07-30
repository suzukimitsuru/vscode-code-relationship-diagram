/**
 * Graph View
 *
 * WebView内で動作するグラフ可視化コンポーネント
 */

// @ts-ignore - Cosmos.glはグローバルにロードされる（UMDビルドは "Cosmos" として公開）
declare const Cosmos: {
    Graph: new (container: HTMLDivElement, config?: any) => any;
};

// VS Code API
declare const acquireVsCodeApi: () => {
    postMessage: (message: any) => void;
    getState: () => any;
    setState: (state: any) => void;
};

// グローバル変数（HTMLから設定）
declare const IS_STANDALONE: boolean;
declare const GRAPH_NODES_COUNT: number;
declare const GRAPH_LINKS_COUNT: number;

// スタンドアロン用グラフデータ
declare const STANDALONE_GRAPH_DATA: {
    nodes: CosmosNodeData[];
    links: CosmosLinkData[];
    directories: string[];
    entryPoints: string[];
    circularLinkIndices: number[];
} | undefined;

/**
 * ノードデータ（拡張機能から受信）
 */
interface CosmosNodeData {
    id: string;
    x: number;
    y: number;
    size: number;
    color: number;
    parentId: string | null;
    level: 'directory' | 'file' | 'symbol';
    label: string;
    path: string;
    kind: number;
    line?: number;
    communityId?: number;
    childCount: number;
    visible: boolean;
    lineCount: number;
    inDegree: number;
    outDegree: number;
    isEntryPoint: boolean;
    isDeadCode: boolean;
    isCyclic: boolean;
    maintenanceScore: number;
    hotspotScore: number;
}

/**
 * リンクデータ（拡張機能から受信）
 */
interface CosmosLinkData {
    source: number;
    target: number;
    width: number;
    color: number;
    details: Array<{
        sourceName: string;
        targetName: string;
        sourceLine: number;
        targetLine: number;
        sourcePath: string;
        targetPath: string;
    }>;
    /** リンクレベル: file=ファイル間集約リンク、symbol=シンボル間リンク */
    level?: 'file' | 'symbol';
}

/**
 * グラフデータ
 */
interface GraphData {
    nodes: CosmosNodeData[];
    links: CosmosLinkData[];
    directories: string[];
    entryPoints: string[];
    circularLinkIndices: number[];
}

// =============================================================
// レイアウト定数（調整時はここを変更する）
// =============================================================

/** ファイルリングの間隔（px）: 大きいほどリングが広がる */
const RING_SPACING = 220;
/** リング上のノード間最小距離（px）: これより密になったら付近のリングへ振り分ける */
const RING_MIN_NODE_GAP = 60;

/** シンボル配置: 公開シンボルをファイル中心から配置する半径（px） */
const SYMBOL_PUBLIC_RADIUS = 40;
/** シンボル配置: シンボルリングの間隔（px） */
const SYMBOL_RING_SPACING = 30;

/** 公開シンボルとみなすSymbolKind値セット（Class/Method/Constructor/Enum/Interface/Function/Struct） */
const PUBLIC_SYMBOL_KINDS = new Set([4, 5, 8, 9, 10, 11, 22]);

// =============================================================
// 自前力学シミュレーション定数（調整時はここを変更する）
// =============================================================

/** 斥力の強さ（ノード同士が離れる力） */
const SIM_REPULSION_STRENGTH = 150;
/** 斥力の最大適用距離（これより遠いノードは無視） */
const SIM_REPULSION_MAX_DIST = 500;
/** Barnes-Hut θ 閾値（大きいほど高速だが精度低下） */
const SIM_BARNES_HUT_THETA = 1.2;
/** 斥力計算でのノードサイズ正規化基準（このサイズのノードが質量1になる） */
const SIM_REPULSION_SIZE_BASE = 12;

/** エッジ引力のベーススプリング定数 */
const SIM_LINK_SPRING_BASE = 0.005;
/** エッジ幅1単位あたりの追加スプリング定数 */
const SIM_LINK_SPRING_PER_WIDTH = 0.003;
/** エッジの自然長（px） */
const SIM_LINK_REST_LENGTH = 120;

/** シンボル→親ファイルへの引力定数 */
const SIM_SYMBOL_PARENT_SPRING = 0.03;
/** シンボル→親ファイルの自然長（px） */
const SIM_SYMBOL_PARENT_REST_LENGTH = 50;

/** ファイルノードの径方向スプリング強度（BFS深度リングの半径を維持する力） */
const SIM_FILE_RADIAL_SPRING = 0.02;

/** 速度の摩擦減衰（0=即停止, 1=減衰なし） */
const SIM_FRICTION = 0.85;
/** 最大速度（px/tick） */
const SIM_MAX_VELOCITY = 3;
/** 収束判定閾値（全ノードの速度二乗和がこれ以下で停止） */
const SIM_CONVERGENCE_THRESHOLD = 0.01;
/** 最大シミュレーションティック数 */
const SIM_MAX_TICKS = 3000;

// =============================================================
// Barnes-Hut 四分木（斥力の高速計算用）
// =============================================================

interface QuadTreeNode {
    cx: number;  // 重心X
    cy: number;  // 重心Y
    mass: number;  // 質量（含まれるノード数）
    size: number;  // セルのサイズ
    x0: number;  // 境界
    y0: number;
    x1: number;
    y1: number;
    children: (QuadTreeNode | null)[];  // NW, NE, SW, SE
    nodeIndex: number;  // 葉ノードの場合のノードインデックス (-1 = 内部ノード)
}

function buildQuadTreeSimple(
    positions: Float32Array,
    activeIndices: number[],
    sizes: Float32Array
): QuadTreeNode | null {
    if (activeIndices.length === 0) { return null; }

    // 境界を計算
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const i of activeIndices) {
        const x = positions[i * 2];
        const y = positions[i * 2 + 1];
        if (isNaN(x) || isNaN(y)) { continue; }
        if (x < minX) { minX = x; }
        if (y < minY) { minY = y; }
        if (x > maxX) { maxX = x; }
        if (y > maxY) { maxY = y; }
    }

    const pad = 10;
    const side = Math.max(maxX - minX, maxY - minY, 1) + pad * 2;
    const ox = minX - pad;
    const oy = minY - pad;

    return buildSubtree(positions, activeIndices, ox, oy, side, sizes);
}

function buildSubtree(
    positions: Float32Array,
    indices: number[],
    x0: number, y0: number, size: number,
    sizes: Float32Array
): QuadTreeNode | null {
    if (indices.length === 0) { return null; }

    const node: QuadTreeNode = {
        cx: 0, cy: 0, mass: 0,
        size,
        x0, y0, x1: x0 + size, y1: y0 + size,
        children: [null, null, null, null],
        nodeIndex: -1,
    };

    if (indices.length === 1) {
        const i = indices[0];
        node.nodeIndex = i;
        node.cx = positions[i * 2];
        node.cy = positions[i * 2 + 1];
        node.mass = sizes[i] / SIM_REPULSION_SIZE_BASE;
        return node;
    }

    const midX = x0 + size / 2;
    const midY = y0 + size / 2;
    const halfSize = size / 2;
    const buckets: number[][] = [[], [], [], []]; // NW, NE, SW, SE

    for (const i of indices) {
        const x = positions[i * 2];
        const y = positions[i * 2 + 1];
        const qx = x < midX ? 0 : 1;
        const qy = y < midY ? 0 : 1;
        buckets[qy * 2 + qx].push(i);
    }

    const childOrigins = [
        [x0, y0],           // NW
        [midX, y0],         // NE
        [x0, midY],         // SW
        [midX, midY],       // SE
    ];

    let totalMass = 0;
    let sumX = 0;
    let sumY = 0;

    for (let q = 0; q < 4; q++) {
        if (buckets[q].length > 0) {
            // 全ノードが同じ位置にいる場合の無限再帰防止
            if (halfSize < 0.01) {
                // 最小サイズに達したら最初のノードだけ葉にする
                const i = buckets[q][0];
                node.nodeIndex = i;
                node.cx = positions[i * 2];
                node.cy = positions[i * 2 + 1];
                node.mass = buckets[q].reduce((sum, i) => sum + sizes[i] / SIM_REPULSION_SIZE_BASE, 0);
                return node;
            }
            const child = buildSubtree(positions, buckets[q], childOrigins[q][0], childOrigins[q][1], halfSize, sizes);
            node.children[q] = child;
            if (child) {
                totalMass += child.mass;
                sumX += child.cx * child.mass;
                sumY += child.cy * child.mass;
            }
        }
    }

    node.mass = totalMass;
    if (totalMass > 0) {
        node.cx = sumX / totalMass;
        node.cy = sumY / totalMass;
    }

    return node;
}

/** Barnes-Hut法で斥力を計算 */
function barnesHutRepulsion(
    tree: QuadTreeNode | null,
    px: number, py: number,
    nodeIdx: number,
    theta: number,
    fx: Float32Array, fy: Float32Array
): void {
    if (!tree || tree.mass === 0) { return; }

    const dx = tree.cx - px;
    const dy = tree.cy - py;
    const distSq = dx * dx + dy * dy + 1; // +1 でゼロ除算防止
    const dist = Math.sqrt(distSq);

    // 単一ノードの葉、または十分に遠い内部ノード
    if (tree.nodeIndex !== -1 && tree.nodeIndex !== nodeIdx) {
        // 葉ノード: 直接計算
        if (dist < SIM_REPULSION_MAX_DIST) {
            const force = SIM_REPULSION_STRENGTH / distSq;
            fx[nodeIdx] -= (dx / dist) * force;
            fy[nodeIdx] -= (dy / dist) * force;
        }
        return;
    }

    if (tree.nodeIndex === nodeIdx) { return; } // 自分自身

    // Barnes-Hut 近似判定: セルサイズ/距離 < θ なら近似
    if (tree.size / dist < theta) {
        if (dist < SIM_REPULSION_MAX_DIST) {
            const force = SIM_REPULSION_STRENGTH * tree.mass / distSq;
            fx[nodeIdx] -= (dx / dist) * force;
            fy[nodeIdx] -= (dy / dist) * force;
        }
        return;
    }

    // 子ノードに再帰
    for (const child of tree.children) {
        if (child) {
            barnesHutRepulsion(child, px, py, nodeIdx, theta, fx, fy);
        }
    }
}

// =============================================================

/**
 * ノード群を指定された中心・半径の円周上に均等配置し、positionsMapへ書き込む
 */
function placeOnRing(
    nodes: CosmosNodeData[],
    center: { x: number; y: number },
    radius: number,
    positionsMap: Map<string, { x: number; y: number }>
): void {
    const count = nodes.length;
    if (count === 0) { return; }
    nodes.forEach((node, idx) => {
        const angle = (idx / count) * 2 * Math.PI - Math.PI / 2;
        positionsMap.set(node.id, {
            x: center.x + radius * Math.cos(angle),
            y: center.y + radius * Math.sin(angle),
        });
    });
}

/**
 * グラフビュークラス
 */
class GraphView {
    private graph: any;
    private container: HTMLDivElement;
    private vscode: ReturnType<typeof acquireVsCodeApi> | null = null;
    private data: GraphData | null = null;
    private selectedNodeId: string | null = null;
    private hoveredNodeIndex: number | null = null;
    private tooltip: HTMLElement | null = null;
    private tooltipTimerId: number | null = null;  // ツールチップ遅延表示用タイマー
    private nodeIndexMap: Map<string, number> = new Map();

    // Pan control state
    private panHandle: HTMLElement | null = null;
    private panCircle: HTMLElement | null = null;
    private isPanDragging: boolean = false;
    private panAnimationId: number | null = null;

    // Zoom control state
    private zoomIntervalId: number | null = null;

    // リンク関連の状態
    private highlightedLinks: Set<number> = new Set();
    private originalLinkColors: Float32Array | null = null;
    private currentVisibleNodes: CosmosNodeData[] = [];
    private currentVisibleLinks: CosmosLinkData[] = [];

    // プログレスバー状態
    private progressCurrentPercent: number = 0;

    // シミュレーション状態
    private isSimulating: boolean = false;
    private simAnimationId: number | null = null;
    private simVelocitiesX: Float32Array | null = null;
    private simVelocitiesY: Float32Array | null = null;
    private simPositions: Float32Array | null = null;
    private simPinnedNodes: Set<number> = new Set(); // 固定ノード（ファイルノード）
    private simTickCount: number = 0;
    private simRemappedLinks: Array<{ source: number; target: number; width: number }> = [];
    private simParentMap: Map<number, number> = new Map(); // シンボルindex → 親ファイルindex
    private simFileRadialTargets: Map<number, number> = new Map(); // ファイルindex → 目標半径(px)

    // ドラッグ関連の状態
    private draggedNodeIndex: number | null = null;
    private dragStartPositions: Float32Array | null = null;
    private relatedNodeInfluence: Map<number, number> = new Map(); // ノードインデックス -> 影響度(0-1)

    // Circle Diagram 状態
    private maxDepth: number = 100;
    private minDepth: number = 0;
    private showDeadCode: boolean = true;
    private showCircularRefs: boolean = true;
    private showSymbols: boolean = true;
    private nodeBfsDepth: Map<string, number> = new Map();

    constructor(containerId: string) {
        // VS Code API（スタンドアロンの場合はnull）
        if (typeof acquireVsCodeApi !== 'undefined') {
            this.vscode = acquireVsCodeApi();
        }

        this.container = document.getElementById(containerId) as HTMLDivElement;
        if (!this.container) {
            console.error('Container not found:', containerId);
            return;
        }

        // ツールチップ作成
        this.createTooltip();

        // コントロール設定
        this.setupControls();

        // メッセージ受信設定
        window.addEventListener('message', this.handleMessage.bind(this));

        // 準備完了を通知
        if (this.vscode) {
            this.vscode.postMessage({ type: 'webviewReady' });
        }

        this.log('Graph view initialized');
    }

    /**
     * ツールチップ要素を作成
     */
    private createTooltip(): void {
        this.tooltip = document.getElementById('node-tooltip') as HTMLElement;
        if (!this.tooltip) {
            this.tooltip = document.createElement('div');
            this.tooltip.className = 'node-tooltip';
            document.body.appendChild(this.tooltip);
        }
    }

    /**
     * コントロールを設定
     */
    private setupControls(): void {
        // Fit button
        const fitBtn = document.getElementById('btn-fit');
        if (fitBtn) {
            fitBtn.addEventListener('click', () => this.fitView());
        }

        // Reset button
        const resetBtn = document.getElementById('btn-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => this.resetView());
        }

        // Simulate button
        const simBtn = document.getElementById('btn-simulate');
        if (simBtn) {
            simBtn.addEventListener('click', () => this.toggleSimulation());
        }

        // Pan circle control
        this.setupPanControl();

        // Zoom controls
        this.setupZoomControls();

        // Circle diagram controls
        this.setupCircleControls();
    }

    /**
     * Circle Diagram コントロールを設定（エントリポイント・深度・トグル）
     */
    private setupCircleControls(): void {

        // Max depth slider
        const maxSlider = document.getElementById('max-depth-slider') as HTMLInputElement;
        const maxLabel = document.getElementById('max-depth-value');
        if (maxSlider && maxLabel) {
            maxSlider.addEventListener('input', () => {
                this.maxDepth = parseInt(maxSlider.value);
                maxLabel.textContent = this.maxDepth >= 100 ? '∞' : String(this.maxDepth);
                this.applyRadialLayout();
            });
        }

        // Min depth slider
        const minSlider = document.getElementById('min-depth-slider') as HTMLInputElement;
        const minLabel = document.getElementById('min-depth-value');
        if (minSlider && minLabel) {
            minSlider.addEventListener('input', () => {
                this.minDepth = parseInt(minSlider.value);
                minLabel.textContent = String(this.minDepth);
                this.applyRadialLayout();
            });
        }

        // Dead code toggle
        const deadCodeToggle = document.getElementById('toggle-deadcode') as HTMLInputElement;
        if (deadCodeToggle) {
            deadCodeToggle.addEventListener('change', () => {
                this.showDeadCode = deadCodeToggle.checked;
                this.applyRadialLayout();
            });
        }

        // Circular refs toggle
        const circularToggle = document.getElementById('toggle-circular') as HTMLInputElement;
        if (circularToggle) {
            circularToggle.addEventListener('change', () => {
                this.showCircularRefs = circularToggle.checked;
                this.applyCircularRefColors();
            });
        }

        // Symbols toggle
        const symbolsToggle = document.getElementById('toggle-symbols') as HTMLInputElement;
        if (symbolsToggle) {
            symbolsToggle.addEventListener('change', () => {
                this.showSymbols = symbolsToggle.checked;
                this.applyRadialLayout();
            });
        }
    }

    /**
     * エントリポイント選択肢を埋める（廃止：全エントリポイントを同心円中心に配置）
     */
    private populateEntryPointSelect(): void {
        // 全エントリポイントをマルチソースBFSの起点として使用するため選択UIは不要
    }

    /**
     * 全エントリポイントを起点とするマルチソースBFSで深度を計算（ファイルノードのみ）
     * 全エントリポイントが depth=0 の同心円中心リングに配置される
     * エッジ方向（参照元→定義先）に従って外周へ辿る
     */
    private computeBfsDepths(entryPointIds: string[]): Map<string, number> {
        if (!this.data || !entryPointIds || entryPointIds.length === 0) { return new Map(); }

        const depths = new Map<string, number>();
        const queue: string[] = [];

        // 全エントリポイントを depth=0 として初期化
        for (const id of entryPointIds) {
            depths.set(id, 0);
            queue.push(id);
        }

        // ファイルノードの有向隣接リスト（参照元 → 定義先）
        const adj = new Map<string, string[]>();
        for (const link of this.data.links) {
            const src = this.data.nodes[link.source];
            const tgt = this.data.nodes[link.target];
            if (!src || !tgt || src.level !== 'file' || tgt.level !== 'file') { continue; }
            if (!adj.has(src.id)) { adj.set(src.id, []); }
            adj.get(src.id)!.push(tgt.id);
        }

        while (queue.length > 0) {
            const current = queue.shift()!;
            const currentDepth = depths.get(current)!;
            for (const neighbor of (adj.get(current) || [])) {
                if (!depths.has(neighbor)) {
                    depths.set(neighbor, currentDepth + 1);
                    queue.push(neighbor);
                }
            }
        }

        return depths;
    }

    /**
     * BFS 深度に基づく同心円初期座標を計算
     * 仕様:
     * - ファイルノード: エントリポイントを中心リングに配置、参照先を外周に階層配置
     *   参照数(inDegree)降順で配置。リング上のノード密度が高い場合は付近のリングに振り分ける
     * - シンボルノード: 公開シンボルを内周、参照BFSで外周に階層配置
     */
    private computeRadialPositions(
        visibleNodes: CosmosNodeData[],
        bfsDepths: Map<string, number>
    ): Float32Array {
        const positions = new Float32Array(visibleNodes.length * 2);

        // 深度ごとにノードをグループ化（ファイルノードのみ）
        const depthGroups = new Map<number, CosmosNodeData[]>();
        const maxBfsDepth = bfsDepths.size > 0 ? Math.max(...bfsDepths.values()) : 0;

        for (const node of visibleNodes) {
            if (node.level !== 'file') { continue; }
            const depth = bfsDepths.get(node.id);
            const d = depth !== undefined ? depth : maxBfsDepth + 1;
            if (!depthGroups.has(d)) { depthGroups.set(d, []); }
            depthGroups.get(d)!.push(node);
        }

        // 各深度のファイルノードに同心円座標を割り当て
        // 同一リング内は inDegree 降順（参照が多いものを先に配置）
        // リング容量を超えたら付近のサブリングへ振り分ける
        const filePositions = new Map<string, { x: number; y: number }>();
        for (const [depth, nodesAtDepth] of depthGroups) {
            // inDegree 降順ソート（参照が多いファイルを最初の位置=上部へ）
            nodesAtDepth.sort((a, b) => b.inDegree - a.inDegree);

            // depth=0 の基本半径
            const baseRadius = depth === 0
                ? (nodesAtDepth.length <= 1 ? 0 : RING_SPACING * 0.5)
                : depth * RING_SPACING;

            if (baseRadius === 0 && nodesAtDepth.length <= 1) {
                // 単一エントリポイント → 原点
                if (nodesAtDepth.length === 1) {
                    filePositions.set(nodesAtDepth[0].id, { x: 0, y: 0 });
                }
                continue;
            }

            // リング容量: 円周長 / ノード間最小距離
            const ringCapacity = Math.max(1, Math.floor((2 * Math.PI * baseRadius) / RING_MIN_NODE_GAP));

            if (nodesAtDepth.length <= ringCapacity) {
                // 容量内: 均等配置
                placeOnRing(nodesAtDepth, { x: 0, y: 0 }, baseRadius, filePositions);
            } else {
                // 容量超過: サブリングに振り分ける
                const subRingSpacing = RING_SPACING * 0.3; // サブリング間隔
                let placed = 0;
                let subRingIdx = 0;
                while (placed < nodesAtDepth.length) {
                    const r = baseRadius + subRingIdx * subRingSpacing;
                    const cap = Math.max(1, Math.floor((2 * Math.PI * r) / RING_MIN_NODE_GAP));
                    const batch = nodesAtDepth.slice(placed, placed + cap);
                    placeOnRing(batch, { x: 0, y: 0 }, r, filePositions);
                    placed += batch.length;
                    subRingIdx++;
                }
            }
        }

        // シンボル座標を事前計算（BFSベース）
        const symbolPositions = this.computeSymbolPositions(visibleNodes, filePositions);

        // 全ノードに座標を設定
        for (let i = 0; i < visibleNodes.length; i++) {
            const node = visibleNodes[i];
            if (node.level === 'file') {
                const pos = filePositions.get(node.id);
                if (pos) {
                    positions[i * 2] = pos.x;
                    positions[i * 2 + 1] = pos.y;
                }
            } else if (node.level === 'symbol') {
                const pos = symbolPositions.get(node.id);
                if (pos) {
                    positions[i * 2] = pos.x;
                    positions[i * 2 + 1] = pos.y;
                } else {
                    // フォールバック: 親ファイルの近く
                    const parentPos = node.parentId ? filePositions.get(node.parentId) : undefined;
                    if (parentPos) {
                        const angle = Math.random() * 2 * Math.PI;
                        positions[i * 2] = parentPos.x + SYMBOL_PUBLIC_RADIUS * Math.cos(angle);
                        positions[i * 2 + 1] = parentPos.y + SYMBOL_PUBLIC_RADIUS * Math.sin(angle);
                    }
                }
            }
            // ディレクトリノードは非表示のため座標不要
        }

        return positions;
    }

    /**
     * シンボルの事前計算座標を返す（BFSベース階層配置）
     * 仕様:
     * - 公開シンボル（Class/Method/Constructor/Enum/Interface/Function/Struct）を内周リングに配置
     * - 次に公開シンボルが参照しているシンボルを外周に配置
     * - その次にそれらが参照しているシンボルを外周に階層的に配置
     * - リング上のノード密度が高い場合は付近のリングに振り分ける
     */
    private computeSymbolPositions(
        visibleNodes: CosmosNodeData[],
        filePositions: Map<string, { x: number; y: number }>
    ): Map<string, { x: number; y: number }> {
        const symbolPositions = new Map<string, { x: number; y: number }>();

        // ファイルIDセット
        const fileIdSet = new Set<string>();
        for (const node of visibleNodes) {
            if (node.level === 'file') { fileIdSet.add(node.id); }
        }

        // シンボルの隣接リスト（同一ファイル内の参照関係）を構築
        // リンクデータから参照元シンボル → 参照先シンボル のマップを作る
        const symbolAdj = new Map<string, string[]>();
        if (this.data) {
            for (const link of this.data.links) {
                const src = this.data.nodes[link.source];
                const tgt = this.data.nodes[link.target];
                if (!src || !tgt) { continue; }
                if (src.level === 'symbol' && tgt.level === 'symbol') {
                    if (!symbolAdj.has(src.id)) { symbolAdj.set(src.id, []); }
                    symbolAdj.get(src.id)!.push(tgt.id);
                }
            }
        }

        // ファイルごとにシンボルをグループ化
        const symbolsByFile = new Map<string, CosmosNodeData[]>();
        for (const node of visibleNodes) {
            if (node.level !== 'symbol' || !node.parentId) { continue; }
            if (!fileIdSet.has(node.parentId)) { continue; }
            if (!symbolsByFile.has(node.parentId)) {
                symbolsByFile.set(node.parentId, []);
            }
            symbolsByFile.get(node.parentId)!.push(node);
        }

        // ファイルごとにBFS階層配置
        for (const [fileId, symbols] of symbolsByFile) {
            const filePos = filePositions.get(fileId);
            if (!filePos) { continue; }

            const symbolIdSet = new Set(symbols.map(s => s.id));

            // BFS: 公開シンボルを depth=0（内周）として開始
            const depths = new Map<string, number>();
            const queue: string[] = [];

            for (const sym of symbols) {
                if (PUBLIC_SYMBOL_KINDS.has(sym.kind)) {
                    depths.set(sym.id, 0);
                    queue.push(sym.id);
                }
            }

            // 公開シンボルから参照を辿ってBFS
            while (queue.length > 0) {
                const current = queue.shift()!;
                const currentDepth = depths.get(current)!;
                for (const neighbor of (symbolAdj.get(current) || [])) {
                    if (symbolIdSet.has(neighbor) && !depths.has(neighbor)) {
                        depths.set(neighbor, currentDepth + 1);
                        queue.push(neighbor);
                    }
                }
            }

            // BFS未到達のシンボルは最外周に配置
            const maxSymDepth = depths.size > 0 ? Math.max(...depths.values()) : 0;
            for (const sym of symbols) {
                if (!depths.has(sym.id)) {
                    depths.set(sym.id, maxSymDepth + 1);
                }
            }

            // 深度ごとにグループ化
            const depthGroups = new Map<number, CosmosNodeData[]>();
            for (const sym of symbols) {
                const d = depths.get(sym.id)!;
                if (!depthGroups.has(d)) { depthGroups.set(d, []); }
                depthGroups.get(d)!.push(sym);
            }

            // 各深度のシンボルをリングに配置（溢れ時はサブリングに振り分け）
            for (const [d, symsAtDepth] of depthGroups) {
                const baseRadius = SYMBOL_PUBLIC_RADIUS + d * SYMBOL_RING_SPACING;
                const ringCapacity = Math.max(1, Math.floor((2 * Math.PI * baseRadius) / (RING_MIN_NODE_GAP * 0.5)));

                if (symsAtDepth.length <= ringCapacity) {
                    placeOnRing(symsAtDepth, filePos, baseRadius, symbolPositions);
                } else {
                    // サブリングに振り分け
                    const subSpacing = SYMBOL_RING_SPACING * 0.4;
                    let placed = 0;
                    let subIdx = 0;
                    while (placed < symsAtDepth.length) {
                        const r = baseRadius + subIdx * subSpacing;
                        const cap = Math.max(1, Math.floor((2 * Math.PI * r) / (RING_MIN_NODE_GAP * 0.5)));
                        const batch = symsAtDepth.slice(placed, placed + cap);
                        placeOnRing(batch, filePos, r, symbolPositions);
                        placed += batch.length;
                        subIdx++;
                    }
                }
            }
        }

        return symbolPositions;
    }

    /**
     * ラジアルレイアウトを適用（BFS 深度 → 同心円初期座標 → シミュレーション再スタート）
     */
    private applyRadialLayout(): void {
        if (!this.data || !this.graph) { return; }

        // 全エントリポイントを起点としてマルチソースBFS
        this.nodeBfsDepth = this.computeBfsDepths(this.data.entryPoints);

        // グラフを再初期化（フィルタ適用 + 新しい初期座標）
        this.initializeGraph();
    }

    /**
     * シミュレーションを起動/一時停止（自前力学シミュレーション）
     */
    private toggleSimulation(): void {
        if (!this.graph) { return; }
        if (this.isSimulating) {
            this.stopCustomSimulation();
        } else {
            this.startCustomSimulation();
        }
    }

    /**
     * シミュレーションボタンのアイコンを更新
     */
    private updateSimulateButton(): void {
        const btn = document.getElementById('btn-simulate');
        if (!btn) { return; }
        const icon = btn.querySelector('i');
        if (this.isSimulating) {
            if (icon) { icon.className = 'fa fa-pause'; }
            btn.title = 'Pause Simulation';
        } else {
            if (icon) { icon.className = 'fa fa-play'; }
            btn.title = 'Start Simulation';
        }
    }

    /**
     * 循環参照リンクの色を適用/解除
     */
    private applyCircularRefColors(): void {
        if (!this.graph || !this.data || this.currentVisibleLinks.length === 0) { return; }

        const linkColors = new Float32Array(this.currentVisibleLinks.length * 4);
        const circularSet = new Set(this.data.circularLinkIndices);

        // 表示中リンクの元インデックスを取得するためのマッピング
        const visibleNodeOrigIdx = new Map<number, number>();
        this.currentVisibleNodes.forEach((node, newIdx) => {
            const origIdx = this.data!.nodes.indexOf(node);
            visibleNodeOrigIdx.set(newIdx, origIdx);
        });

        for (let i = 0; i < this.currentVisibleLinks.length; i++) {
            const link = this.currentVisibleLinks[i];
            // 元のリンクインデックスを探す
            const origLinkIdx = this.data.links.findIndex(
                l => l.source === link.source && l.target === link.target
            );
            const isCircular = origLinkIdx !== -1 && circularSet.has(origLinkIdx) && this.showCircularRefs;

            if (isCircular) {
                linkColors[i * 4] = 1.0;      // R
                linkColors[i * 4 + 1] = 0.267; // G
                linkColors[i * 4 + 2] = 0.267; // B
                linkColors[i * 4 + 3] = 0.9;   // A
            } else {
                linkColors[i * 4] = 0.204;
                linkColors[i * 4 + 1] = 0.596;
                linkColors[i * 4 + 2] = 0.859;
                linkColors[i * 4 + 3] = 0.7;
            }
        }

        if (this.graph.setLinkColors) {
            this.originalLinkColors = linkColors;
            this.graph.setLinkColors(linkColors);
        }
    }

    /**
     * パンコントロールを設定（d3-zoomのtranslateByを使用）
     */
    private setupPanControl(): void {
        this.panCircle = document.getElementById('pan-circle');
        this.panHandle = document.getElementById('pan-handle');

        if (!this.panCircle || !this.panHandle) {return;}

        const circle = this.panCircle;
        const handle = this.panHandle;

        const circleRadius = circle.offsetWidth / 2;
        const handleRadius = handle.offsetWidth / 2;
        const maxOffset = circleRadius - handleRadius - 5; // パディング

        // パン用の変数
        let panDx = 0;
        let panDy = 0;

        const startPan = (clientX: number, clientY: number) => {
            this.isPanDragging = true;
            handle.classList.add('dragging');
            updatePan(clientX, clientY);
        };

        const updatePan = (clientX: number, clientY: number) => {
            if (!this.isPanDragging) {return;}

            const rect = circle.getBoundingClientRect();
            const centerX = rect.left + circleRadius;
            const centerY = rect.top + circleRadius;

            // 中心からのオフセットを計算
            let offsetX = clientX - centerX;
            let offsetY = clientY - centerY;

            // 距離を計算
            const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);

            // 最大オフセットを超えないように制限
            if (distance > maxOffset) {
                const scale = maxOffset / distance;
                offsetX *= scale;
                offsetY *= scale;
            }

            // ハンドルの位置を更新
            handle.style.left = `${circleRadius + offsetX}px`;
            handle.style.top = `${circleRadius + offsetY}px`;

            // パン速度を距離に比例させる（中心に近いほど遅い）
            const normalizedDistance = distance / maxOffset;
            const panSpeed = normalizedDistance * 8; // 最大8px/フレーム

            // パン方向を正規化（パンは逆方向に移動）
            if (distance > 5) { // デッドゾーン
                panDx = -(offsetX / distance) * panSpeed;
                panDy = -(offsetY / distance) * panSpeed;

                // 連続パンアニメーション開始
                if (this.panAnimationId === null) {
                    animatePan();
                }
            } else {
                // デッドゾーン内ならパン停止
                panDx = 0;
                panDy = 0;
            }
        };

        // d3-zoomのtranslateByを使用してパンを実行
        const animatePan = () => {
            if (!this.isPanDragging || (panDx === 0 && panDy === 0)) {
                this.panAnimationId = null;
                return;
            }

            if (this.graph) {
                try {
                    // Cosmos.glの内部d3-zoom behaviorにアクセス
                    const zoomInstance = (this.graph as any).zoomInstance;
                    const canvasD3Selection = (this.graph as any).canvasD3Selection;

                    if (zoomInstance?.behavior && canvasD3Selection) {
                        // d3-zoomのtranslateByでパン（マウスドラッグと同じ処理）
                        canvasD3Selection.call(
                            zoomInstance.behavior.translateBy,
                            panDx,
                            panDy
                        );
                    }
                } catch (e) {
                    // エラー時は無視
                }
            }

            this.panAnimationId = requestAnimationFrame(animatePan);
        };

        const stopPan = () => {
            if (!this.isPanDragging) {return;}
            this.isPanDragging = false;
            handle.classList.remove('dragging');

            // ハンドルを中央に戻す
            handle.style.left = '50%';
            handle.style.top = '50%';

            // パン停止
            panDx = 0;
            panDy = 0;

            // パンアニメーション停止
            if (this.panAnimationId !== null) {
                cancelAnimationFrame(this.panAnimationId);
                this.panAnimationId = null;
            }
        };

        // マウスイベント
        circle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            startPan(e.clientX, e.clientY);
        });

        document.addEventListener('mousemove', (e) => {
            updatePan(e.clientX, e.clientY);
        });

        document.addEventListener('mouseup', stopPan);

        // タッチイベント
        circle.addEventListener('touchstart', (e) => {
            e.preventDefault();
            const touch = e.touches[0];
            startPan(touch.clientX, touch.clientY);
        });

        document.addEventListener('touchmove', (e) => {
            if (!this.isPanDragging) {return;}
            const touch = e.touches[0];
            updatePan(touch.clientX, touch.clientY);
        });

        document.addEventListener('touchend', stopPan);
        document.addEventListener('touchcancel', stopPan);
    }

    /**
     * ズームコントロールを設定（長押し対応）
     */
    private setupZoomControls(): void {
        const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
        const zoomLevelDisplay = document.getElementById('zoom-level');
        const zoomInBtn = document.getElementById('zoom-in-btn');
        const zoomOutBtn = document.getElementById('zoom-out-btn');

        const updateZoomDisplay = () => {
            if (!this.graph) {return;}
            const value = this.graph.getZoomLevel();
            if (zoomLevelDisplay) {
                zoomLevelDisplay.textContent = `${Math.round(value * 100)}%`;
            }
            if (zoomSlider) {
                zoomSlider.value = String(Math.min(Math.max(value, 0.1), 3));
            }
        };

        const zoomGraph = (direction: number) => {
            if (!this.graph) {return;}

            const zoomFactor = 0.05; // 連続ズーム用に小さめの値
            const currentZoom = this.graph.getZoomLevel();
            const newZoom = direction > 0
                ? currentZoom * (1 + zoomFactor)
                : currentZoom * (1 - zoomFactor);

            // ズームレベルを制限 (0.1 〜 3.0)
            const clampedZoom = Math.max(0.1, Math.min(3.0, newZoom));
            this.graph.setZoomLevel(clampedZoom, 50);
            updateZoomDisplay();
        };

        const startZoom = (direction: number) => {
            zoomGraph(direction);
            // 長押し対応：50ms間隔で連続ズーム
            this.zoomIntervalId = window.setInterval(() => {
                zoomGraph(direction);
            }, 50);
        };

        const stopZoom = () => {
            if (this.zoomIntervalId !== null) {
                clearInterval(this.zoomIntervalId);
                this.zoomIntervalId = null;
            }
        };

        if (zoomInBtn) {
            zoomInBtn.addEventListener('mousedown', () => startZoom(1));
            zoomInBtn.addEventListener('mouseup', stopZoom);
            zoomInBtn.addEventListener('mouseleave', stopZoom);
            zoomInBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startZoom(1); });
            zoomInBtn.addEventListener('touchend', stopZoom);
            zoomInBtn.addEventListener('touchcancel', stopZoom);
        }

        if (zoomOutBtn) {
            zoomOutBtn.addEventListener('mousedown', () => startZoom(-1));
            zoomOutBtn.addEventListener('mouseup', stopZoom);
            zoomOutBtn.addEventListener('mouseleave', stopZoom);
            zoomOutBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startZoom(-1); });
            zoomOutBtn.addEventListener('touchend', stopZoom);
            zoomOutBtn.addEventListener('touchcancel', stopZoom);
        }

        if (zoomSlider) {
            zoomSlider.addEventListener('input', (e) => {
                const value = parseFloat((e.target as HTMLInputElement).value);
                if (this.graph) {
                    this.graph.setZoomLevel(value, 100);
                    updateZoomDisplay();
                }
            });
        }
    }

    /**
     * 拡張機能からのメッセージを処理
     */
    private handleMessage(event: MessageEvent): void {
        const message = event.data;
        switch (message.type) {
            case 'graphData':
                this.setGraphData(message.data);
                break;
            case 'highlightNode':
                this.highlightNode(message.nodeId);
                break;
            case 'zoomToNode':
                this.zoomToNode(message.nodeId);
                break;
            case 'zoomToNodes':
                this.zoomToNodes(message.nodeIds);
                break;
            case 'editorCursorChange':
                this.onEditorCursorChange(message.path, message.line);
                break;
            case 'editorFileOpen':
                this.onEditorFileOpen(message.path);
                break;
            case 'progress':
                this.updateProgress(message.percent, message.message);
                break;
            case 'zoomToFile':
                this.onZoomToFile(message.path);
                break;
            case 'showRelatedCode':
                this.onShowRelatedCode(message.path, message.startLine, message.endLine);
                break;
        }
    }

    /**
     * 進捗を更新
     */
    private updateProgress(percent: number, message: string): void {
        // 実際の進捗値で更新（後退しない）
        if (percent > this.progressCurrentPercent) {
            this.progressCurrentPercent = percent;
        }

        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');

        if (progressBar) {
            progressBar.style.width = `${this.progressCurrentPercent}%`;
        }
        if (progressText) {
            progressText.textContent = message;
        }

        // 完了時に非表示
        if (percent >= 100) {
            const progressContainer = document.getElementById('progress-container');
            if (progressContainer) {
                progressContainer.style.opacity = '0';
                setTimeout(() => {
                    progressContainer.style.display = 'none';
                }, 300);
            }
            if (progressText) {
                progressText.style.opacity = '0';
            }
        }
    }

    /**
     * グラフデータを設定
     */
    private setGraphData(data: GraphData): void {
        this.updateProgress(81, `Received: ${data.nodes.length.toLocaleString()} nodes, ${data.links.length.toLocaleString()} links`);

        this.data = data;

        // ノードIDインデックスを作成（1,000件ごとに 81→83% の進捗更新）
        this.nodeIndexMap.clear();
        const IDX_BATCH = 1000;
        const totalForIdx = data.nodes.length;
        data.nodes.forEach((node, index) => {
            this.nodeIndexMap.set(node.id, index);
            if (index % IDX_BATCH === 0 && index > 0) {
                const pct = 81 + Math.round((index / Math.max(totalForIdx, 1)) * 2);
                this.updateProgress(pct, `Indexing: ${index.toLocaleString()}/${totalForIdx.toLocaleString()} nodes`);
            }
        });

        // エントリポイント選択肢を埋める
        this.populateEntryPointSelect();

        // 全エントリポイントを起点としてマルチソースBFS
        this.nodeBfsDepth = this.computeBfsDepths(this.data.entryPoints);
        this.updateProgress(83, `BFS complete: ${this.nodeBfsDepth.size.toLocaleString()}/${this.data.nodes.length.toLocaleString()} nodes mapped`);

        // グラフを初期化
        this.initializeGraph();

        // 統計表示を更新
        this.updateStats();
    }

    /**
     * 統計表示を更新
     */
    private updateStats(): void {
        const stats = document.getElementById('stats-display');
        if (stats && this.data) {
            stats.textContent = `Nodes: ${this.data.nodes.length} | Links: ${this.data.links.length}`;
        }
    }

    /**
     * グラフを初期化（シミュレーション無効、自前アニメーションループ使用）
     */
    private initializeGraph(): void {
        if (!this.data) {return;}

        // 既存のシミュレーションを停止
        this.stopCustomSimulation();

        // 現在のノードレベルに基づいてフィルタリング
        const visibleNodes = this.getVisibleNodes();
        const visibleLinks = this.getVisibleLinks(visibleNodes);
        const totalVisible = visibleNodes.length;
        const totalLinks = visibleLinks.length;
        this.updateProgress(87, `Visible: ${totalVisible.toLocaleString()} nodes, ${totalLinks.toLocaleString()} links`);

        // 表示中のノード・リンクをキャッシュ
        this.currentVisibleNodes = visibleNodes;
        this.currentVisibleLinks = visibleLinks;
        this.highlightedLinks.clear();

        // データを配列に変換
        const positions = new Float32Array(totalVisible * 2);
        const sizes = new Float32Array(totalVisible);
        const colors = new Float32Array(totalVisible * 4);
        const linkArray = new Float32Array(totalLinks * 2);
        const linkWidths = new Float32Array(totalLinks);

        // ノードインデックスのマッピング（フィルタリング後）
        const nodeIndexRemap = new Map<number, number>();
        visibleNodes.forEach((node, newIndex) => {
            const originalIndex = this.data!.nodes.indexOf(node);
            nodeIndexRemap.set(originalIndex, newIndex);
        });

        // ラジアル初期座標を計算（エントリポイントが存在する場合は同心円配置）
        const radialPositions = this.nodeBfsDepth.size > 0
            ? this.computeRadialPositions(visibleNodes, this.nodeBfsDepth)
            : null;

        // 固定ノード・親マップ・径方向ターゲットを構築
        this.simPinnedNodes.clear();
        this.simParentMap.clear();
        this.simFileRadialTargets.clear();
        this.simRemappedLinks = [];

        // ノード配列を構築
        const NODE_BATCH = 500;
        for (let i = 0; i < totalVisible; i++) {
            if (i % NODE_BATCH === 0 && i > 0) {
                const pct = 87 + Math.round((i / Math.max(totalVisible, 1)) * 2);
                this.updateProgress(pct, `Preparing nodes: ${i.toLocaleString()}/${totalVisible.toLocaleString()}`);
            }
            const node = visibleNodes[i];
            // 座標：ラジアル優先、フォールバックは事前計算
            if (radialPositions) {
                positions[i * 2] = radialPositions[i * 2];
                positions[i * 2 + 1] = radialPositions[i * 2 + 1];
            } else {
                positions[i * 2] = node.x;
                positions[i * 2 + 1] = node.y;
            }
            // サイズ・色
            sizes[i] = node.size;
            const color = node.color;
            colors[i * 4] = ((color >> 16) & 0xff) / 255;
            colors[i * 4 + 1] = ((color >> 8) & 0xff) / 255;
            colors[i * 4 + 2] = (color & 0xff) / 255;
            colors[i * 4 + 3] = (node.isDeadCode && node.level === 'file') ? 0.4 : 1.0;

            // ファイルノード: 深度0（エントリポイント）は原点に固定、それ以外は可動＋径方向スプリング
            if (node.level === 'file') {
                const depth = this.nodeBfsDepth.get(node.id);
                if (depth === 0) {
                    // エントリポイントは原点に固定
                    this.simPinnedNodes.add(i);
                } else if (depth !== undefined) {
                    // BFS深度に基づく目標半径を設定（径方向スプリングで維持）
                    this.simFileRadialTargets.set(i, depth * RING_SPACING);
                } else {
                    // BFS到達不能ファイルは初期位置で固定
                    this.simPinnedNodes.add(i);
                }
            }

            // シンボル→親ファイルのマッピング
            if (node.level === 'symbol' && node.parentId) {
                const parentNewIdx = visibleNodes.findIndex(n => n.id === node.parentId);
                if (parentNewIdx !== -1) {
                    this.simParentMap.set(i, parentNewIdx);
                }
            }
        }

        // リンク配列を構築（リマップ済みリンクも保存）
        const LINK_BATCH = 500;
        for (let i = 0; i < totalLinks; i++) {
            if (i % LINK_BATCH === 0 && i > 0) {
                const pct = 89 + Math.round((i / Math.max(totalLinks, 1)) * 2);
                this.updateProgress(pct, `Preparing links: ${i.toLocaleString()}/${totalLinks.toLocaleString()}`);
            }
            const link = visibleLinks[i];
            const sourceNewIndex = nodeIndexRemap.get(link.source);
            const targetNewIndex = nodeIndexRemap.get(link.target);

            if (sourceNewIndex !== undefined && targetNewIndex !== undefined) {
                linkArray[i * 2] = sourceNewIndex;
                linkArray[i * 2 + 1] = targetNewIndex;
                linkWidths[i] = link.width;
                this.simRemappedLinks.push({
                    source: sourceNewIndex,
                    target: targetNewIndex,
                    width: link.width,
                });
            }
        }

        // 既存のグラフを破棄
        if (this.graph) {
            this.graph.destroy();
        }

        // Cosmos.glインスタンスを作成（シミュレーション無効 = 純粋レンダラー）
        try {
            // @ts-ignore - UMDビルドは "Cosmos" として公開
            const Graph = (window as any).Cosmos?.Graph || Cosmos?.Graph;
            if (!Graph) {
                this.log('Cosmos Graph class not found. Make sure @cosmos.gl/graph is loaded.');
                return;
            }

            this.graph = new Graph(this.container, {
                backgroundColor: '#1e1e1e',
                spaceSize: 4096,
                // シミュレーション無効: 自前のアニメーションループで座標を更新
                enableSimulation: false,
                // イベントハンドラ
                onClick: (index: number | undefined) => this.handleNodeClick(index),
                onPointMouseOver: (index: number) => this.handleNodeHover(index),
                onPointMouseOut: () => this.handleNodeHover(undefined),
                onDragStart: (e: any) => this.handleDragStart(e),
                onDrag: (e: any) => this.handleDrag(e),
                onDragEnd: (e: any) => this.handleDragEnd(e),
                enableDrag: true,
                renderLinks: true,
                linkDefaultWidth: 1,
                linkDefaultColor: '#3498DB',
                // 矢印表示（参照元→定義先）
                linkArrowsSizeScale: 1.0,
            });
            this.updateProgress(91, 'Renderer ready');

            // データを設定
            this.graph.setPointPositions(positions);
            this.graph.setPointSizes(sizes);
            this.graph.setPointColors(colors);

            if (visibleLinks.length > 0) {
                this.graph.setLinks(linkArray);
                this.graph.setLinkWidths(linkWidths);

                // 全リンクに矢印を設定（参照元→定義先の方向）
                if (this.graph.setLinkArrows) {
                    const arrows = new Uint8Array(visibleLinks.length);
                    arrows.fill(1); // 全リンクに矢印を表示
                    this.graph.setLinkArrows(arrows);
                }

                // リンク色を設定（通常青 / 循環参照赤）
                const circularLinkSet = new Set(this.data.circularLinkIndices);
                this.originalLinkColors = new Float32Array(visibleLinks.length * 4);
                for (let i = 0; i < visibleLinks.length; i++) {
                    const link = visibleLinks[i];
                    const origIdx = this.data.links.findIndex(
                        l => l.source === link.source && l.target === link.target
                    );
                    const isCircular = origIdx !== -1 && circularLinkSet.has(origIdx) && this.showCircularRefs;
                    if (isCircular) {
                        this.originalLinkColors[i * 4] = 1.0;
                        this.originalLinkColors[i * 4 + 1] = 0.267;
                        this.originalLinkColors[i * 4 + 2] = 0.267;
                        this.originalLinkColors[i * 4 + 3] = 0.9;
                    } else {
                        this.originalLinkColors[i * 4] = 0.204;
                        this.originalLinkColors[i * 4 + 1] = 0.596;
                        this.originalLinkColors[i * 4 + 2] = 0.859;
                        this.originalLinkColors[i * 4 + 3] = 0.7;
                    }
                }

                if (this.graph.setLinkColors) {
                    this.graph.setLinkColors(this.originalLinkColors);
                }
            }

            // シミュレーション用の速度配列を初期化
            this.simPositions = new Float32Array(positions);
            this.simVelocitiesX = new Float32Array(totalVisible);
            this.simVelocitiesY = new Float32Array(totalVisible);
            this.simTickCount = 0;

            // レンダリング開始（事前計算済み座標を使用、シミュレーションはボタンで起動）
            this.updateProgress(95, 'Rendering...');
            this.graph.render();
            this.isSimulating = false;
            this.updateProgress(100, 'Complete');
            this.updateSimulateButton();

            // 初期ビューをフィット
            setTimeout(() => this.fitView(), 500);

            this.log(`Graph initialized: ${visibleNodes.length} nodes, ${visibleLinks.length} links (custom simulation ready)`);
        } catch (error) {
            this.log(`Error initializing graph: ${error}`);
            console.error('Cosmos initialization error:', error);
        }
    }

    // =============================================================
    // 自前力学シミュレーション
    // =============================================================

    /**
     * 自前シミュレーションを開始
     */
    private startCustomSimulation(): void {
        if (this.simAnimationId !== null) { return; } // 既に実行中
        if (!this.graph || !this.simPositions || !this.simVelocitiesX || !this.simVelocitiesY) { return; }

        this.isSimulating = true;
        this.simTickCount = 0;
        this.updateSimulateButton();
        this.log('Custom simulation started');

        const tick = () => {
            if (!this.isSimulating || !this.graph || !this.simPositions || !this.simVelocitiesX || !this.simVelocitiesY) {
                this.simAnimationId = null;
                return;
            }

            const converged = this.simulationTick();
            this.simTickCount++;

            // 座標をCosmos.glに反映して描画
            this.graph.setPointPositions(this.simPositions);
            this.graph.render();

            // 進捗表示
            if (this.simTickCount % 50 === 0) {
                const pct = Math.min(95 + Math.round((this.simTickCount / SIM_MAX_TICKS) * 5), 100);
                this.updateProgress(pct, `Simulating: tick ${this.simTickCount}`);
            }

            // 収束または最大ティック到達で停止
            if (converged || this.simTickCount >= SIM_MAX_TICKS) {
                this.stopCustomSimulation();
                this.updateProgress(100, 'Simulation complete');
                this.log(`Simulation ended: ${this.simTickCount} ticks, converged=${converged}`);
                return;
            }

            this.simAnimationId = requestAnimationFrame(tick);
        };

        this.simAnimationId = requestAnimationFrame(tick);
    }

    /**
     * 自前シミュレーションを停止
     */
    private stopCustomSimulation(): void {
        if (this.simAnimationId !== null) {
            cancelAnimationFrame(this.simAnimationId);
            this.simAnimationId = null;
        }
        this.isSimulating = false;
        this.updateSimulateButton();
    }

    /**
     * 1ティック分の力学計算
     * @returns 収束した場合 true
     */
    private simulationTick(): boolean {
        const pos = this.simPositions!;
        const vx = this.simVelocitiesX!;
        const vy = this.simVelocitiesY!;
        const n = vx.length;

        // 力の蓄積用配列
        const fx = new Float32Array(n);
        const fy = new Float32Array(n);

        // 非固定ノードのインデックスリスト
        const activeIndices: number[] = [];
        for (let i = 0; i < n; i++) {
            if (!this.simPinnedNodes.has(i)) {
                activeIndices.push(i);
            }
        }

        // 1. Barnes-Hut 斥力（全ノードを斥力源に、力はアクティブノードのみに適用）
        // 固定ノード（ファイルノード）も斥力源として含めることで、
        // シンボルがファイルノードを透過して動くのを防ぐ
        if (n > 1) {
            const allIndices: number[] = [];
            for (let i = 0; i < n; i++) { allIndices.push(i); }
            const tree = buildQuadTreeSimple(pos, allIndices, this.graph.getPointSizes?.() || new Float32Array(n));
            for (const i of activeIndices) {
                barnesHutRepulsion(tree, pos[i * 2], pos[i * 2 + 1], i, SIM_BARNES_HUT_THETA, fx, fy);
            }
        }

        // 2. エッジ引力（エッジ幅に比例）
        for (const link of this.simRemappedLinks) {
            const si = link.source;
            const ti = link.target;
            const dx = pos[ti * 2] - pos[si * 2];
            const dy = pos[ti * 2 + 1] - pos[si * 2 + 1];
            const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
            const spring = SIM_LINK_SPRING_BASE + link.width * SIM_LINK_SPRING_PER_WIDTH;
            const displacement = dist - SIM_LINK_REST_LENGTH;
            const force = spring * displacement;
            const forceX = (dx / dist) * force;
            const forceY = (dy / dist) * force;

            if (!this.simPinnedNodes.has(si)) {
                fx[si] += forceX;
                fy[si] += forceY;
            }
            if (!this.simPinnedNodes.has(ti)) {
                fx[ti] -= forceX;
                fy[ti] -= forceY;
            }
        }

        // 3. シンボル→親ファイルへの引力
        for (const [symIdx, parentIdx] of this.simParentMap) {
            if (this.simPinnedNodes.has(symIdx)) { continue; }
            const dx = pos[parentIdx * 2] - pos[symIdx * 2];
            const dy = pos[parentIdx * 2 + 1] - pos[symIdx * 2 + 1];
            const dist = Math.sqrt(dx * dx + dy * dy) + 0.001;
            const displacement = dist - SIM_SYMBOL_PARENT_REST_LENGTH;
            const force = SIM_SYMBOL_PARENT_SPRING * displacement;
            fx[symIdx] += (dx / dist) * force;
            fy[symIdx] += (dy / dist) * force;
        }

        // 4. ファイルノードの径方向スプリング（BFS深度リングの半径を維持）
        // 半径方向にのみ復元力を適用し、角度方向は自由に動ける
        for (const [fileIdx, targetRadius] of this.simFileRadialTargets) {
            const px = pos[fileIdx * 2];
            const py = pos[fileIdx * 2 + 1];
            const currentRadius = Math.sqrt(px * px + py * py) + 0.001;
            const radialDisplacement = currentRadius - targetRadius;
            // 半径方向の単位ベクトル（原点→ノード方向）
            const ux = px / currentRadius;
            const uy = py / currentRadius;
            // 半径方向にのみ復元力を適用（内側に引き戻す or 外側に押し出す）
            const radialForce = -SIM_FILE_RADIAL_SPRING * radialDisplacement;
            fx[fileIdx] += ux * radialForce;
            fy[fileIdx] += uy * radialForce;
        }

        // 5. 速度更新 + 摩擦 + 位置更新
        let totalKineticEnergy = 0;
        for (const i of activeIndices) {
            vx[i] = (vx[i] + fx[i]) * SIM_FRICTION;
            vy[i] = (vy[i] + fy[i]) * SIM_FRICTION;

            // 最大速度制限
            const speed = Math.sqrt(vx[i] * vx[i] + vy[i] * vy[i]);
            if (speed > SIM_MAX_VELOCITY) {
                const scale = SIM_MAX_VELOCITY / speed;
                vx[i] *= scale;
                vy[i] *= scale;
            }

            pos[i * 2] += vx[i];
            pos[i * 2 + 1] += vy[i];

            totalKineticEnergy += vx[i] * vx[i] + vy[i] * vy[i];
        }

        // 収束判定
        const avgEnergy = activeIndices.length > 0 ? totalKineticEnergy / activeIndices.length : 0;
        return avgEnergy < SIM_CONVERGENCE_THRESHOLD;
    }

    /**
     * 表示ノードを取得（深度・デッドコードフィルタ適用）
     */
    private getVisibleNodes(): CosmosNodeData[] {
        if (!this.data) { return []; }

        // ファイルノードを深度・デッドコードでフィルタ
        const visibleFileIds = new Set<string>();
        for (const node of this.data.nodes) {
            if (node.level !== 'file') { continue; }

            // デッドコードフィルタ
            if (!this.showDeadCode && node.isDeadCode) { continue; }

            // 深度フィルタ（エントリポイントが存在する場合のみ）
            if (this.nodeBfsDepth.size > 0) {
                const depth = this.nodeBfsDepth.get(node.id);
                if (depth === undefined) {
                    // 到達不能ノード：deathCode扱いで showDeadCode が false なら除外
                    if (!this.showDeadCode) { continue; }
                } else if (depth < this.minDepth || depth > this.maxDepth) {
                    continue;
                }
            }

            visibleFileIds.add(node.id);
        }

        return this.data.nodes.filter(node => {
            if (node.level === 'file') {
                return visibleFileIds.has(node.id);
            } else if (node.level === 'directory') {
                return false; // ディレクトリノードは非表示
            } else {
                // シンボル：シンボル表示がOFF の場合は除外
                if (!this.showSymbols) { return false; }
                // 親ファイルが表示されていれば表示
                return node.parentId ? visibleFileIds.has(node.parentId) : false;
            }
        });
    }

    /**
     * 表示ノードに基づいてリンクを取得
     * - showSymbols=true:  symbol レベルのリンクのみ（§2-2-1）
     * - showSymbols=false: file レベルのリンクのみ（§2-2-4）
     * - level 未設定（旧データ）: 両方を通過させる
     */
    private getVisibleLinks(visibleNodes: CosmosNodeData[]): CosmosLinkData[] {
        if (!this.data) {return [];}

        const visibleIndices = new Set<number>();
        visibleNodes.forEach(node => {
            const index = this.data!.nodes.indexOf(node);
            if (index !== -1) {
                visibleIndices.add(index);
            }
        });

        return this.data.links.filter(link => {
            if (!visibleIndices.has(link.source) || !visibleIndices.has(link.target)) {
                return false;
            }
            const level = link.level ?? (this.showSymbols ? 'symbol' : 'file');
            return this.showSymbols ? level === 'symbol' : level === 'file';
        });
    }

    /**
     * ノードクリック処理
     */
    private handleNodeClick(index: number | undefined): void {
        if (index === undefined || !this.data) {return;}

        const visibleNodes = this.getVisibleNodes();
        const node = visibleNodes[index];
        if (!node) {return;}

        this.selectedNodeId = node.id;

        // ファイルまたはシンボルの場合、エディタで開く
        if (node.level === 'file' || node.level === 'symbol') {
            this.postMessage({
                type: 'openFile',
                path: node.path,
                line: node.line,
            });
        }
    }

    /**
     * ノードホバー処理
     */
    private handleNodeHover(index: number | undefined): void {
        // 既存のツールチップタイマーをキャンセル
        if (this.tooltipTimerId !== null) {
            window.clearTimeout(this.tooltipTimerId);
            this.tooltipTimerId = null;
        }

        if (index === undefined || !this.data || !this.tooltip) {
            this.hideTooltip();
            this.hoveredNodeIndex = null;
            this.clearLinkHighlights();
            return;
        }

        this.hoveredNodeIndex = index;
        const node = this.currentVisibleNodes[index];
        if (!node) {return;}

        // 元のデータでのインデックスを取得
        const originalIndex = this.data.nodes.indexOf(node);

        // 関連リンクをハイライト（即座に実行）
        this.highlightLinksForNode(originalIndex);

        // 0.2秒後にツールチップを表示
        this.tooltipTimerId = window.setTimeout(() => {
            this.tooltipTimerId = null;

            // タイマー発火時にまだ同じノードをホバーしているか確認
            if (this.hoveredNodeIndex !== index) {return;}

            // ツールチップ内容を生成
            let content = `<div class="tooltip-header">`;
            content += `<span class="tooltip-icon">${this.getNodeIcon(node)}</span>`;
            content += `<strong>${node.label}</strong>`;
            content += `</div>`;
            content += `<div class="tooltip-path">${node.path}</div>`;

            if (node.level === 'directory') {
                content += `<div class="tooltip-info">${node.childCount} files</div>`;
            } else if (node.level === 'file') {
                content += `<div class="tooltip-info">${node.childCount} symbols | ${node.lineCount} lines</div>`;
                // 保守性情報
                if (node.isEntryPoint) {
                    content += `<div class="tooltip-info" style="color:#2196F3">🚀 Entry Point</div>`;
                }
                if (node.isDeadCode) {
                    content += `<div class="tooltip-info" style="color:#9E9E9E">💀 Dead Code</div>`;
                }
                if (node.isCyclic) {
                    content += `<div class="tooltip-info" style="color:#FF9800">🔄 Circular Ref</div>`;
                }
                const depth = this.nodeBfsDepth.get(node.id);
                if (depth !== undefined) {
                    content += `<div class="tooltip-info">Depth: ${depth} | In: ${node.inDegree} | Out: ${node.outDegree}</div>`;
                }
                const scoreLabel = node.maintenanceScore < 0.33 ? '良好' :
                                   node.maintenanceScore < 0.5  ? '注意' :
                                   node.maintenanceScore < 0.66 ? '警告' : '危険';
                content += `<div class="tooltip-info">保守性: ${scoreLabel} (score: ${node.maintenanceScore.toFixed(2)})</div>`;
            } else if (node.line !== undefined) {
                content += `<div class="tooltip-info">Line ${node.line + 1} | ${node.lineCount} lines</div>`;
            }

            // 関係線の情報を追加（改善版）
            const relatedLinks = this.data!.links.filter(
                l => l.source === originalIndex || l.target === originalIndex
            );

            if (relatedLinks.length > 0) {
                content += `<hr>`;
                content += `<div class="tooltip-connections">`;
                content += `<strong>🔗 ${relatedLinks.length} connections</strong>`;
                content += `</div>`;

                // 出力方向と入力方向を分けて表示
                const outgoing: Array<{ detail: CosmosLinkData['details'][0], link: CosmosLinkData }> = [];
                const incoming: Array<{ detail: CosmosLinkData['details'][0], link: CosmosLinkData }> = [];

                for (const link of relatedLinks) {
                    for (const detail of link.details.slice(0, 3)) {
                        if (link.source === originalIndex) {
                            outgoing.push({ detail, link });
                        } else {
                            incoming.push({ detail, link });
                        }
                    }
                }

                // 出力方向（このノードから参照）
                if (outgoing.length > 0) {
                    content += `<div class="tooltip-section">`;
                    content += `<span class="tooltip-label">→ References:</span>`;
                    for (const { detail } of outgoing.slice(0, 3)) {
                        content += `<a href="#" class="tooltip-link tooltip-outgoing" `;
                        content += `data-path="${detail.targetPath}" data-line="${detail.targetLine}">`;
                        content += `${detail.targetName}`;
                        content += `<span class="tooltip-location">${detail.targetPath.split('/').pop()}:${detail.targetLine + 1}</span>`;
                        content += `</a>`;
                    }
                    if (outgoing.length > 3) {
                        content += `<span class="tooltip-more">+${outgoing.length - 3} more</span>`;
                    }
                    content += `</div>`;
                }

                // 入力方向（このノードを参照）
                if (incoming.length > 0) {
                    content += `<div class="tooltip-section">`;
                    content += `<span class="tooltip-label">← Referenced by:</span>`;
                    for (const { detail } of incoming.slice(0, 3)) {
                        content += `<a href="#" class="tooltip-link tooltip-incoming" `;
                        content += `data-path="${detail.sourcePath}" data-line="${detail.sourceLine}">`;
                        content += `${detail.sourceName}`;
                        content += `<span class="tooltip-location">${detail.sourcePath.split('/').pop()}:${detail.sourceLine + 1}</span>`;
                        content += `</a>`;
                    }
                    if (incoming.length > 3) {
                        content += `<span class="tooltip-more">+${incoming.length - 3} more</span>`;
                    }
                    content += `</div>`;
                }
            }

            this.showTooltip(content);
        }, 200);  // 0.2秒 = 200ミリ秒
    }

    /**
     * ドラッグ開始処理
     * 関連ノードの影響度を計算
     * @param e D3DragEvent - subject.indexでドラッグ対象のノードインデックスを取得
     */
    private handleDragStart(e: any): void {
        // D3DragEventのsubjectにindexがない場合、ホバー中のノードを使用
        let index = e?.subject?.index;
        if (index === undefined) {
            // ホバー中のノードをドラッグ対象として使用
            index = this.hoveredNodeIndex ?? undefined;
        }

        if (index === undefined || !this.data || !this.graph) {
            return;
        }

        this.log(`DragStart: node ${index} (hovered=${this.hoveredNodeIndex})`);

        this.draggedNodeIndex = index;
        this.relatedNodeInfluence.clear();

        // 現在の全ノード位置を保存
        const positions = this.graph.getPointPositions();
        if (positions) {
            this.dragStartPositions = new Float32Array(positions);
        }

        // 元のデータでのノードインデックスを取得
        const node = this.currentVisibleNodes[index];
        if (!node) {return;}
        const originalNodeIndex = this.data.nodes.indexOf(node);

        // 1. 子ノードを100%の影響度で追加（ファイル→シンボル、ディレクトリ→ファイル→シンボル）
        this.addChildNodesInfluence(node.id, 1.0);

        // 2. リンクに基づく関連ノードとその接続強度を計算
        const connectionCounts = new Map<number, number>();

        for (const link of this.data.links) {
            if (link.source === originalNodeIndex) {
                const targetNode = this.data.nodes[link.target];
                const visibleIndex = this.currentVisibleNodes.indexOf(targetNode);
                if (visibleIndex !== -1 && visibleIndex !== index && !this.relatedNodeInfluence.has(visibleIndex)) {
                    const count = connectionCounts.get(visibleIndex) || 0;
                    connectionCounts.set(visibleIndex, count + link.details.length);
                }
            }
            if (link.target === originalNodeIndex) {
                const sourceNode = this.data.nodes[link.source];
                const visibleIndex = this.currentVisibleNodes.indexOf(sourceNode);
                if (visibleIndex !== -1 && visibleIndex !== index && !this.relatedNodeInfluence.has(visibleIndex)) {
                    const count = connectionCounts.get(visibleIndex) || 0;
                    connectionCounts.set(visibleIndex, count + link.details.length);
                }
            }
        }

        // 接続強度を正規化して影響度に変換 (0.1 - 0.8の範囲)
        if (connectionCounts.size > 0) {
            const maxCount = Math.max(...connectionCounts.values());
            for (const [nodeIdx, count] of connectionCounts) {
                // 接続が多いほど強く追従 (最大で80%、最小で10%)
                const influence = 0.1 + (count / maxCount) * 0.7;
                this.relatedNodeInfluence.set(nodeIdx, influence);
            }
        }

        this.dragLogCount = 0; // ログカウンターリセット
        this.log(`Drag started: node ${index}, ${this.relatedNodeInfluence.size} related nodes`);
    }

    /**
     * 子ノードを再帰的に影響度マップに追加
     * @param parentId 親ノードのID
     * @param influence 影響度（子ノードは100%で追従）
     */
    private addChildNodesInfluence(parentId: string, influence: number): void {
        if (!this.data) {return;}

        // 指定された親IDを持つ全ての子ノードを検索
        for (let i = 0; i < this.data.nodes.length; i++) {
            const childNode = this.data.nodes[i];
            if (childNode.parentId === parentId) {
                // 表示中のノードかどうか確認
                const visibleIndex = this.currentVisibleNodes.indexOf(childNode);
                if (visibleIndex !== -1 && visibleIndex !== this.draggedNodeIndex) {
                    // 子ノードを影響度マップに追加
                    this.relatedNodeInfluence.set(visibleIndex, influence);
                }
                // 孫ノードも再帰的に追加（ディレクトリ→ファイル→シンボル）
                this.addChildNodesInfluence(childNode.id, influence);
            }
        }
    }

    /**
     * ドラッグ中の処理
     * 関連ノードを影響度に応じて移動
     * @param e D3DragEvent - subject.indexでドラッグ対象のノードインデックスを取得
     */
    // ドラッグログカウンター（ログ出力を制限）
    private dragLogCount = 0;

    private handleDrag(e: any): void {
        // ドラッグ中はdraggedNodeIndexを使用
        if (this.draggedNodeIndex === null || !this.graph || !this.dragStartPositions) {return;}
        if (this.relatedNodeInfluence.size === 0) {return;}

        const index = this.draggedNodeIndex;

        // 現在のノード位置を取得
        const positions = this.graph.getPointPositions();
        if (!positions) {
            if (this.dragLogCount++ < 3) {
                this.log(`Drag: getPointPositions returned null`);
            }
            return;
        }

        // ドラッグ対象ノードの現在位置と開始位置から移動量を計算
        const draggedX = positions[index * 2];
        const draggedY = positions[index * 2 + 1];
        const startX = this.dragStartPositions[index * 2];
        const startY = this.dragStartPositions[index * 2 + 1];
        const totalDx = draggedX - startX;
        const totalDy = draggedY - startY;

        // デバッグログ（最初の数回のみ）
        if (this.dragLogCount++ < 5) {
            this.log(`Drag: current=(${draggedX.toFixed(1)},${draggedY.toFixed(1)}), start=(${startX.toFixed(1)},${startY.toFixed(1)}), delta=(${totalDx.toFixed(1)},${totalDy.toFixed(1)})`);
        }

        // 移動量が小さすぎる場合はスキップ
        if (Math.abs(totalDx) < 0.1 && Math.abs(totalDy) < 0.1) {return;}

        // 関連ノードの位置を更新
        const newPositions = new Float32Array(positions);
        let updatedCount = 0;
        for (const [nodeIdx, influence] of this.relatedNodeInfluence) {
            const baseX = this.dragStartPositions[nodeIdx * 2];
            const baseY = this.dragStartPositions[nodeIdx * 2 + 1];
            newPositions[nodeIdx * 2] = baseX + totalDx * influence;
            newPositions[nodeIdx * 2 + 1] = baseY + totalDy * influence;
            updatedCount++;
        }

        // デバッグ: 最初の1回だけ詳細ログ
        if (this.dragLogCount === 5) {
            this.log(`Drag: updating ${updatedCount} related nodes, positions length=${newPositions.length}`);
        }

        // 関連ノードの位置のみを更新（ドラッグ対象ノードはCosmos.glが管理）
        this.graph.setPointPositions(newPositions);
    }

    /**
     * ドラッグ終了処理
     * @param e D3DragEvent - subject.indexでドラッグ対象のノードインデックスを取得
     */
    private handleDragEnd(e: any): void {
        // ドラッグ中はdraggedNodeIndexを使用
        if (this.draggedNodeIndex === null) {return;}
        const index = this.draggedNodeIndex;

        // 最終位置をデータに反映
        if (this.graph && this.currentVisibleNodes.length > 0) {
            const positions = this.graph.getPointPositions();
            if (positions) {
                for (let i = 0; i < this.currentVisibleNodes.length; i++) {
                    const node = this.currentVisibleNodes[i];
                    node.x = positions[i * 2];
                    node.y = positions[i * 2 + 1];
                }
            }
        }

        this.log(`Drag ended: node ${index}`);
        this.draggedNodeIndex = null;
        this.dragStartPositions = null;
        this.relatedNodeInfluence.clear();
    }

    /**
     * ノードアイコンを取得
     */
    private getNodeIcon(node: CosmosNodeData): string {
        if (node.level === 'directory') {
            return '📁';
        } else if (node.level === 'file') {
            return '📄';
        } else {
            // シンボル種別に応じたアイコン
            switch (node.kind) {
                case 4: return '🏛️';  // Class
                case 10: return '🔧';  // Interface
                case 11: return '⚡';  // Function
                case 5: return '🔹';  // Method
                case 12: return '📊';  // Variable
                case 13: return '🔒';  // Constant
                case 9: return '📋';  // Enum
                default: return '◉';
            }
        }
    }

    /**
     * 指定ノードに接続されたリンクをハイライト
     */
    private highlightLinksForNode(originalNodeIndex: number): void {
        if (!this.data || !this.graph || this.currentVisibleLinks.length === 0) {return;}

        // リマップされたインデックスを取得
        const nodeIndexRemap = new Map<number, number>();
        this.currentVisibleNodes.forEach((node, newIndex) => {
            const origIndex = this.data!.nodes.indexOf(node);
            nodeIndexRemap.set(origIndex, newIndex);
        });

        const remappedNodeIndex = nodeIndexRemap.get(originalNodeIndex);
        if (remappedNodeIndex === undefined) {return;}

        // ハイライトするリンクを特定
        this.highlightedLinks.clear();
        const linkColors = new Float32Array(this.currentVisibleLinks.length * 4);

        for (let i = 0; i < this.currentVisibleLinks.length; i++) {
            const link = this.currentVisibleLinks[i];
            const sourceRemap = nodeIndexRemap.get(link.source);
            const targetRemap = nodeIndexRemap.get(link.target);

            if (sourceRemap === remappedNodeIndex || targetRemap === remappedNodeIndex) {
                // ハイライト色（オレンジ）
                this.highlightedLinks.add(i);
                linkColors[i * 4] = 1.0;      // R
                linkColors[i * 4 + 1] = 0.6;  // G
                linkColors[i * 4 + 2] = 0.0;  // B
                linkColors[i * 4 + 3] = 0.9;  // A
            } else {
                // 元の色（薄い青 #3498DB）
                linkColors[i * 4] = 0.204;
                linkColors[i * 4 + 1] = 0.596;
                linkColors[i * 4 + 2] = 0.859;
                linkColors[i * 4 + 3] = 0.2;
            }
        }

        // リンク色を更新
        try {
            if (this.graph.setLinkColors) {
                this.graph.setLinkColors(linkColors);
            }
        } catch (e) {
            // Cosmos.glバージョンによってはsetLinkColorsが無い場合がある
            this.log(`Link color update not supported: ${e}`);
        }
    }

    /**
     * リンクハイライトをクリア
     */
    private clearLinkHighlights(): void {
        if (!this.graph || !this.originalLinkColors || this.highlightedLinks.size === 0) {return;}

        this.highlightedLinks.clear();

        // 元の色に戻す
        try {
            if (this.graph.setLinkColors) {
                this.graph.setLinkColors(this.originalLinkColors);
            }
        } catch (e) {
            // 無視
        }
    }

    /**
     * ツールチップを表示
     */
    private showTooltip(content: string): void {
        if (!this.tooltip) {return;}

        this.tooltip.innerHTML = content;
        this.tooltip.style.display = 'block';

        // マウス位置を追跡
        document.addEventListener('mousemove', this.updateTooltipPosition);

        // リンククリックイベント
        const links = this.tooltip.querySelectorAll('.tooltip-link');
        links.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const path = (link as HTMLElement).dataset.path;
                const line = parseInt((link as HTMLElement).dataset.line || '0');
                this.postMessage({
                    type: 'openFile',
                    path: path,
                    line: line,
                });
            });
        });
    }

    /**
     * ツールチップ位置を更新
     */
    private updateTooltipPosition = (e: MouseEvent): void => {
        if (this.tooltip) {
            this.tooltip.style.left = `${e.clientX + 10}px`;
            this.tooltip.style.top = `${e.clientY + 10}px`;
        }
    };

    /**
     * ツールチップを非表示
     */
    private hideTooltip(): void {
        // ツールチップタイマーをキャンセル
        if (this.tooltipTimerId !== null) {
            window.clearTimeout(this.tooltipTimerId);
            this.tooltipTimerId = null;
        }

        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
        document.removeEventListener('mousemove', this.updateTooltipPosition);
    }

    /**
     * ノードをハイライト
     */
    private highlightNode(nodeId: string): void {
        if (!this.data || !this.graph) {return;}

        const nodeIndex = this.nodeIndexMap.get(nodeId);
        if (nodeIndex === undefined) {return;}

        // 選択状態を設定
        this.graph.selectPointByIndex(nodeIndex, true);

        // 3秒後に選択解除
        setTimeout(() => {
            this.graph.unselectPoints();
        }, 3000);
    }

    /**
     * 特定ノードにズーム
     */
    private zoomToNode(nodeId: string): void {
        if (!this.data || !this.graph) {return;}

        const visibleNodes = this.getVisibleNodes();
        const nodeIndex = visibleNodes.findIndex(n => n.id === nodeId);
        if (nodeIndex === -1) {return;}

        this.graph.zoomToPointByIndex(nodeIndex, 500, 2);
    }

    /**
     * 複数ノードを含む範囲にズーム
     */
    private zoomToNodes(nodeIds: string[]): void {
        if (!this.data || !this.graph || nodeIds.length === 0) {return;}

        const visibleNodes = this.getVisibleNodes();
        const indices = nodeIds
            .map(id => visibleNodes.findIndex(n => n.id === id))
            .filter(i => i !== -1);

        if (indices.length > 0) {
            this.graph.fitViewByPointIndices(indices, 500, 0.1);
        }
    }

    /**
     * ビューをフィット
     */
    private fitView(): void {
        if (this.graph) {
            this.graph.fitView(300, 0.1);
        }
    }

    /**
     * ビューをリセット
     */
    private resetView(): void {
        if (this.graph) {
            this.graph.fitView(300, 0.1);
            this.graph.setZoomLevel(1, 300);
        }
    }

    /**
     * エディタカーソル変更時
     */
    private onEditorCursorChange(filePath: string, line: number): void {
        if (!this.data) {return;}

        // 該当行のシンボルを探す
        const symbol = this.data.nodes.find(
            n => n.level === 'symbol' &&
                 n.path === filePath &&
                 n.line !== undefined &&
                 Math.abs(n.line - line) < 10
        );

        if (symbol) {
            this.highlightNode(symbol.id);
            this.zoomToNode(symbol.id);
        }
    }

    /**
     * エディタでファイルが開かれた時
     */
    private onEditorFileOpen(filePath: string): void {
        if (!this.data) {return;}

        const file = this.data.nodes.find(
            n => n.level === 'file' && n.path === filePath
        );

        if (file) {
            // 関連ノードを取得
            const relatedIds = this.getRelatedNodeIds(file.id);
            this.zoomToNodes([file.id, ...relatedIds]);
        }
    }

    /**
     * 特定ファイルにズーム
     */
    private onZoomToFile(filePath: string): void {
        if (!this.data) {return;}

        const file = this.data.nodes.find(
            n => n.level === 'file' && n.path === filePath
        );

        if (file) {
            this.highlightNode(file.id);
            this.zoomToNode(file.id);
            this.log(`Zoomed to file: ${filePath}`);
        } else {
            this.log(`File not found in graph: ${filePath}`);
        }
    }

    /**
     * 関連コードを表示（選択範囲のシンボルとその依存関係）
     */
    private onShowRelatedCode(filePath: string, startLine: number, endLine: number): void {
        if (!this.data) {return;}

        // 選択範囲内のシンボルを探す
        const symbolsInRange = this.data.nodes.filter(
            n => n.level === 'symbol' &&
                 n.path === filePath &&
                 n.line !== undefined &&
                 n.line >= startLine &&
                 n.line <= endLine
        );

        if (symbolsInRange.length === 0) {
            // シンボルが見つからない場合はファイルレベルで表示
            this.onZoomToFile(filePath);
            return;
        }

        // 選択されたシンボルの関連ノードを取得
        const relatedIds = new Set<string>();
        symbolsInRange.forEach(symbol => {
            relatedIds.add(symbol.id);
            this.getRelatedNodeIds(symbol.id).forEach(id => relatedIds.add(id));
        });

        // 関連ノードにズーム
        const nodeIds = Array.from(relatedIds);
        this.zoomToNodes(nodeIds);

        // 最初のシンボルをハイライト
        if (symbolsInRange.length > 0) {
            this.highlightNode(symbolsInRange[0].id);
        }

        this.log(`Showing ${symbolsInRange.length} symbols with ${nodeIds.length} related nodes`);
    }

    /**
     * 関連ノードIDを取得
     */
    private getRelatedNodeIds(nodeId: string): string[] {
        if (!this.data) {return [];}

        const nodeIndex = this.nodeIndexMap.get(nodeId);
        if (nodeIndex === undefined) {return [];}

        const related = new Set<string>();

        for (const link of this.data.links) {
            if (link.source === nodeIndex) {
                related.add(this.data.nodes[link.target].id);
            }
            if (link.target === nodeIndex) {
                related.add(this.data.nodes[link.source].id);
            }
        }

        return Array.from(related);
    }

    /**
     * VS Codeにメッセージを送信
     */
    private postMessage(message: any): void {
        if (this.vscode) {
            this.vscode.postMessage(message);
        }
    }

    /**
     * ログ出力
     */
    private log(message: string): void {
        console.log(`[GraphView] ${message}`);
        this.postMessage({
            type: 'webviewLog',
            level: 'info',
            message: `[GraphView] ${message}`,
        });
    }

    /**
     * HTMLエクスポートを実行
     */
    public exportStandaloneHTML(): void {
        if (!this.data) {
            this.log('No data to export');
            return;
        }

        this.log('Starting HTML export...');

        // グラフデータを収集
        const exportData = {
            nodes: this.data.nodes.map(node => ({
                id: node.id,
                x: node.x,
                y: node.y,
                size: node.size,
                color: node.color,
                parentId: node.parentId,
                level: node.level,
                label: node.label,
                path: node.path,
                kind: node.kind,
                line: node.line,
                communityId: node.communityId,
                childCount: node.childCount,
                visible: node.visible,
                lineCount: node.lineCount,
                inDegree: node.inDegree,
                outDegree: node.outDegree,
                isEntryPoint: node.isEntryPoint,
                isDeadCode: node.isDeadCode,
                isCyclic: node.isCyclic,
                maintenanceScore: node.maintenanceScore,
                hotspotScore: node.hotspotScore
            })),
            links: this.data.links.map(link => ({
                source: link.source,
                target: link.target,
                width: link.width,
                color: link.color,
                details: link.details,
                level: link.level,
            })),
            directories: this.data.directories,
            entryPoints: this.data.entryPoints,
            circularLinkIndices: this.data.circularLinkIndices
        };

        // 拡張機能にエクスポートリクエストを送信
        this.postMessage({
            type: 'exportStandaloneHTML',
            data: exportData
        });

        this.log(`Export data prepared: ${exportData.nodes.length} nodes, ${exportData.links.length} links`);
    }

    /**
     * スタンドアロンモード用：グローバルデータを読み込み
     */
    public loadStandaloneData(data: GraphData): void {
        this.log(`Loading standalone data: ${data.nodes.length} nodes, ${data.links.length} links`);
        this.setGraphData(data);
    }
}

// グローバルインスタンス
let graphView: GraphView | null = null;

/**
 * 初期化
 */
function initView(): void {
    graphView = new GraphView('graph-container');

    // スタンドアロンモードの場合、グローバルデータを読み込み
    if (typeof IS_STANDALONE !== 'undefined' && IS_STANDALONE) {
        if (typeof STANDALONE_GRAPH_DATA !== 'undefined' && STANDALONE_GRAPH_DATA) {
            console.log('[GraphView] Loading standalone data...');
            // 少し遅延させてグラフの初期化を待つ
            setTimeout(() => {
                if (graphView) {
                    graphView.loadStandaloneData(STANDALONE_GRAPH_DATA);
                }
            }, 100);
        } else {
            console.error('[GraphView] Standalone mode but no STANDALONE_GRAPH_DATA found');
        }
    }
}

/**
 * HTMLエクスポート(グローバル関数): HTMLテンプレートのボタンから呼び出される
 */
function exportHTML(): void {
    if (graphView) {
        graphView.exportStandaloneHTML();
    } else {
        console.error('Graph view not initialized');
    }
}

// グローバルスコープに公開
(window as any).exportHTML = exportHTML;

// DOMロード後に初期化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initView);
} else {
    initView();
}
