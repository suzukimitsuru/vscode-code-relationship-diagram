/**
 * Cosmos.gl Graph View
 *
 * Cosmos.glを使用した大規模グラフ可視化コンポーネント
 * WebView内で動作する
 */

// @ts-ignore - Cosmos.glはグローバルにロードされる
declare const CosmosGraph: {
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
class CosmosGraphView {
    private graph: any;
    private container: HTMLDivElement;
    private vscode: ReturnType<typeof acquireVsCodeApi> | null = null;
    private data: GraphData | null = null;
    private visibleDirectories: Set<string> = new Set();
    private selectedNodeId: string | null = null;
    private hoveredNodeIndex: number | null = null;
    private tooltip: HTMLElement | null = null;
    private nodeLevel: 'dir-only' | 'dir-file' | 'file-only' | 'file-symbol' = 'file-only';
    private nodeIndexMap: Map<string, number> = new Map();

    // Phase 3: リンク関連の状態
    private highlightedLinks: Set<number> = new Set();
    private originalLinkColors: Float32Array | null = null;
    private currentVisibleNodes: CosmosNodeData[] = [];
    private currentVisibleLinks: CosmosLinkData[] = [];

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

        this.log('CosmosGraphView initialized');
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

        // Node level selector
        const nodeLevel = document.getElementById('node-level') as HTMLSelectElement;
        if (nodeLevel) {
            nodeLevel.addEventListener('change', (e) => {
                this.setNodeLevel((e.target as HTMLSelectElement).value as any);
            });
        }

        // Zoom controls
        const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
        const zoomLevel = document.getElementById('zoom-level');
        const zoomInBtn = document.getElementById('zoom-in-btn');
        const zoomOutBtn = document.getElementById('zoom-out-btn');

        if (zoomSlider && this.graph) {
            zoomSlider.addEventListener('input', (e) => {
                const value = parseFloat((e.target as HTMLInputElement).value);
                this.graph.setZoomLevel(value, 100);
                if (zoomLevel) {
                    zoomLevel.textContent = `${Math.round(value * 100)}%`;
                }
            });
        }

        if (zoomInBtn) {
            zoomInBtn.addEventListener('click', () => {
                if (this.graph) {
                    const current = this.graph.getZoomLevel();
                    this.graph.setZoomLevel(Math.min(current * 1.2, 5), 200);
                }
            });
        }

        if (zoomOutBtn) {
            zoomOutBtn.addEventListener('click', () => {
                if (this.graph) {
                    const current = this.graph.getZoomLevel();
                    this.graph.setZoomLevel(Math.max(current / 1.2, 0.1), 200);
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

            case 'setDirectoryVisibility':
                this.setDirectoryVisibility(message.directories);
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

        // 全ディレクトリを可視化
        this.visibleDirectories = new Set(data.directories);

        // ディレクトリパネルを更新
        this.updateDirectoryPanel();

        // Cosmos.glグラフを初期化
        this.initializeGraph();

        // 統計表示を更新
        this.updateStats();
    }

    /**
     * ディレクトリパネルを更新
     */
    private updateDirectoryPanel(): void {
        const panel = document.getElementById('directory-panel');
        const list = document.getElementById('directory-list');

        if (!panel || !list || !this.data) {return;}

        // ディレクトリが存在する場合のみ表示
        if (this.data.directories.length > 0) {
            panel.style.display = 'block';
            list.innerHTML = '';

            for (const dir of this.data.directories) {
                const item = document.createElement('div');
                item.className = 'directory-item';

                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = this.visibleDirectories.has(dir);
                checkbox.id = `dir-${dir.replace(/[^a-zA-Z0-9]/g, '-')}`;
                checkbox.addEventListener('change', (e) => {
                    if ((e.target as HTMLInputElement).checked) {
                        this.visibleDirectories.add(dir);
                    } else {
                        this.visibleDirectories.delete(dir);
                    }
                    this.updateNodeVisibility();
                });

                const label = document.createElement('label');
                label.htmlFor = checkbox.id;
                label.textContent = dir;

                item.appendChild(checkbox);
                item.appendChild(label);
                list.appendChild(item);
            }
        } else {
            panel.style.display = 'none';
        }
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
            // @ts-ignore
            const Graph = window.CosmosGraph?.Graph || CosmosGraph?.Graph;
            if (!Graph) {
                this.log('Cosmos Graph class not found');
                return;
            }

            this.graph = new Graph(this.container, {
                backgroundColor: '#1e1e1e',
                spaceSize: 4096,
                simulation: {
                    repulsion: 0.5,
                    gravity: 0.1,
                    friction: 0.85,
                    decay: 1000,
                },
                events: {
                    onClick: (index: number | undefined) => this.handleNodeClick(index),
                    onHover: (index: number | undefined) => this.handleNodeHover(index),
                },
                renderLinks: true,
                linkWidth: 1,
                linkColor: [0.4, 0.4, 0.4, 0.5],
            });

            // データを設定
            this.graph.setPointPositions(positions);
            this.graph.setPointSizes(sizes);
            this.graph.setPointColors(colors);

            if (visibleLinks.length > 0) {
                this.graph.setLinks(linkArray);
                this.graph.setLinkWidths(linkWidths);

                // Phase 3: 元のリンク色を保存（後でハイライト解除時に復元用）
                this.originalLinkColors = new Float32Array(visibleLinks.length * 4);
                for (let i = 0; i < visibleLinks.length; i++) {
                    // デフォルトのリンク色（グレー）
                    this.originalLinkColors[i * 4] = 0.4;
                    this.originalLinkColors[i * 4 + 1] = 0.4;
                    this.originalLinkColors[i * 4 + 2] = 0.4;
                    this.originalLinkColors[i * 4 + 3] = 0.5;
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
     * 現在のノードレベルに基づいて表示ノードを取得
     */
    private getVisibleNodes(): CosmosNodeData[] {
        if (!this.data) {return [];}

        return this.data.nodes.filter(node => {
            // ディレクトリ可視性チェック
            if (!this.isNodeVisibleByDirectory(node)) {
                return false;
            }

            // ノードレベルによるフィルタリング
            switch (this.nodeLevel) {
                case 'dir-only':
                    return node.level === 'directory';
                case 'dir-file':
                    return node.level === 'directory' || node.level === 'file';
                case 'file-only':
                    return node.level === 'file';
                case 'file-symbol':
                    return node.level === 'file' || node.level === 'symbol';
                default:
                    return true;
            }
        });
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
     * ノードがディレクトリ設定により表示可能か
     */
    private isNodeVisibleByDirectory(node: CosmosNodeData): boolean {
        if (node.level === 'directory') {
            return this.visibleDirectories.has(node.path);
        } else if (node.level === 'file') {
            const dirPath = node.path.substring(0, node.path.lastIndexOf('/'));
            return this.visibleDirectories.has(dirPath);
        } else {
            // シンボルは親ファイルの可視性に従う
            const parentFile = this.data?.nodes.find(n => n.id === node.parentId);
            if (parentFile) {
                return this.isNodeVisibleByDirectory(parentFile);
            }
            return true;
        }
    }

    /**
     * ノードレベルを設定
     */
    private setNodeLevel(level: 'dir-only' | 'dir-file' | 'file-only' | 'file-symbol'): void {
        this.nodeLevel = level;
        this.initializeGraph();
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

        // ディレクトリの場合、展開/折りたたみ
        if (node.level === 'directory') {
            this.toggleDirectory(node.path);
        }
    }

    /**
     * ノードホバー処理
     */
    private handleNodeHover(index: number | undefined): void {
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

        // Phase 3: 関連リンクをハイライト
        this.highlightLinksForNode(originalIndex);

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
        const relatedLinks = this.data.links.filter(
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
                // 元の色（薄いグレー）
                linkColors[i * 4] = 0.3;
                linkColors[i * 4 + 1] = 0.3;
                linkColors[i * 4 + 2] = 0.3;
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
        if (this.tooltip) {
            this.tooltip.style.display = 'none';
        }
        document.removeEventListener('mousemove', this.updateTooltipPosition);
    }

    /**
     * ディレクトリの表示切り替え
     */
    private toggleDirectory(dirPath: string): void {
        if (this.visibleDirectories.has(dirPath)) {
            this.visibleDirectories.delete(dirPath);
        } else {
            this.visibleDirectories.add(dirPath);
        }
        this.updateNodeVisibility();
    }

    /**
     * ディレクトリ表示状態を設定
     */
    private setDirectoryVisibility(directories: string[]): void {
        this.visibleDirectories = new Set(directories);
        this.updateNodeVisibility();
    }

    /**
     * ノードの表示状態を更新
     */
    private updateNodeVisibility(): void {
        // グラフを再初期化
        this.initializeGraph();
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
        console.log(`[CosmosView] ${message}`);
        this.postMessage({
            type: 'webviewLog',
            level: 'info',
            message: `[CosmosView] ${message}`,
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
let graphView: CosmosGraphView | null = null;

/**
 * 初期化
 */
function initCosmosView(): void {
    graphView = new CosmosGraphView('graph-container');

    // Phase 5: スタンドアロンモードの場合、グローバルデータを読み込み
    if (typeof IS_STANDALONE !== 'undefined' && IS_STANDALONE) {
        if (typeof COSMOS_GRAPH_DATA !== 'undefined' && COSMOS_GRAPH_DATA) {
            console.log('[CosmosView] Loading standalone data...');
            // 少し遅延させてグラフの初期化を待つ
            setTimeout(() => {
                if (graphView) {
                    graphView.loadStandaloneData(COSMOS_GRAPH_DATA);
                }
            }, 100);
        } else {
            console.error('[CosmosView] Standalone mode but no COSMOS_GRAPH_DATA found');
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
