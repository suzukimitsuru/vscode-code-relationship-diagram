/**
 * Graph View
 *
 * Cosmos.glを使用したグラフ可視化コンポーネント
 * WebView内で動作する
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

// Phase 5: スタンドアロン用グラフデータ
declare const COSMOS_GRAPH_DATA: {
    nodes: CosmosNodeData[];
    links: CosmosLinkData[];
    directories: string[];
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
}

/**
 * グラフデータ
 */
interface GraphData {
    nodes: CosmosNodeData[];
    links: CosmosLinkData[];
    directories: string[];
}

/**
 * Cosmos.glグラフビュークラス
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

    // Phase 3: リンク関連の状態
    private highlightedLinks: Set<number> = new Set();
    private originalLinkColors: Float32Array | null = null;
    private currentVisibleNodes: CosmosNodeData[] = [];
    private currentVisibleLinks: CosmosLinkData[] = [];

    // ドラッグ関連の状態
    private draggedNodeIndex: number | null = null;
    private dragStartPositions: Float32Array | null = null;
    private relatedNodeInfluence: Map<number, number> = new Map(); // ノードインデックス -> 影響度(0-1)

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
        this.tooltip = document.getElementById('cosmos-tooltip') as HTMLElement;
        if (!this.tooltip) {
            this.tooltip = document.createElement('div');
            this.tooltip.className = 'cosmos-tooltip';
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

        // Pan circle control
        this.setupPanControl();

        // Zoom controls
        this.setupZoomControls();
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

            // Phase 4: 新しいコマンド用ハンドラ
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
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');

        if (progressBar) {
            progressBar.style.width = `${percent}%`;
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
        this.data = data;

        // ノードIDインデックスを作成
        this.nodeIndexMap.clear();
        data.nodes.forEach((node, index) => {
            this.nodeIndexMap.set(node.id, index);
        });

        // Cosmos.glグラフを初期化
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
     * Cosmos.glグラフを初期化
     */
    private initializeGraph(): void {
        if (!this.data) {return;}

        // 現在のノードレベルに基づいてフィルタリング
        const visibleNodes = this.getVisibleNodes();
        const visibleLinks = this.getVisibleLinks(visibleNodes);

        // Phase 3: 表示中のノード・リンクをキャッシュ
        this.currentVisibleNodes = visibleNodes;
        this.currentVisibleLinks = visibleLinks;
        this.highlightedLinks.clear();

        // データを配列に変換
        const positions = new Float32Array(visibleNodes.length * 2);
        const sizes = new Float32Array(visibleNodes.length);
        const colors = new Float32Array(visibleNodes.length * 4);
        const linkArray = new Float32Array(visibleLinks.length * 2);
        const linkWidths = new Float32Array(visibleLinks.length);

        // ノードインデックスのマッピング（フィルタリング後）
        const nodeIndexRemap = new Map<number, number>();
        visibleNodes.forEach((node, newIndex) => {
            const originalIndex = this.data!.nodes.indexOf(node);
            nodeIndexRemap.set(originalIndex, newIndex);
        });

        for (let i = 0; i < visibleNodes.length; i++) {
            const node = visibleNodes[i];
            positions[i * 2] = node.x;
            positions[i * 2 + 1] = node.y;
            sizes[i] = node.size;

            const color = node.color;
            colors[i * 4] = ((color >> 16) & 0xff) / 255;
            colors[i * 4 + 1] = ((color >> 8) & 0xff) / 255;
            colors[i * 4 + 2] = (color & 0xff) / 255;
            colors[i * 4 + 3] = node.visible ? 1.0 : 0.1;
        }

        for (let i = 0; i < visibleLinks.length; i++) {
            const link = visibleLinks[i];
            const sourceNewIndex = nodeIndexRemap.get(link.source);
            const targetNewIndex = nodeIndexRemap.get(link.target);

            if (sourceNewIndex !== undefined && targetNewIndex !== undefined) {
                linkArray[i * 2] = sourceNewIndex;
                linkArray[i * 2 + 1] = targetNewIndex;
                linkWidths[i] = link.width;
            }
        }

        // 既存のグラフを破棄
        if (this.graph) {
            this.graph.destroy();
        }

        // Cosmos.glインスタンスを作成
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
                // シミュレーション設定（v2形式）
                enableSimulation: false, // 事前計算された座標を使用
                simulationRepulsion: 0.5,
                simulationGravity: 0.1,
                simulationFriction: 0.85,
                simulationDecay: 1000,
                // イベントハンドラ（トップレベルに直接設定）
                onClick: (index: number | undefined) => this.handleNodeClick(index),
                onPointMouseOver: (index: number) => this.handleNodeHover(index),
                onPointMouseOut: () => this.handleNodeHover(undefined),
                onDragStart: (e: any) => this.handleDragStart(e),
                onDrag: (e: any) => this.handleDrag(e),
                onDragEnd: (e: any) => this.handleDragEnd(e),
                // ノードをマウスでドラッグ可能にする
                enableDrag: true,
                renderLinks: true,
                linkDefaultWidth: 1,
                // #3498DB (graph-view.htmlと同じ青色) - RGBA 0-255形式
                linkDefaultColor: '#3498DB',
            });

            // データを設定
            this.graph.setPointPositions(positions);
            this.graph.setPointSizes(sizes);
            this.graph.setPointColors(colors);

            if (visibleLinks.length > 0) {
                this.graph.setLinks(linkArray);
                this.graph.setLinkWidths(linkWidths);

                // リンク色を設定（#3498DB 青）
                this.originalLinkColors = new Float32Array(visibleLinks.length * 4);
                for (let i = 0; i < visibleLinks.length; i++) {
                    this.originalLinkColors[i * 4] = 0.204;      // R
                    this.originalLinkColors[i * 4 + 1] = 0.596;  // G
                    this.originalLinkColors[i * 4 + 2] = 0.859;  // B
                    this.originalLinkColors[i * 4 + 3] = 0.7;    // A
                }

                // リンク色を明示的に適用
                if (this.graph.setLinkColors) {
                    this.graph.setLinkColors(this.originalLinkColors);
                }
            }

            // レンダリング開始（シミュレーションは停止）
            this.graph.render(0);

            // 初期ビューをフィット
            setTimeout(() => this.fitView(), 100);

            // ログ出力
            this.log(`Graph initialized: ${visibleNodes.length} nodes, ${visibleLinks.length} links`);

            // 進捗完了
            this.updateProgress(100, 'Complete');
        } catch (error) {
            this.log(`Error initializing graph: ${error}`);
            console.error('Cosmos initialization error:', error);
        }
    }

    /**
     * 表示ノードを取得（Directory + File + Symbol 固定）
     */
    private getVisibleNodes(): CosmosNodeData[] {
        if (!this.data) {return [];}

        // 全レベル表示（Directory + File + Symbol）
        return this.data.nodes.filter(node =>
            node.level === 'directory' || node.level === 'file' || node.level === 'symbol'
        );
    }

    /**
     * 表示ノードに基づいてリンクを取得
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

        return this.data.links.filter(link =>
            visibleIndices.has(link.source) && visibleIndices.has(link.target)
        );
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
            // Phase 3: リンクハイライトを解除
            this.clearLinkHighlights();
            return;
        }

        this.hoveredNodeIndex = index;
        const node = this.currentVisibleNodes[index];
        if (!node) {return;}

        // 元のデータでのインデックスを取得
        const originalIndex = this.data.nodes.indexOf(node);

        // Phase 3: 関連リンクをハイライト（即座に実行）
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
                content += `<div class="tooltip-info">${node.childCount} symbols</div>`;
            } else if (node.line !== undefined) {
                content += `<div class="tooltip-info">Line ${node.line + 1}</div>`;
            }

            // Phase 3: 関係線の情報を追加（改善版）
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
     * Phase 3: 指定ノードに接続されたリンクをハイライト
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
     * Phase 3: リンクハイライトをクリア
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
     * Phase 4: 特定ファイルにズーム
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
     * Phase 4: 関連コードを表示（選択範囲のシンボルとその依存関係）
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

    // ========================================
    // Phase 5: HTMLエクスポート機能
    // ========================================

    /**
     * HTMLエクスポートを実行
     */
    public exportHTML(): void {
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
                visible: node.visible
            })),
            links: this.data.links.map(link => ({
                source: link.source,
                target: link.target,
                width: link.width,
                color: link.color,
                details: link.details
            })),
            directories: this.data.directories
        };

        // 拡張機能にエクスポートリクエストを送信
        this.postMessage({
            type: 'exportCosmosHTML',
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
function initCosmosView(): void {
    graphView = new GraphView('graph-container');

    // Phase 5: スタンドアロンモードの場合、グローバルデータを読み込み
    if (typeof IS_STANDALONE !== 'undefined' && IS_STANDALONE) {
        if (typeof COSMOS_GRAPH_DATA !== 'undefined' && COSMOS_GRAPH_DATA) {
            console.log('[GraphView] Loading standalone data...');
            // 少し遅延させてグラフの初期化を待つ
            setTimeout(() => {
                if (graphView) {
                    graphView.loadStandaloneData(COSMOS_GRAPH_DATA);
                }
            }, 100);
        } else {
            console.error('[GraphView] Standalone mode but no COSMOS_GRAPH_DATA found');
        }
    }
}

/**
 * Phase 5: HTMLエクスポート（グローバル関数）
 * HTMLテンプレートのボタンから呼び出される
 */
function exportHTML(): void {
    if (graphView) {
        graphView.exportHTML();
    } else {
        console.error('Graph view not initialized');
    }
}

// グローバルスコープに公開
(window as any).exportHTML = exportHTML;

// DOMロード後に初期化
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initCosmosView);
} else {
    initCosmosView();
}
