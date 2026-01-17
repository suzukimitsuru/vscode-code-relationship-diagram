/**
 * @file Code Relationship Diagram - Multi View Graph Script
 * @description Webview script for displaying multi-view code relationship diagrams
 */

// 新しい制限値（拡張機能側でDagreレイアウト計算を実行するため、制限を緩和）
const HierarchyView_LIMIT_ONLY_FILE = 15000; // 階層構造ビューでファイルレベルのみ表示する閾値（5000 → 15000）

// Type declarations for global variables injected by HTML template
declare const cytoscape: any;

// Global window interface extension
declare global {
    interface Window {
        GRAPH_ELEMENTS: any[];
        GRAPH_NODES_COUNT: number;
        GRAPH_EDGES_COUNT: number;
        IS_STANDALONE: boolean;
        GRAPH_DATA?: {
            nodes: any[],
            edges: any[],
            layoutPositions?: {
                [viewType: string]: Array<{id: string, x: number, y: number}>
            }
        };
        GRAPH_DATA_JS_URI?: string;
        WORKSPACE_NAME?: string;
    }
}

// VSCode API
interface VsCodeAPI {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

declare function acquireVsCodeApi(): VsCodeAPI;

// ========================================
// Library Registration
// ========================================

// Debug: Check what libraries are loaded
console.log('=== Library Loading Status ===');
console.log('cytoscape:', typeof cytoscape);

// Note: Dagre layout calculation is now performed on extension side (Node.js)
// Webview uses 'preset' layout with pre-calculated positions

// ========================================
// Utility Functions
// ========================================

// WCAG基準の相対輝度を計算する関数
function getRelativeLuminance(color: string): number {
    // カラー文字列からRGBを抽出
    let r: number, g: number, b: number;
    if (color.startsWith('#')) {
        // #RRGGBB形式
        r = parseInt(color.substring(1, 3), 16);
        g = parseInt(color.substring(3, 5), 16);
        b = parseInt(color.substring(5, 7), 16);
    } else if (color.startsWith('rgb')) {
        // rgb(r, g, b)形式
        const match = color.match(/\d+/g);
        if (!match) {return 0.5;}
        r = parseInt(match[0]);
        g = parseInt(match[1]);
        b = parseInt(match[2]);
    } else {
        return 0.5; // デフォルト
    }

    // RGB値を0-1の範囲に正規化
    r = r / 255;
    g = g / 255;
    b = b / 255;

    // ガンマ補正を適用
    const applyGamma = (value: number): number => {
        if (value <= 0.03928) {
            return value / 12.92;
        } else {
            return Math.pow((value + 0.055) / 1.055, 2.4);
        }
    };

    r = applyGamma(r);
    g = applyGamma(g);
    b = applyGamma(b);

    // WCAG相対輝度の計算式
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance;
}

// 背景色の輝度に基づいて最適なテキスト色を返す関数
function getContrastColor(backgroundColor: string): string {
    const luminance = getRelativeLuminance(backgroundColor);
    return luminance < 0.5 ? '#ffffff' : '#000000';
}

// VSCodeのシンボルアイコンの色を取得する関数
function getSymbolKindColor(kind: number): string {
    // VSCode標準のシンボルアイコンカラー
    switch(kind) {
        case -1: return '#8faadc'; // Directory
        case 0:  return '#519aba'; // File
        case 1:  return '#4d9fd1'; // Module
        case 2:  return '#4d9fd1'; // Namespace
        case 3:  return '#4d9fd1'; // Package
        case 4:  return '#ee9d28'; // Class
        case 5:  return '#b180d7'; // Method
        case 6:  return '#75beff'; // Property
        case 7:  return '#75beff'; // Field
        case 8:  return '#b180d7'; // Constructor
        case 9:  return '#ee9d28'; // Enum
        case 10: return '#75beff'; // Interface
        case 11: return '#b180d7'; // Function
        case 12: return '#75beff'; // Variable
        case 13: return '#4fc1ff'; // Constant
        case 14: return '#ce9178'; // String
        case 15: return '#b5cea8'; // Number
        case 16: return '#569cd6'; // Boolean
        case 17: return '#4d9fd1'; // Array
        case 18: return '#4d9fd1'; // Object
        case 19: return '#4fc1ff'; // Key
        case 20: return '#569cd6'; // Null
        case 21: return '#75beff'; // EnumMember
        case 22: return '#4d9fd1'; // Struct
        case 23: return '#ee9d28'; // Event
        case 24: return '#b5cea8'; // Operator
        case 25: return '#4fc1ff'; // TypeParameter
        default: return '#cccccc'; // Unknown
    }
}

// テキスト幅を測定する関数
function measureTextWidth(text: string, fontSize: number, fontWeight: string = 'normal'): number {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) {return 100;}
    context.font = `${fontWeight} ${fontSize}px Arial, sans-serif`;
    const metrics = context.measureText(text);
    return metrics.width;
}

// ========================================
// Directory Node Generation (Phase 2)
// ========================================

/**
 * ディレクトリツリーを構築
 * @param filePaths ファイルパスの配列
 * @returns Map<ディレクトリパス, 親ディレクトリパス>
 */
function buildDirectoryTree(filePaths: string[]): Map<string, string | null> {
    const directoryMap = new Map<string, string | null>();

    filePaths.forEach(filePath => {
        const parts = filePath.split('/');
        parts.pop(); // ファイル名を除く

        let currentPath = '';
        for (let i = 0; i < parts.length; i++) {
            const parentPath = currentPath;
            currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];

            if (!directoryMap.has(currentPath)) {
                directoryMap.set(currentPath, parentPath || null);
            }
        }
    });

    return directoryMap;
}

/**
 * ディレクトリノードを生成
 * @param filePaths ファイルパスの配列
 * @returns ディレクトリノードの配列
 */
function createDirectoryNodes(filePaths: string[]): any[] {
    const directoryTree = buildDirectoryTree(filePaths);
    const directoryNodes: any[] = [];

    directoryTree.forEach((parent, dirPath) => {
        const parts = dirPath.split('/');
        const label = parts[parts.length - 1];

        const dirNode: any = {
            data: {
                id: `dir:${dirPath}`,
                label: label,
                kind: -1, // ディレクトリ
                path: dirPath,
                isDirectory: true
            }
        };

        if (parent) {
            dirNode.data.parent = `dir:${parent}`;
        }

        directoryNodes.push(dirNode);
    });

    return directoryNodes;
}

/**
 * ファイルパスからディレクトリパスを取得
 * @param filePath ファイルパス
 * @returns ディレクトリパス（なければnull）
 */
function getDirectoryPath(filePath: string): string | null {
    const parts = filePath.split('/');
    parts.pop();
    return parts.length > 0 ? parts.join('/') : null;
}

/**
 * ファイル間エッジをディレクトリ間エッジに集約
 * @param fileEdges ファイル間エッジの配列
 * @param fileNodes ファイルノードの配列
 * @returns ディレクトリ間エッジの配列
 */
function aggregateEdgesToDirectories(fileEdges: any[], fileNodes: any[]): any[] {
    // ファイルIDからディレクトリパスへのマップを作成
    const fileToDir = new Map<string, string>();
    fileNodes.forEach(node => {
        if (node.data.kind === 0) {
            const dirPath = getDirectoryPath(node.data.path);
            if (dirPath) {
                fileToDir.set(node.data.id, dirPath);
            }
        }
    });

    // ディレクトリ間のエッジを集約
    const dirEdgeMap = new Map<string, { count: number, details: any[] }>();

    fileEdges.forEach(edge => {
        const sourceDir = fileToDir.get(edge.data.source);
        const targetDir = fileToDir.get(edge.data.target);

        if (sourceDir && targetDir && sourceDir !== targetDir) {
            const edgeKey = `${sourceDir}|||${targetDir}`;

            if (!dirEdgeMap.has(edgeKey)) {
                dirEdgeMap.set(edgeKey, { count: 0, details: [] });
            }

            const aggData = dirEdgeMap.get(edgeKey)!;
            aggData.count += edge.data.relationshipCount || 1;

            if (edge.data.relationshipDetails) {
                aggData.details.push(...edge.data.relationshipDetails);
            }
        }
    });

    // 集約されたエッジを配列に変換
    const dirEdges: any[] = [];
    dirEdgeMap.forEach((aggData, edgeKey) => {
        const [sourceDir, targetDir] = edgeKey.split('|||');
        dirEdges.push({
            data: {
                id: `dir-edge:${edgeKey}`,
                source: `dir:${sourceDir}`,
                target: `dir:${targetDir}`,
                relationshipCount: aggData.count,
                relationshipDetails: aggData.details,
                relationshipType: 'directory-relationship'
            }
        });
    });

    return dirEdges;
}

// ========================================
// Global State
// ========================================

// Cytoscapeインスタンス（シングルビュー）
let cyInstance: any = null;

// ノード表示レベルの状態
// 'dir-only': ディレクトリノードのみ表示
// 'dir-file': ディレクトリ + ファイルノード表示
// 'file-only': ファイルノードのみ表示
// 'file-symbol': ファイルノード + シンボルノード表示
type NodeLevel = 'dir-only' | 'dir-file' | 'file-only' | 'file-symbol';
let nodeLevel: NodeLevel = 'file-symbol'; // デフォルトはファイル+シンボル

// Progress elements
const progressBar = document.getElementById('progress-bar') as HTMLElement;
const progressText = document.getElementById('progress-text') as HTMLElement;
const progressContainer = document.getElementById('progress-container') as HTMLElement;

// Tooltip
const tooltip = document.createElement('div');
tooltip.style.cssText = `
    position: absolute;
    background: rgba(0, 0, 0, 0.95);
    color: white;
    padding: 8px 12px;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
    z-index: 9999;
    pointer-events: auto;
    opacity: 0;
    transition: opacity 0.2s ease;
    max-width: 350px;
    white-space: pre-wrap;
    word-wrap: break-word;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
`;
document.body.appendChild(tooltip);

let tooltipPosition: {x: number, y: number} | null = null;

// VSCode API
const vscode: VsCodeAPI | null = window.IS_STANDALONE ? null : acquireVsCodeApi();

// ========================================
// Progress Functions
// ========================================

function updateProgress(percent: number, message: string): void {
    progressBar.style.width = percent + '%';
    progressText.textContent = message;

    if (percent >= 100) {
        setTimeout(() => {
            progressContainer.style.opacity = '0';
            progressText.style.opacity = '0';
            setTimeout(() => {
                progressContainer.style.display = 'none';
                progressText.style.display = 'none';
            }, 300);
        }, 500);
    }
}

function showProgress(): void {
    progressContainer.style.display = 'block';
    progressContainer.style.opacity = '1';
    progressText.style.display = 'block';
    progressText.style.opacity = '1';
}

function hideProgress(): void {
    progressContainer.style.opacity = '0';
    progressText.style.opacity = '0';
    setTimeout(() => {
        progressContainer.style.display = 'none';
        progressText.style.display = 'none';
    }, 300);
}

function showErrorMessage(message: string): void {
    // エラーメッセージを表示する簡易的な実装
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: rgba(220, 53, 69, 0.95);
        color: white;
        padding: 20px 30px;
        border-radius: 8px;
        font-size: 14px;
        font-family: Arial, sans-serif;
        z-index: 10000;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
        max-width: 500px;
        word-wrap: break-word;
    `;
    errorDiv.textContent = message;
    document.body.appendChild(errorDiv);

    // 5秒後に自動的に削除
    setTimeout(() => {
        errorDiv.style.opacity = '0';
        errorDiv.style.transition = 'opacity 0.3s ease';
        setTimeout(() => {
            if (errorDiv.parentNode) {
                document.body.removeChild(errorDiv);
            }
        }, 300);
    }, 5000);

    // クリックで即座に削除
    errorDiv.addEventListener('click', () => {
        if (errorDiv.parentNode) {
            document.body.removeChild(errorDiv);
        }
    });
}

// Webview初期化完了を通知
if (!window.IS_STANDALONE && vscode) {
    console.log('Sending webviewReady message to extension...');
    vscode.postMessage({ type: 'webviewReady' });
}

// VSCode Extension からのメッセージ受信
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'progress') {
        updateProgress(message.percent, message.message);
    } else if (message.type === 'exportHTMLProgress') {
        // HTMLエクスポートの進捗更新
        updateProgress(message.percent, message.message);
    } else if (message.type === 'exportHTMLComplete') {
        // HTMLエクスポート完了
        updateProgress(100, 'Export complete!');
    } else if (message.type === 'layoutPositions') {
        // 拡張機能側で計算されたレイアウト座標を受信
        const { viewType, positions } = message;
        console.log(`=== RECEIVED LAYOUT POSITIONS ===`);
        console.log(`View type: ${viewType}`);
        console.log(`Positions count: ${positions.length}`);

        // Map<nodeId, {x, y}>に変換して格納
        const positionMap = new Map<string, {x: number, y: number}>();
        positions.forEach((pos: {id: string, x: number, y: number}) => {
            positionMap.set(pos.id, { x: pos.x, y: pos.y });
        });

        layoutPositions.set(viewType, positionMap);
        console.log(`Stored ${positionMap.size} positions for view ${viewType}`);

        // サンプル座標を表示
        let sampleCount = 0;
        positionMap.forEach((pos, id) => {
            if (sampleCount < 3) {
                console.log(`  Sample position: ${id} -> (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`);
                sampleCount++;
            }
        });
        console.log(`=== LAYOUT POSITIONS STORED ===`);
    } else if (message.type === 'graphData') {
        // チャンクデータを受信
        const { dataType, chunk, chunkIndex, totalChunks } = message;

        if (dataType === 'nodes') {
            allNodes.push(...chunk);
            const percent = 20 + (chunkIndex / totalChunks) * 20;
            updateProgress(percent, `Loading nodes... ${chunkIndex + 1}/${totalChunks}`);
            console.log(`Received nodes chunk ${chunkIndex + 1}/${totalChunks}: ${chunk.length} nodes (total: ${allNodes.length})`);
        } else if (dataType === 'edges') {
            allEdges.push(...chunk);
            const percent = 40 + (chunkIndex / totalChunks) * 30;
            updateProgress(percent, `Loading edges... ${chunkIndex + 1}/${totalChunks}`);
            console.log(`Received edges chunk ${chunkIndex + 1}/${totalChunks}: ${chunk.length} edges (total: ${allEdges.length})`);
        }
    } else if (message.type === 'graphDataComplete') {
        // データ受信完了
        console.log('=== Graph Data Loading Complete ===');
        console.log('Total nodes received:', allNodes.length);
        console.log('Total edges received:', allEdges.length);
        console.log('Expected nodes:', message.totalNodes);
        console.log('Expected edges:', message.totalEdges);

        isDataLoaded = true;

        // データが揃ったのでビューを初期化
        if (allNodes.length > 0) {
            console.log('Sample node:', allNodes[0]);
            const fileNodes = allNodes.filter(n => n.data.kind === 0);
            const symbolNodes = allNodes.filter(n => n.data.kind !== 0);
            console.log('File nodes:', fileNodes.length);
            console.log('Symbol nodes:', symbolNodes.length);
        }
        if (allEdges.length > 0) {
            console.log('Sample edge:', allEdges[0]);
        }

        // データセットサイズに応じて初期ノードレベルを調整
        const totalNodes = allNodes.length;
        const isLargeDataset = totalNodes > HierarchyView_LIMIT_ONLY_FILE;
        if (isLargeDataset) {
            console.log('Large dataset detected. Setting to file-only mode.');
            nodeLevel = 'file-only';
        }

        // 初期ビューを初期化
        (async () => {
            try {
                showProgress();
                updateProgress(70, 'Initializing visualization...');
                await initializeView();
                updateProgress(100, 'Complete!');
            } catch (error) {
                hideProgress();
                showErrorMessage(`Failed to initialize view: ${error instanceof Error ? error.message : 'Unknown error'}`);
                console.error('View initialization error:', error);
            }
        })();
    }
});

// ========================================
// External Data Loading (for standalone HTML)
// ========================================

async function loadExternalDataJs(dataJsUri: string): Promise<void> {
    try {
        showProgress();
        updateProgress(10, 'Loading graph data...');
        console.log('Loading external data from:', dataJsUri);

        // UIが表示されるまで少し待つ
        await new Promise(resolve => setTimeout(resolve, 100));

        updateProgress(30, 'Downloading data file...');

        // 動的にscriptタグを作成して読み込む
        await new Promise<void>((resolve, reject) => {
            const script = document.createElement('script');
            script.src = dataJsUri;
            script.async = true;

            script.onload = () => {
                console.log('Data JS file loaded successfully');
                resolve();
            };

            script.onerror = (error) => {
                console.error('Failed to load data JS file:', error);
                reject(new Error('Failed to load data file'));
            };

            document.head.appendChild(script);
        });

        updateProgress(60, 'Processing graph data...');
        await new Promise(resolve => setTimeout(resolve, 50));

        // window.GRAPH_DATAが設定されているか確認
        if (window.GRAPH_DATA && window.GRAPH_DATA.nodes && window.GRAPH_DATA.edges) {
            allNodes = window.GRAPH_DATA.nodes;
            allEdges = window.GRAPH_DATA.edges;
            isDataLoaded = true;

            console.log('External data loaded successfully:', {
                nodes: allNodes.length,
                edges: allEdges.length
            });

            // layoutPositionsを読み込む（存在する場合）
            if (window.GRAPH_DATA?.layoutPositions) {
                const layoutPositionsData = window.GRAPH_DATA.layoutPositions;
                console.log('Loading pre-calculated layout positions from exported data...');
                Object.keys(layoutPositionsData).forEach(viewType => {
                    const positions = layoutPositionsData[viewType];
                    const positionMap = new Map<string, {x: number, y: number}>();
                    positions.forEach((pos: {id: string, x: number, y: number}) => {
                        positionMap.set(pos.id, { x: pos.x, y: pos.y });
                    });
                    layoutPositions.set(viewType, positionMap);
                    console.log(`Loaded ${positionMap.size} positions for view '${viewType}'`);
                });
                console.log(`Total layout positions loaded for ${Object.keys(layoutPositionsData).length} view types`);
            } else {
                console.log('No pre-calculated layout positions found in exported data - will calculate on-demand');
            }

            if (allNodes.length > 0) {
                console.log('Sample node:', allNodes[0]);
                const fileNodes = allNodes.filter(n => n.data.kind === 0);
                const symbolNodes = allNodes.filter(n => n.data.kind !== 0);
                console.log('File nodes:', fileNodes.length);
                console.log('Symbol nodes:', symbolNodes.length);
            }
            if (allEdges.length > 0) {
                console.log('Sample edge:', allEdges[0]);
            }

            // データセットサイズに応じて初期ノードレベルを調整
            const totalNodes = allNodes.length;
            const isLargeDataset = totalNodes > HierarchyView_LIMIT_ONLY_FILE;
            if (isLargeDataset) {
                console.log('Large dataset detected. Setting to file-only mode.');
                nodeLevel = 'file-only';
            }

            updateProgress(80, 'Initializing views...');

            await initializeView();

            updateProgress(100, 'Complete!');
            console.log('=== External data loading and initialization complete ===');
        } else {
            throw new Error('Data file did not set window.GRAPH_DATA');
        }
    } catch (error) {
        hideProgress();
        const errorMessage = `Failed to load graph data: ${error instanceof Error ? error.message : 'Unknown error'}`;
        showErrorMessage(errorMessage);
        console.error('External data loading error:', error);
    }
}

// ========================================
// Data Preparation
// ========================================

updateProgress(10, 'Initializing graph...');
console.log('Initializing Multi-View with', window.GRAPH_NODES_COUNT, 'nodes and', window.GRAPH_EDGES_COUNT, 'edges');

// データをチャンクで受信するための変数
let allNodes: any[] = [];
let allEdges: any[] = [];
let isDataLoaded = false;

// 拡張機能側で計算されたレイアウト座標を格納
const layoutPositions: Map<string, Map<string, {x: number, y: number}>> = new Map();
// Map<viewType, Map<nodeId, {x, y}>>

// 初期データをチェック（スタンドアロンHTML用）
if (window.IS_STANDALONE && window.GRAPH_DATA_JS_URI && window.GRAPH_DATA_JS_URI !== '') {
    // スタンドアロンHTMLで外部data.jsファイルを動的に読み込む
    console.log('=== Standalone HTML: Loading external data file ===');
    console.log('Data JS URI:', window.GRAPH_DATA_JS_URI);
    (async () => {
        try {
            await loadExternalDataJs(window.GRAPH_DATA_JS_URI!);
        } catch (error) {
            console.error('=== External data loading failed ===', error);
        }
    })();
} else if (window.GRAPH_DATA && window.GRAPH_DATA.nodes && window.GRAPH_DATA.edges) {
    // data.jsが既に読み込まれている場合（旧形式の互換性）
    console.log('=== Standalone HTML: Using pre-loaded GRAPH_DATA ===');
    allNodes = window.GRAPH_DATA.nodes;
    allEdges = window.GRAPH_DATA.edges;
    isDataLoaded = true;

    // layoutPositionsを読み込む（存在する場合）
    if (window.GRAPH_DATA?.layoutPositions) {
        const layoutPositionsData = window.GRAPH_DATA.layoutPositions;
        console.log('Loading pre-calculated layout positions from exported data...');
        Object.keys(layoutPositionsData).forEach(viewType => {
            const positions = layoutPositionsData[viewType];
            const positionMap = new Map<string, {x: number, y: number}>();
            positions.forEach((pos: {id: string, x: number, y: number}) => {
                positionMap.set(pos.id, { x: pos.x, y: pos.y });
            });
            layoutPositions.set(viewType, positionMap);
            console.log(`Loaded ${positionMap.size} positions for view '${viewType}'`);
        });
        console.log(`Total layout positions loaded for ${Object.keys(layoutPositionsData).length} view types`);
    } else {
        console.log('No pre-calculated layout positions found in exported data - will calculate on-demand');
    }

    console.log('Total nodes:', allNodes.length);
    console.log('Total edges:', allEdges.length);
    console.log('IS_STANDALONE:', window.IS_STANDALONE);

    if (allNodes.length > 0) {
        console.log('Sample node:', allNodes[0]);
        const fileNodes = allNodes.filter(n => n.data.kind === 0);
        const symbolNodes = allNodes.filter(n => n.data.kind !== 0);
        console.log('File nodes:', fileNodes.length);
        console.log('Symbol nodes:', symbolNodes.length);
    }
    if (allEdges.length > 0) {
        console.log('Sample edge:', allEdges[0]);
    }
} else if (window.GRAPH_ELEMENTS && window.GRAPH_ELEMENTS.length > 0) {
    console.log('=== Standalone HTML: Using embedded graph data ===');
    const allElements = window.GRAPH_ELEMENTS;
    allNodes = allElements.filter(el => !el.data.source);
    allEdges = allElements.filter(el => el.data.source);
    isDataLoaded = true;

    console.log('Total elements:', allElements.length);
    console.log('Total nodes:', allNodes.length);
    console.log('Total edges:', allEdges.length);
    console.log('IS_STANDALONE:', window.IS_STANDALONE);

    if (allNodes.length > 0) {
        console.log('Sample node:', allNodes[0]);
        const fileNodes = allNodes.filter(n => n.data.kind === 0);
        const symbolNodes = allNodes.filter(n => n.data.kind !== 0);
        console.log('File nodes:', fileNodes.length);
        console.log('Symbol nodes:', symbolNodes.length);
    }
    if (allEdges.length > 0) {
        console.log('Sample edge:', allEdges[0]);
    }
} else {
    console.log('=== VSCode Webview: Waiting for data via postMessage ===');
    console.log('window.GRAPH_ELEMENTS:', window.GRAPH_ELEMENTS ? window.GRAPH_ELEMENTS.length : 'undefined');
    updateProgress(20, 'Waiting for data...');
}

// ========================================
// View Initialization (Single View)
// ========================================

async function initializeView(): Promise<void> {
    console.log('Initializing view...');
    updateProgress(30, 'Initializing view...');

    try {
        await initView();
        console.log('View initialized successfully');
        updateProgress(100, 'View ready');
    } catch (error) {
        console.error('Error initializing view:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
        throw error;
    }
}

// ========================================
// Graph View
// ========================================

async function initView(): Promise<void> {
    try {
        console.log('=== initView START ===');
        const graphElements = createElements();

        console.log('initView - Graph elements:', graphElements.length);

        if (graphElements.length === 0) {
            console.error('initView - ERROR: No elements found!');
            return;
        }

        // ノード数とエッジ数をカウント
        const nodeCount = graphElements.filter((el: any) => !el.data.source).length;
        const edgeCount = graphElements.filter((el: any) => el.data.source).length;

        console.log(`initView - Dataset: ${nodeCount} nodes, ${edgeCount} edges`);

        // 拡張機能側で計算されたレイアウト座標を取得
        let positions: Map<string, {x: number, y: number}> | null = null;
        const HierarchyView_DAGRE_LAYOUT_LIMIT_NODES = 10000;
        const HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES = 15000;

        // デバッグ: layoutPositionsの内容を確認
        console.log(`=== CHECKING LAYOUT POSITIONS ===`);
        console.log(`layoutPositions size: ${layoutPositions.size}`);
        console.log(`layoutPositions keys: ${Array.from(layoutPositions.keys()).join(', ')}`);
        console.log(`Has 'hierarchy'?: ${layoutPositions.has('hierarchy')}`);

        // 拡張機能側から座標を受信しているか確認
        if (layoutPositions.has('hierarchy')) {
            positions = layoutPositions.get('hierarchy')!;
            console.log(`✓ initView - Using pre-calculated positions from extension: ${positions.size} positions`);
            updateProgress(65, 'Applying layout positions...');
        } else if (allNodes.length > HierarchyView_DAGRE_LAYOUT_LIMIT_NODES || edgeCount > HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES) {
            // 大規模すぎる場合はWebview側でCOSEレイアウトを計算（フォールバック）
            console.log('initView - Large dataset. Using COSE layout as fallback...');
            updateProgress(65, 'Calculating COSE layout...');

            positions = await calculateLayoutPositions(graphElements, 'cose', {
                nodeRepulsion: 200000,
                idealEdgeLength: 300,
                edgeElasticity: 100,
                gravity: 30,
                numIter: 1000,
                randomize: false
            });
        } else {
            // 中規模データでも座標がない場合はCOSEレイアウトをフォールバックとして使用
            console.log('initView - No pre-calculated positions. Using COSE layout as fallback...');
            updateProgress(65, 'Calculating layout positions...');

            positions = await calculateLayoutPositions(graphElements, 'cose', {
                nodeRepulsion: 200000,
                idealEdgeLength: 300,
                edgeElasticity: 100,
                gravity: 30,
                numIter: 1000,
                randomize: false
            });
        }

        // ノードに座標を設定
        if (positions && positions.size > 0) {
            updateProgress(75, 'Applying layout positions...');
            console.log(`initView - Positions map size: ${positions.size}`);
            let appliedCount = 0;
            let skippedParentCount = 0;
            let notFoundCount = 0;
            graphElements.forEach((el: any) => {
                if (!el.data.source) { // ノードのみ
                    const pos = positions!.get(el.data.id);
                    if (pos && !isNaN(pos.x) && !isNaN(pos.y)) {
                        el.position = { x: pos.x, y: pos.y };
                        appliedCount++;
                    } else {
                        notFoundCount++;
                        if (notFoundCount <= 5) {
                            console.warn(`initView - Invalid position for node: ${el.data.id} -> (${pos?.x}, ${pos?.y})`);
                        }
                    }
                }
            });
            console.log(`initView - Applied positions: ${appliedCount}, Skipped parent nodes: ${skippedParentCount}, Invalid: ${notFoundCount}`);

            // 座標がないノードが多い場合（50%以上）、Webview側でレイアウトを再計算
            const totalNonParentNodes = nodeCount - skippedParentCount;
            const missingPositionRatio = totalNonParentNodes > 0 ? notFoundCount / totalNonParentNodes : 0;

            if (missingPositionRatio >= 0.5) {
                console.warn(`initView - Many nodes missing positions (${(missingPositionRatio * 100).toFixed(1)}%). Recalculating layout with COSE...`);
                updateProgress(75, 'Recalculating layout (many nodes missing positions)...');

                // Webview側でCOSEレイアウトを計算
                positions = await calculateLayoutPositions(graphElements, 'cose', {
                    nodeRepulsion: 200000,
                    idealEdgeLength: 300,
                    edgeElasticity: 100,
                    gravity: 30,
                    numIter: 1000,
                    randomize: false
                });

                // 再度座標を適用（今度は全ノードに適用）
                appliedCount = 0;
                graphElements.forEach((el: any) => {
                    if (!el.data.source) { // ノードのみ
                        const pos = positions!.get(el.data.id);
                        if (pos && !isNaN(pos.x) && !isNaN(pos.y)) {
                            el.position = { x: pos.x, y: pos.y };
                            appliedCount++;
                        }
                    }
                });

                console.log(`initView - Reapplied COSE positions to ${appliedCount} nodes`);
            } else if (appliedCount > 0) {
                // サンプルノードの座標を表示
                const sampleNode = graphElements.find((el: any) => !el.data.source && el.position && el.data.kind !== -1);
                if (sampleNode) {
                    console.log(`initView - Sample position: ${sampleNode.data.id} -> (${sampleNode.position.x}, ${sampleNode.position.y})`);
                }
            }
        } else {
            console.warn('initView - No positions to apply!');
        }

        updateProgress(80, 'Rendering view...');
        console.log(`initView - Creating Cytoscape instance with ${graphElements.length} elements`);
        cyInstance = cytoscape({
            container: document.getElementById('cy-graph'),
            elements: graphElements,
            style: [
                {
                    selector: 'node[kind=-1]', // ディレクトリノード
                    style: {
                        'background-color': function(ele: any) {
                            return getSymbolKindColor(ele.data('kind'));
                        },
                        'label': 'data(label)',
                        'text-valign': 'top',
                        'text-halign': 'center',
                        'color': function(ele: any) {
                            const bgColor = ele.style('background-color');
                            return getContrastColor(bgColor);
                        },
                        'font-size': '16px',
                        'font-weight': 'bold',
                        'shape': 'roundrectangle',
                        'padding': '25px',
                        'min-width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 16, 'bold');
                            return Math.max(180, textWidth + 70) + 'px';
                        },
                        'text-wrap': 'none',
                        'border-width': '4px',
                        'border-color': '#6B8BB8',
                        'background-opacity': 0.2
                    }
                },
                {
                    selector: 'node[kind=0]', // ファイルノード
                    style: {
                        'background-color': function(ele: any) {
                            return getSymbolKindColor(ele.data('kind'));
                        },
                        'label': 'data(label)',
                        'text-valign': 'top',
                        'text-halign': 'center',
                        'color': function(ele: any) {
                            const bgColor = ele.style('background-color');
                            return getContrastColor(bgColor);
                        },
                        'font-size': '28px',
                        'font-weight': 'bold',
                        'shape': 'rectangle',
                        'padding': '40px',
                        'min-width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 28, 'bold');
                            return Math.max(300, textWidth + 120) + 'px';
                        },
                        'min-height': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 28, 'bold');
                            return Math.max(300, textWidth + 120) + 'px';
                        },
                        'text-wrap': 'none',
                        'border-width': '6px',
                        'border-color': '#2E5984',
                        'background-opacity': 0.7
                    }
                },
                {
                    selector: 'node[kind>0]', // シンボルノード
                    style: {
                        'background-color': function(ele: any) {
                            return getSymbolKindColor(ele.data('kind'));
                        },
                        'label': 'data(label)',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'color': function(ele: any) {
                            const bgColor = ele.style('background-color');
                            return getContrastColor(bgColor);
                        },
                        'font-size': '11px',
                        'shape': 'roundrectangle',
                        'width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 11, 'normal');
                            return Math.max(80, textWidth + 30) + 'px';
                        },
                        'height': '40px',
                        'text-wrap': 'none',
                        'border-width': '1px',
                        'border-color': '#34495E',
                        'background-opacity': 1.0
                    }
                },
                {
                    selector: 'node.selected',
                    style: {
                        'border-color': '#FF6B35',
                        'border-width': '4px',
                        'z-index': '999'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': function(ele: any) {
                            const relationshipCount = ele.data('relationshipCount') || 1;
                            return Math.min(Math.max(relationshipCount * 0.8, 1), 10);
                        },
                        'line-color': '#3498DB',
                        'target-arrow-color': '#3498DB',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'opacity': 0.3
                    }
                }
            ],
            layout: {
                name: 'preset',
                fit: true,
                padding: 50,
                animate: true,
                animationDuration: 500
            }
        });

        console.log(`initView - Cytoscape created: ${cyInstance.nodes().length} nodes, ${cyInstance.edges().length} edges`);

        // ドロップダウンのオプションを更新
        updateNodeLevelDropdown();

        setupCommonEventHandlers();
        updateProgress(90, 'View ready');
        console.log('=== initView COMPLETE ===');
    } catch (error) {
        console.error('initView - ERROR:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
    }
}

function createElements(): any[] {
    const elements: any[] = [];
    const processedIds = new Set<string>();

    console.log('createElements - Starting with', allNodes.length, 'nodes');

    // ノード表示レベルを取得
    const currentNodeLevel = nodeLevel || 'file-symbol';
    console.log(`createElements - Node level: ${currentNodeLevel}`);

    // ファイルノードとシンボルノードを分離
    const fileNodes = allNodes.filter(n => n.data.kind === 0);
    const symbolNodes = allNodes.filter(n => n.data.kind > 0);
    const fileEdges = allEdges.filter(e => e.data.relationshipType === 'file-relationship');
    const symbolEdges = allEdges.filter(e => e.data.relationshipType !== 'file-relationship');

    console.log(`createElements - Files: ${fileNodes.length}, Symbols: ${symbolNodes.length}`);
    console.log(`createElements - File edges: ${fileEdges.length}, Symbol edges: ${symbolEdges.length}`);

    if (currentNodeLevel === 'dir-only') {
        // ディレクトリのみ表示
        console.log('createElements - Generating directory-only view');

        // ディレクトリノードを生成
        const filePaths = fileNodes.map(n => n.data.path);
        const directoryNodes = createDirectoryNodes(filePaths);
        directoryNodes.forEach(node => {
            elements.push(node);
            processedIds.add(node.data.id);
        });

        // ディレクトリ間エッジを生成
        const directoryEdges = aggregateEdgesToDirectories(fileEdges, fileNodes);
        directoryEdges.forEach(edge => {
            elements.push(edge);
        });

        console.log(`createElements - Created ${directoryNodes.length} directories, ${directoryEdges.length} edges`);
    } else if (currentNodeLevel === 'dir-file') {
        // ディレクトリ + ファイル表示
        console.log('createElements - Generating directory + file view');

        // ディレクトリノードを生成
        const filePaths = fileNodes.map(n => n.data.path);
        const directoryNodes = createDirectoryNodes(filePaths);
        directoryNodes.forEach(node => {
            elements.push(node);
            processedIds.add(node.data.id);
        });

        // ファイルノードを生成（親ディレクトリ関係を追加）
        fileNodes.forEach(node => {
            if (!processedIds.has(node.data.id)) {
                const dirPath = getDirectoryPath(node.data.path);
                const element: any = {
                    data: {
                        id: node.data.id,
                        label: node.data.label,
                        kind: node.data.kind,
                        path: node.data.path,
                        line: node.data.line
                    }
                };

                // ディレクトリに属する場合は親関係を設定
                if (dirPath) {
                    element.data.parent = `dir:${dirPath}`;
                }

                elements.push(element);
                processedIds.add(node.data.id);
            }
        });

        // ファイル間エッジを追加
        fileEdges.forEach(edge => {
            elements.push({
                data: {
                    id: edge.data.id,
                    source: edge.data.source,
                    target: edge.data.target,
                    relationshipCount: edge.data.relationshipCount,
                    relationshipDetails: edge.data.relationshipDetails
                }
            });
        });

        console.log(`createElements - Created ${directoryNodes.length} directories, ${fileNodes.length} files, ${fileEdges.length} edges`);
    } else if (currentNodeLevel === 'file-only') {
        // ファイルのみ表示
        console.log('createElements - Generating file-only view');

        fileNodes.forEach(node => {
            if (!processedIds.has(node.data.id)) {
                const element: any = {
                    data: {
                        id: node.data.id,
                        label: node.data.label,
                        kind: node.data.kind,
                        path: node.data.path,
                        line: node.data.line
                    }
                };

                // 元々のparent属性を保持（ファイルの場合は通常ない）
                if (node.data.parent) {
                    element.data.parent = node.data.parent;
                }

                elements.push(element);
                processedIds.add(node.data.id);
            }
        });

        // ファイル間エッジを追加
        fileEdges.forEach(edge => {
            elements.push({
                data: {
                    id: edge.data.id,
                    source: edge.data.source,
                    target: edge.data.target,
                    relationshipCount: edge.data.relationshipCount,
                    relationshipDetails: edge.data.relationshipDetails
                }
            });
        });

        console.log(`createElements - Created ${fileNodes.length} files, ${fileEdges.length} edges`);
    } else { // 'file-symbol'
        // ファイル + シンボル表示
        console.log('createElements - Generating file + symbol view');

        allNodes.forEach(node => {
            if (!processedIds.has(node.data.id)) {
                const element: any = {
                    data: {
                        id: node.data.id,
                        label: node.data.label,
                        kind: node.data.kind,
                        path: node.data.path,
                        line: node.data.line
                    }
                };

                // 元々のparent属性を保持
                if (node.data.parent) {
                    element.data.parent = node.data.parent;
                }

                elements.push(element);
                processedIds.add(node.data.id);
            }
        });

        // シンボル間エッジを追加
        symbolEdges.forEach(edge => {
            elements.push({
                data: {
                    id: edge.data.id,
                    source: edge.data.source,
                    target: edge.data.target
                }
            });
        });

        console.log(`createElements - Created ${allNodes.length} nodes, ${symbolEdges.length} edges`);
    }

    console.log('createElements - Total elements:', elements.length);
    return elements;
}

// ========================================
// Layout Position Calculation Helper
// ========================================

/**
 * 事前にレイアウト計算を行い、各ノードの座標を返す（非同期）
 * フォールバック用：拡張機能側から座標が送信されない場合のみ使用
 * 注意：dagreレイアウトは削除されたため、coseのみ使用可能
 * @param elements - ノードとエッジの配列
 * @param layoutName - 使用するレイアウト名（'cose'のみ）
 * @param layoutOptions - レイアウトオプション
 * @returns 各ノードIDと座標のマップ
 */
async function calculateLayoutPositions(elements: any[], layoutName: string, layoutOptions: any): Promise<Map<string, {x: number, y: number}>> {
    console.log(`⚠️ FALLBACK: calculateLayoutPositions - Computing ${layoutName} layout for ${elements.length} elements...`);
    console.log(`⚠️ This should only be called if extension-side layout calculation failed`);

    // dagreレイアウトは使用不可（ライブラリ削除済み）
    if (layoutName === 'dagre') {
        console.error(`❌ Dagre layout is no longer supported in webview. Using COSE instead.`);
        layoutName = 'cose';
        layoutOptions = {
            nodeRepulsion: 200000,
            idealEdgeLength: 300,
            edgeElasticity: 100,
            gravity: 30,
            numIter: 1000,
            randomize: false
        };
    }

    updateProgress(50, `Calculating ${layoutName} layout...`);

    // 一時的なコンテナを作成（適切なサイズで）
    const tempContainer = document.createElement('div');
    tempContainer.style.width = '1000px';
    tempContainer.style.height = '1000px';
    tempContainer.style.position = 'absolute';
    tempContainer.style.left = '-9999px';
    tempContainer.style.top = '-9999px';
    tempContainer.id = 'temp-layout-container';
    document.body.appendChild(tempContainer);

    try {
        updateProgress(55, 'Creating temporary graph...');
        // 一時的なCytoscapeインスタンスでレイアウトを計算
        const tempCy = cytoscape({
            container: tempContainer,
            elements: elements,
            headless: false, // headless=falseでレイアウト計算が正常に動作
            styleEnabled: false // スタイル計算を無効化して高速化
        });

        console.log(`calculateLayoutPositions - Created temp cytoscape with ${tempCy.nodes().length} nodes`);

        updateProgress(60, `Running ${layoutName} layout algorithm...`);
        // レイアウトを実行して完了を待つ
        const layout = tempCy.layout({
            ...layoutOptions,
            name: layoutName,
            animate: false, // アニメーション無効
            fit: true
        });

        // レイアウト完了を待つPromiseを作成
        await new Promise<void>((resolve, reject) => {
            let completed = false;
            let startTime = Date.now();

            // 進捗更新タイマー
            const progressTimer = setInterval(() => {
                if (!completed) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                    updateProgress(65, `Layout calculation in progress... (${elapsed}s)`);
                }
            }, 500);

            const timeout = setTimeout(() => {
                if (!completed) {
                    clearInterval(progressTimer);
                    console.error('calculateLayoutPositions - Layout timeout!');
                    reject(new Error('Layout calculation timeout'));
                }
            }, 60000); // 60秒のタイムアウト

            layout.on('layoutstop', () => {
                completed = true;
                clearTimeout(timeout);
                clearInterval(progressTimer);
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.log(`calculateLayoutPositions - Layout completed in ${elapsed}s`);
                updateProgress(70, 'Layout calculation complete');
                resolve();
            });

            layout.run();
            console.log('calculateLayoutPositions - Layout started...');
        });

        // 座標を取得
        const positions = new Map<string, {x: number, y: number}>();
        tempCy.nodes().forEach((node: any) => {
            const pos = node.position();
            positions.set(node.id(), { x: pos.x, y: pos.y });
        });

        console.log(`calculateLayoutPositions - Calculated positions for ${positions.size} nodes`);

        // サンプル座標を表示（最初の5つ）
        let sampleCount = 0;
        positions.forEach((pos, id) => {
            if (sampleCount < 5) {
                console.log(`  Sample: ${id} -> (${pos.x.toFixed(2)}, ${pos.y.toFixed(2)})`);
                sampleCount++;
            }
        });

        // 一時インスタンスを破棄
        tempCy.destroy();
        document.body.removeChild(tempContainer);

        return positions;
    } catch (error) {
        console.error('calculateLayoutPositions - ERROR:', error);
        if (error instanceof Error) {
            console.error('Error details:', error.message);
            console.error('Error stack:', error.stack);
        }
        if (document.body.contains(tempContainer)) {
            document.body.removeChild(tempContainer);
        }
        return new Map();
    }
}

// ========================================
// Common Event Handlers
// ========================================

function setupCommonEventHandlers(): void {
    const cy = cyInstance;

    // エッジのマウスホバー処理
    cy.on('mouseover', 'edge', function(evt: any) {
        const edge = evt.target;
        const relationshipDetails = edge.data('relationshipDetails') || [];

        if (relationshipDetails.length > 0) {
            tooltip.innerHTML = '';

            const sortedRelations: any[] = [];
            relationshipDetails.forEach((detail: any) => {
                sortedRelations.push({
                    referenceSymbol: detail.referenceSymbolName,
                    defineSymbol: detail.defineSymbolName,
                    referenceLine: detail.referenceLine,
                    detail
                });
            });

            sortedRelations.sort((a, b) => {
                const symbolCompare = a.referenceSymbol.localeCompare(b.referenceSymbol);
                if (symbolCompare !== 0) {return symbolCompare;}
                return a.referenceLine - b.referenceLine;
            });

            let displayCount = 0;
            for (const relation of sortedRelations) {
                if (displayCount >= 10) {break;}

                const relationDiv = document.createElement('div');
                relationDiv.style.cssText = 'margin: 2px 0; color: white; cursor: pointer; padding: 2px 4px; border-radius: 2px;';
                relationDiv.style.cssText += 'background: rgba(255, 255, 255, 0.1); border-left: 3px solid #4A90E2;';
                relationDiv.textContent = `${relation.referenceSymbol} → ${relation.defineSymbol}`;

                relationDiv.addEventListener('click', function(e: MouseEvent) {
                    e.stopPropagation();
                    const rect = relationDiv.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const arrowPos = relationDiv.textContent!.indexOf(' → ');
                    const charWidth = rect.width / relationDiv.textContent!.length;
                    const arrowPixelPos = arrowPos * charWidth;

                    if (!window.IS_STANDALONE && vscode) {
                        if (clickX < arrowPixelPos) {
                            vscode.postMessage({type: 'openFile', path: relation.detail.referencePath, line: relation.detail.referenceLine});
                        } else {
                            vscode.postMessage({type: 'openFile', path: relation.detail.definePath, line: relation.detail.defineLine});
                        }
                    }
                    tooltip.style.opacity = '0';
                });

                tooltip.appendChild(relationDiv);
                displayCount++;
            }

            if (sortedRelations.length > 10) {
                const moreDiv = document.createElement('div');
                moreDiv.style.cssText = 'margin-top: 4px; color: #888; font-style: italic; text-align: center;';
                moreDiv.textContent = `... 他 ${sortedRelations.length - 10} 関係`;
                tooltip.appendChild(moreDiv);
            }

            tooltip.style.opacity = '1';
        }
    });

    cy.on('mouseout', 'edge', function() {
        tooltip.style.opacity = '0';
        tooltipPosition = null;
    });

    cy.on('mousemove', function(evt: any) {
        if (tooltip.style.opacity === '1' && tooltipPosition === null) {
            tooltipPosition = {
                x: evt.originalEvent.pageX + 10,
                y: evt.originalEvent.pageY - 10
            };
            tooltip.style.left = tooltipPosition.x + 'px';
            tooltip.style.top = tooltipPosition.y + 'px';
        }
    });

    // ノードクリック
    cy.on('tap', 'node', function(evt: any) {
        const node = evt.target;
        const filePath = node.data('path');
        const line = node.data('line');
        if (evt.originalEvent && (evt.originalEvent.ctrlKey || evt.originalEvent.metaKey)) {
            if (filePath && !window.IS_STANDALONE && vscode) {
                vscode.postMessage({ type: 'openFile', path: filePath, line: line });
            }
        }
    });

    // ダブルクリック
    cy.on('dbltap', 'node', function(evt: any) {
        const node = evt.target;
        const filePath = node.data('path');
        const line = node.data('line');
        if (filePath && !window.IS_STANDALONE && vscode) {
            vscode.postMessage({ type: 'openFile', path: filePath, line: line });
        }
    });
}

// ========================================
// Control Functions
// ========================================

function fitGraph(): void {
    if (cyInstance) {
        cyInstance.fit();
    }
}

function resetLayout(): void {
    if (cyInstance) {
        const layout = cyInstance.layout(cyInstance.options().layout);
        layout.run();
    }
}

/**
 * ドロップダウンのオプションを更新する
 * データセットサイズに応じてオプションを有効/無効化
 */
function updateNodeLevelDropdown(): void {
    const dropdown = document.getElementById('node-level') as HTMLSelectElement;
    if (!dropdown) {
        console.warn('updateNodeLevelDropdown - Dropdown not found');
        return;
    }

    const totalNodes = allNodes.length;
    const currentLevel = nodeLevel;

    // サイズ制限の定義
    const SMALL_SIZE = 15000;   // 小規模: すべてのオプション使用可能
    const MEDIUM_SIZE = 50000;  // 中規模: dir-only, dir-file, file-only
    // 大規模: dir-only, dir-file, file-only

    console.log(`updateNodeLevelDropdown: totalNodes=${totalNodes}, currentLevel=${currentLevel}`);

    // ドロップダウンの値を現在のレベルに設定
    dropdown.value = currentLevel;

    // 各オプションの有効/無効を設定
    const dirOnlyOption = dropdown.querySelector('option[value="dir-only"]') as HTMLOptionElement;
    const dirFileOption = dropdown.querySelector('option[value="dir-file"]') as HTMLOptionElement;
    const fileOnlyOption = dropdown.querySelector('option[value="file-only"]') as HTMLOptionElement;
    const fileSymbolOption = dropdown.querySelector('option[value="file-symbol"]') as HTMLOptionElement;

    if (totalNodes > MEDIUM_SIZE) {
        // 大規模: dir-only, dir-file, file-only のみ
        console.log('Large dataset detected - limiting options');

        if (dirOnlyOption) {
            dirOnlyOption.disabled = false;
            dirOnlyOption.textContent = 'Directory Only';
        }
        if (dirFileOption) {
            dirFileOption.disabled = false;
            dirFileOption.textContent = 'Directory + File';
        }
        if (fileOnlyOption) {
            fileOnlyOption.disabled = false;
            fileOnlyOption.textContent = 'File Only';
        }
        if (fileSymbolOption) {
            fileSymbolOption.disabled = true;
            fileSymbolOption.textContent = 'File + Symbol (too large)';
        }

        // 強制的に file-only に切り替え
        if (currentLevel === 'file-symbol') {
            dropdown.value = 'file-only';
            nodeLevel = 'file-only';
            console.log('updateNodeLevelDropdown - Forced to file-only due to large dataset');
        }
    } else if (totalNodes > SMALL_SIZE) {
        // 中規模: dir-only, dir-file, file-only のみ
        console.log('Medium dataset detected - limiting options');

        if (dirOnlyOption) {
            dirOnlyOption.disabled = false;
            dirOnlyOption.textContent = 'Directory Only';
        }
        if (dirFileOption) {
            dirFileOption.disabled = false;
            dirFileOption.textContent = 'Directory + File';
        }
        if (fileOnlyOption) {
            fileOnlyOption.disabled = false;
            fileOnlyOption.textContent = 'File Only';
        }
        if (fileSymbolOption) {
            fileSymbolOption.disabled = true;
            fileSymbolOption.textContent = 'File + Symbol (too large)';
        }

        // 強制的に file-only に切り替え
        if (currentLevel === 'file-symbol') {
            dropdown.value = 'file-only';
            nodeLevel = 'file-only';
            console.log('updateNodeLevelDropdown - Forced to file-only due to medium dataset');
        }
    } else {
        // 小規模: すべてのオプション使用可能
        console.log('Small dataset - all options available');

        if (dirOnlyOption) {
            dirOnlyOption.disabled = false;
            dirOnlyOption.textContent = 'Directory Only';
        }
        if (dirFileOption) {
            dirFileOption.disabled = false;
            dirFileOption.textContent = 'Directory + File';
        }
        if (fileOnlyOption) {
            fileOnlyOption.disabled = false;
            fileOnlyOption.textContent = 'File Only';
        }
        if (fileSymbolOption) {
            fileSymbolOption.disabled = false;
            fileSymbolOption.textContent = 'File + Symbol';
        }
    }
}

function changeNodeLevel(level: string): void {
    // NodeLevelの型チェック
    if (level !== 'dir-only' && level !== 'dir-file' && level !== 'file-only' && level !== 'file-symbol') {
        console.error(`Invalid node level: ${level}`);
        return;
    }

    const newLevel = level as NodeLevel;
    const previousLevel = nodeLevel;

    // 変更がない場合はスキップ
    if (previousLevel === newLevel) {
        console.log(`changeNodeLevel: No change (already ${newLevel})`);
        return;
    }

    // 状態を更新
    nodeLevel = newLevel;
    console.log(`changeNodeLevel: ${previousLevel} → ${newLevel}`);

    // ビューを再初期化
    (async () => {
        try {
            // プログレスバーを再表示
            showProgress();

            const levelLabel = newLevel === 'file-only' ? 'File Only' : 'File + Symbol';
            updateProgress(10, `Switching to ${levelLabel} view...`);

            // 既存のインスタンスを破棄
            if (cyInstance) {
                updateProgress(20, 'Destroying previous view...');
                cyInstance.destroy();
                cyInstance = null;
            }

            updateProgress(30, 'Rebuilding view...');

            // ビューを再初期化（initializeView内でupdateProgress(100)が呼ばれる）
            await initializeView();
        } catch (error) {
            hideProgress();
            showErrorMessage(`Failed to change node level: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('Change node level error:', error);
        }
    })();
}

// ========================================
// Export Functions
// ========================================

function exportHTML(): void {
    if (!window.IS_STANDALONE && vscode) {
        try {
            showProgress();
            updateProgress(10, 'Preparing HTML export...');

            // 現在のビューではなく、元の全データを送信
            // スタンドアロンHTMLでは全データが必要（ビューごとのフィルタリングは表示時に行われる）
            // allNodes/allEdgesは既に { data: {...} } の形式で格納されている
            console.log(`Exporting HTML with ${allNodes.length} nodes and ${allEdges.length} edges`);

            // UIを更新してから送信
            setTimeout(async () => {
                try {
                    updateProgress(20, 'Preparing layout positions...');

                    // まずexportHTMLメッセージを送信（データのみ）
                    vscode.postMessage({
                        type: 'exportHTML',
                        data: { nodes: allNodes, edges: allEdges }
                    });

                    updateProgress(30, 'Sending layout positions...');

                    // layoutPositionsをチャンク分割して送信
                    await sendLayoutPositionsInChunks();

                    updateProgress(50, 'Waiting for file save...');
                    // ここで止める。拡張機能からexportHTMLCompleteメッセージが来るまで待つ
                } catch (error) {
                    hideProgress();
                    showErrorMessage(`HTML export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    console.error('HTML export error:', error);
                }
            }, 200); // UIが確実に更新されるように遅延を増やす
        } catch (error) {
            hideProgress();
            showErrorMessage(`HTML export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('HTML export error:', error);
        }
    }
}

/**
 * layoutPositionsをチャンク分割して拡張機能側に送信
 */
async function sendLayoutPositionsInChunks(): Promise<void> {
    if (!vscode) {
        console.error('vscode API not available');
        return;
    }

    const CHUNK_SIZE = 5000;  // 5000座標/チャンク
    const viewTypes = Array.from(layoutPositions.keys());

    if (viewTypes.length === 0) {
        console.log('No layout positions to send');
        // 座標がない場合も完了を通知
        vscode.postMessage({
            type: 'layoutPositionsComplete'
        });
        return;
    }

    let totalPositions = 0;
    viewTypes.forEach(viewType => {
        totalPositions += layoutPositions.get(viewType)!.size;
    });

    console.log(`Sending ${totalPositions} layout positions in chunks (chunk size: ${CHUNK_SIZE})`);

    for (const viewType of viewTypes) {
        const positionMap = layoutPositions.get(viewType)!;
        const positionsArray = Array.from(positionMap.entries()).map(([id, pos]) => ({
            id,
            x: Math.round(pos.x),  // 整数化してサイズ削減
            y: Math.round(pos.y)
        }));

        const totalChunks = Math.ceil(positionsArray.length / CHUNK_SIZE);
        console.log(`Sending ${positionsArray.length} positions for view '${viewType}' in ${totalChunks} chunks`);

        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
            const start = chunkIndex * CHUNK_SIZE;
            const end = Math.min((chunkIndex + 1) * CHUNK_SIZE, positionsArray.length);
            const chunkData = positionsArray.slice(start, end);

            vscode.postMessage({
                type: 'layoutPositionsChunk',
                viewType: viewType,
                chunk: chunkIndex,
                totalChunks: totalChunks,
                positions: chunkData
            });

            console.log(`Sent chunk ${chunkIndex + 1}/${totalChunks} for '${viewType}' (${chunkData.length} positions)`);

            // UI応答性維持のため短い待機
            await new Promise(resolve => setTimeout(resolve, 50));
        }
    }

    // 全チャンク送信完了を通知
    vscode.postMessage({
        type: 'layoutPositionsComplete'
    });

    console.log('All layout position chunks sent');
}

// Make functions available globally for HTML onclick handlers
(window as any).fitGraph = fitGraph;
(window as any).resetLayout = resetLayout;
(window as any).changeNodeLevel = changeNodeLevel;
(window as any).exportHTML = exportHTML;

// ========================================
// Initialize
// ========================================

// データが既にロード済みの場合（埋め込みデータまたは外部データファイル）のみ初期化
// postMessageでデータが送られる場合は、graphDataCompleteハンドラーで初期化される
if (isDataLoaded) {
    console.log('=== Data loaded, initializing views... ===');
    console.log('isDataLoaded:', isDataLoaded);
    console.log('allNodes.length:', allNodes.length);
    console.log('allEdges.length:', allEdges.length);

    // データセットサイズに応じて初期ノードレベルを調整
    const totalNodes = allNodes.length;
    const isLargeDataset = totalNodes > HierarchyView_LIMIT_ONLY_FILE;
    if (isLargeDataset) {
        console.log('Large dataset detected. Setting to file-only mode.');
        nodeLevel = 'file-only';
    }

    (async () => {
        try {
            showProgress();
            updateProgress(70, 'Initializing views...');
            await initializeView();
            updateProgress(100, 'Complete!');
            console.log('=== Initialization complete ===');
        } catch (error) {
            hideProgress();
            showErrorMessage(`Failed to initialize view: ${error instanceof Error ? error.message : 'Unknown error'}`);
            console.error('=== Initialization failed ===', error);
        }
    })();
} else {
    console.log('=== Waiting for data from extension via postMessage... ===');
}
