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

// Register cytoscape-cise extension (community-aware layout)
// cytoscape-cise exports itself as 'cytoscapeCise' on window
declare const cytoscapeCise: any;
if (typeof cytoscapeCise !== 'undefined' && typeof cytoscape !== 'undefined') {
    try {
        cytoscape.use(cytoscapeCise);
        console.log('cytoscape-cise: registered successfully');
    } catch (e) {
        console.log('cytoscape-cise: already registered or error:', e);
    }
} else {
    console.log('cytoscape-cise: not loaded (will use COSE fallback)');
    console.log('  cytoscapeCise:', typeof cytoscapeCise);
    console.log('  cytoscape:', typeof cytoscape);
}

// Note: Layout is now calculated using CiSE (community detection) or COSE (fallback)

// ========================================
// Logging to Extension
// ========================================

// VSCode APIインスタンス（スタンドアロンモード以外で使用）
const vscode = !window.IS_STANDALONE ? acquireVsCodeApi() : null;

/**
 * WebViewのログを拡張機能に送信
 * @param level ログレベル ('log' | 'warn' | 'error')
 * @param message ログメッセージ
 */
function sendLogToExtension(level: 'log' | 'warn' | 'error', message: string): void {
    // コンソールにも出力
    if (level === 'error') {
        console.error(message);
    } else if (level === 'warn') {
        console.warn(message);
    } else {
        console.log(message);
    }

    // 拡張機能にログを送信（スタンドアロンモード以外）
    if (vscode) {
        vscode.postMessage({
            type: 'webviewLog',
            level: level,
            message: message,
            timestamp: new Date().toISOString()
        });
    }
}

/**
 * 通常ログを送信
 */
function logToExtension(message: string): void {
    sendLogToExtension('log', message);
}

/**
 * 警告ログを送信
 */
function warnToExtension(message: string): void {
    sendLogToExtension('warn', message);
}

/**
 * エラーログを送信
 */
function errorToExtension(message: string): void {
    sendLogToExtension('error', message);
}

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

// 色を暗くする関数
function darkenColor(color: string, amount: number): string {
    // HEX色をパース
    let r: number, g: number, b: number;
    if (color.startsWith('#')) {
        r = parseInt(color.substring(1, 3), 16);
        g = parseInt(color.substring(3, 5), 16);
        b = parseInt(color.substring(5, 7), 16);
    } else {
        return color; // パース失敗時は元の色を返す
    }

    // 暗くする
    r = Math.max(0, Math.floor(r * (1 - amount)));
    g = Math.max(0, Math.floor(g * (1 - amount)));
    b = Math.max(0, Math.floor(b * (1 - amount)));

    // HEXに戻す
    return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
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

// 拡張機能側で計算されたレイアウト座標（フェーズ3: 高速化）
interface PreCalculatedPosition {
    id: string;
    x: number;
    y: number;
}
let preCalculatedPositions: PreCalculatedPosition[] = [];

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

// Note: vscode API is declared in "Logging to Extension" section above

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
    } else if (message.type === 'communityInfo') {
        // 拡張機能側で計算されたコミュニティ情報を受信
        const { communities, colors, clusters, communityCount, hierarchicalCommunities, communityHierarchy: hierarchy } = message;
        console.log(`=== RECEIVED COMMUNITY INFO ===`);
        console.log(`Community count: ${communityCount}`);
        console.log(`Nodes with community: ${communities.length}`);
        console.log(`Clusters: ${clusters.length}`);

        // コミュニティマッピングをMapに変換
        communities.forEach((c: {nodeId: string, communityId: number}) => {
            communityMap.set(c.nodeId, c.communityId);
        });

        // コミュニティ色をMapに変換
        colors.forEach((c: {communityId: number, color: string}) => {
            communityColors.set(c.communityId, c.color);
        });

        // クラスタ情報を保存（CiSEレイアウト用）
        communityClusterArray.length = 0;
        communityClusterArray.push(...clusters);

        // 階層的コミュニティ情報を保存
        if (hierarchicalCommunities && hierarchicalCommunities.length > 0) {
            hierarchicalCommunityMap.clear();
            hierarchicalCommunities.forEach((c: {nodeId: string, communityId: string}) => {
                hierarchicalCommunityMap.set(c.nodeId, c.communityId);
            });
            console.log(`Stored hierarchical communities: ${hierarchicalCommunityMap.size} nodes`);
        }

        // コミュニティ階層情報を保存
        if (hierarchy && hierarchy.length > 0) {
            communityHierarchy.clear();
            hierarchy.forEach((c: {id: string, parentId: string | null, depth: number}) => {
                communityHierarchy.set(c.id, { parentId: c.parentId, depth: c.depth });
            });
            console.log(`Stored community hierarchy: ${communityHierarchy.size} communities`);
        }

        console.log(`Stored community info: ${communityMap.size} nodes, ${communityColors.size} colors`);
        console.log(`=== COMMUNITY INFO STORED ===`);
    } else if (message.type === 'layoutPositions') {
        // 旧形式: 単一レベルの座標（後方互換性のため残す）
        const { positions } = message;
        console.log(`=== RECEIVED LAYOUT POSITIONS (legacy) ===`);
        console.log(`Positions count: ${positions.length}`);

        // 座標を保存（file-onlyとして扱う）
        preCalculatedPositions = positions;
        const positionMap = new Map<string, {x: number, y: number}>();
        positions.forEach((pos: {id: string, x: number, y: number}) => {
            positionMap.set(pos.id, { x: pos.x, y: pos.y });
        });
        layoutPositions.set('file-only', positionMap);

        console.log(`Stored ${preCalculatedPositions.length} pre-calculated positions`);
        console.log(`=== LAYOUT POSITIONS STORED ===`);
    } else if (message.type === 'allLevelPositions') {
        // 新形式: 全レベルの座標（階層的導出アプローチ）
        const { positions } = message;
        console.log(`=== RECEIVED ALL LEVEL POSITIONS ===`);

        // 各レベルの座標をMapに変換して保存
        const levels = ['dir-only', 'dir-file', 'file-only', 'file-symbol'] as const;
        levels.forEach(level => {
            if (positions[level]) {
                const positionMap = new Map<string, {x: number, y: number}>();
                positions[level].forEach((pos: {id: string, x: number, y: number}) => {
                    positionMap.set(pos.id, { x: pos.x, y: pos.y });
                });
                layoutPositions.set(level, positionMap);
                console.log(`Stored ${positionMap.size} positions for '${level}'`);
            }
        });

        // 後方互換性のためpreCalculatedPositionsも設定（file-onlyを使用）
        if (positions['file-only']) {
            preCalculatedPositions = positions['file-only'];
        }

        console.log(`=== ALL LEVEL POSITIONS STORED (${layoutPositions.size} levels) ===`);
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

// コミュニティ検出結果を格納
const communityMap: Map<string, number> = new Map();  // nodeId -> communityId
const communityColors: Map<number, string> = new Map();  // communityId -> color
const communityClusterArray: string[][] = [];  // CiSEレイアウト用クラスタ配列

// 階層的コミュニティ情報を格納
const hierarchicalCommunityMap: Map<string, string> = new Map();  // nodeId -> hierarchicalCommunityId ("0.1.2"形式)
const communityHierarchy: Map<string, { parentId: string | null, depth: number }> = new Map();  // communityId -> { parentId, depth }

// コミュニティの折りたたみ状態を管理
const collapsedCommunities: Set<number> = new Set();

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
// Layout Configuration
// ========================================

// レイアウト計算時間計測用
let layoutStartTime: number = 0;

/**
 * コミュニティベースのレイアウト設定を取得
 * 事前計算された座標がある場合はpresetレイアウト、
 * クラスタ情報がある場合はCiSE、ない場合はCOSEを使用
 */
function getCommunityLayout(): any {
    // レイアウト計算開始時刻を記録
    layoutStartTime = performance.now();
    const currentLevel = nodeLevel || 'file-only';
    logToExtension(`[WebView] === LAYOUT CALCULATION START === [${new Date().toISOString()}] level=${currentLevel}`);

    // 階層的導出アプローチ: 現在のレベルに対応する事前計算座標を使用
    const levelPositions = layoutPositions.get(currentLevel);
    if (levelPositions && levelPositions.size > 0) {
        logToExtension(`[WebView] Using PRESET layout for '${currentLevel}' with ${levelPositions.size} pre-calculated positions`);

        return {
            name: 'preset',
            positions: function(node: any) {
                const pos = levelPositions.get(node.id());
                if (pos) {
                    return pos;
                }
                // 座標がない場合はランダム位置
                warnToExtension(`[WebView] No pre-calculated position for node: ${node.id()} (level: ${currentLevel})`);
                return { x: Math.random() * 1000, y: Math.random() * 1000 };
            },
            fit: true,
            padding: 50,
            animate: true,
            animationDuration: 300,
            animationEasing: 'ease-out',
            ready: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT READY (PRESET) === [${elapsed}s] Using '${currentLevel}' positions`);
            },
            stop: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT STOP (PRESET) === [${elapsed}s] Layout complete`);
            }
        };
    }

    // 旧形式の後方互換性: preCalculatedPositionsがある場合
    if (preCalculatedPositions.length > 0) {
        logToExtension(`[WebView] Using PRESET layout (legacy) with ${preCalculatedPositions.length} pre-calculated positions`);

        // 座標をMapに変換（高速検索用）
        const positionMap = new Map<string, {x: number, y: number}>();
        preCalculatedPositions.forEach(pos => {
            positionMap.set(pos.id, { x: pos.x, y: pos.y });
        });

        return {
            name: 'preset',
            positions: function(node: any) {
                const pos = positionMap.get(node.id());
                if (pos) {
                    return pos;
                }
                // 座標がない場合はランダム位置
                warnToExtension(`[WebView] No pre-calculated position for node: ${node.id()}`);
                return { x: Math.random() * 1000, y: Math.random() * 1000 };
            },
            fit: true,
            padding: 50,
            animate: true,
            animationDuration: 300,
            animationEasing: 'ease-out',
            ready: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT READY (PRESET legacy) === [${elapsed}s] Using pre-calculated positions`);
            },
            stop: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT STOP (PRESET legacy) === [${elapsed}s] Layout complete`);
            }
        };
    }

    if (communityClusterArray.length > 0) {
        // CiSEレイアウト（コミュニティクラスタリング）
        logToExtension(`[WebView] Using CiSE layout with ${communityClusterArray.length} clusters`);
        return {
            name: 'cise',
            clusters: communityClusterArray,
            animate: true,
            animationDuration: 1000,
            animationEasing: 'ease-out',
            fit: true,
            padding: 50,
            nodeSeparation: 12.5,
            idealInterClusterEdgeLengthCoefficient: 1.8,
            allowNodesInsideCircle: false,
            maxRatioOfNodesInsideCircle: 0.1,
            springCoeff: 0.45,
            nodeRepulsion: 4500,
            gravity: 0.25,
            gravityRange: 3.8,
            // レイアウトイベントコールバック
            ready: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT READY (CiSE) === [${elapsed}s] Initial positions set`);
            },
            stop: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT STOP (CiSE) === [${elapsed}s] Layout calculation complete`);
            }
        };
    } else {
        // フォールバック: COSEレイアウト
        logToExtension(`[WebView] No clusters available, using COSE layout as fallback`);
        return {
            name: 'cose',
            animate: true,
            animationDuration: 1000,
            animationEasing: 'ease-out',
            fit: true,
            padding: 50,
            nodeRepulsion: function() { return 200000; },
            idealEdgeLength: function() { return 300; },
            edgeElasticity: function() { return 100; },
            gravity: 30,
            numIter: 1000,
            randomize: false,
            // レイアウトイベントコールバック
            ready: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT READY (COSE) === [${elapsed}s] Initial positions set`);
            },
            stop: function() {
                const elapsed = ((performance.now() - layoutStartTime) / 1000).toFixed(3);
                logToExtension(`[WebView] === LAYOUT STOP (COSE) === [${elapsed}s] Layout calculation complete`);
            }
        };
    }
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

        // コミュニティ情報をノードに付加
        console.log(`=== APPLYING COMMUNITY INFO ===`);
        console.log(`Community map size: ${communityMap.size}`);
        console.log(`Community colors size: ${communityColors.size}`);
        console.log(`Cluster array length: ${communityClusterArray.length}`);

        let communityAppliedCount = 0;
        graphElements.forEach((el: any) => {
            if (!el.data.source) { // ノードのみ
                const communityId = communityMap.get(el.data.id);
                if (communityId !== undefined) {
                    el.data.communityId = communityId;
                    el.data.communityColor = communityColors.get(communityId) || '#888888';
                    communityAppliedCount++;
                }
            }
        });
        console.log(`Applied community info to ${communityAppliedCount} nodes`);

        updateProgress(75, 'Preparing layout...');

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
                            // コミュニティ色がある場合はそれを使用、なければデフォルト色
                            const communityColor = ele.data('communityColor');
                            return communityColor || getSymbolKindColor(ele.data('kind'));
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
                        'border-color': function(ele: any) {
                            // コミュニティ色をボーダーにも適用（暗めに）
                            const communityColor = ele.data('communityColor');
                            return communityColor ? darkenColor(communityColor, 0.3) : '#2E5984';
                        },
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
            layout: getCommunityLayout()
        });

        console.log(`initView - Cytoscape created: ${cyInstance.nodes().length} nodes, ${cyInstance.edges().length} edges`);

        // パンズームコントロールの初期化
        initPanControl();
        initZoomControls();
        updateZoomDisplay();

        // ズーム変更時にスライダーを更新
        cyInstance.on('zoom', () => {
            updateZoomDisplay();
        });

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

/**
 * クラスタ全体のドラッグ移動を設定
 *
 * ドロップダウン「Drag:」で範囲を選択:
 * - Single Node: 通常のノードドラッグ（Alt不要）
 * - Community: Alt+ドラッグで同じコミュニティのノードを移動
 * - Parent Cluster: Alt+ドラッグで親クラスタのノードを移動（階層的クラスタID使用）
 */
function setupClusterDrag(cy: any): void {
    let isDraggingCluster = false;
    let draggedNode: any = null;
    let clusterNodes: any[] = [];
    let initialPositions: Map<string, { x: number, y: number }> = new Map();
    let dragStartPosition: { x: number, y: number } | null = null;

    /**
     * ドロップダウンから選択されたドラッグレベルを取得
     */
    function getCommunityDragLevel(): string {
        const selector = document.getElementById('community-drag-level') as HTMLSelectElement;
        return selector ? selector.value : 'community';
    }

    /**
     * 階層的コミュニティIDから親コミュニティIDを取得
     * "0.1.2" -> "0.1", "0.1" -> "0", "0" -> null
     */
    function getParentCommunityId(communityId: string): string | null {
        if (!communityId || !communityId.includes('.')) {
            return null;
        }
        return communityId.substring(0, communityId.lastIndexOf('.'));
    }

    /**
     * 指定したコミュニティIDに属する全ノードを取得
     * コミュニティIDが "0.1" の場合、"0.1", "0.1.0", "0.1.1", "0.1.2.0" などすべて含む
     */
    function getNodesInCommunity(cy: any, communityId: string): any[] {
        return cy.nodes().filter((n: any) => {
            const nodeCommunityId = hierarchicalCommunityMap.get(n.id());
            if (!nodeCommunityId) {return false;}
            // 完全一致または子コミュニティ
            return nodeCommunityId === communityId || nodeCommunityId.startsWith(communityId + '.');
        }).toArray();
    }

    // ノードのドラッグ開始
    cy.on('grab', 'node', function(evt: any) {
        const node = evt.target;
        const originalEvent = evt.originalEvent;
        const dragLevel = getCommunityDragLevel();

        // Single Nodeモードの場合は通常のドラッグ
        if (dragLevel === 'single') {
            return;
        }

        // Alt(Option)キーが押されている場合、クラスタドラッグモード
        if (originalEvent && originalEvent.altKey) {
            isDraggingCluster = true;
            draggedNode = node;

            if (dragLevel === 'parent') {
                // Parent Community: 階層的コミュニティIDを使用して親コミュニティのノードを移動
                const nodeCommunityId = hierarchicalCommunityMap.get(node.id());
                if (nodeCommunityId) {
                    const parentCommunityId = getParentCommunityId(nodeCommunityId);
                    if (parentCommunityId) {
                        // 親コミュニティに属するノードを取得
                        clusterNodes = getNodesInCommunity(cy, parentCommunityId);
                        console.log(`Community drag (parent ${parentCommunityId}): ${clusterNodes.length} nodes`);
                    } else {
                        // 親がない場合は同じコミュニティのノードを移動
                        clusterNodes = getNodesInCommunity(cy, nodeCommunityId);
                        console.log(`Community drag (community ${nodeCommunityId}, no parent): ${clusterNodes.length} nodes`);
                    }
                } else {
                    // 階層的コミュニティ情報がない場合はコミュニティIDを使用
                    const communityId = node.data('communityId');
                    if (communityId !== undefined) {
                        clusterNodes = cy.nodes().filter((n: any) => {
                            return n.data('communityId') === communityId;
                        }).toArray();
                        console.log(`Community drag (community ${communityId}, fallback): ${clusterNodes.length} nodes`);
                    }
                }
            } else {
                // Community: 同じコミュニティのノードを移動
                const communityId = node.data('communityId');
                if (communityId !== undefined) {
                    clusterNodes = cy.nodes().filter((n: any) => {
                        return n.data('communityId') === communityId;
                    }).toArray();
                    console.log(`Community drag (community ${communityId}): ${clusterNodes.length} nodes`);
                }
            }

            if (clusterNodes.length > 0) {
                // 各ノードの初期位置を記録
                initialPositions.clear();
                clusterNodes.forEach((n: any) => {
                    const pos = n.position();
                    initialPositions.set(n.id(), { x: pos.x, y: pos.y });
                });

                // ドラッグ開始位置を記録
                const nodePos = node.position();
                dragStartPosition = { x: nodePos.x, y: nodePos.y };
            }
        }
    });

    // ノードのドラッグ中
    cy.on('drag', 'node', function(evt: any) {
        if (!isDraggingCluster || !draggedNode || !dragStartPosition) {return;}

        const node = evt.target;
        if (node.id() !== draggedNode.id()) {return;}

        // ドラッグしたノードの現在位置
        const currentPos = node.position();

        // 移動量を計算
        const dx = currentPos.x - dragStartPosition.x;
        const dy = currentPos.y - dragStartPosition.y;

        // 他のクラスタノードを同じ距離だけ移動
        clusterNodes.forEach((n: any) => {
            if (n.id() === draggedNode.id()) {return;} // ドラッグ中のノードはスキップ

            const initialPos = initialPositions.get(n.id());
            if (initialPos) {
                n.position({
                    x: initialPos.x + dx,
                    y: initialPos.y + dy
                });
            }
        });
    });

    // ノードのドラッグ終了
    cy.on('free', 'node', function(evt: any) {
        if (isDraggingCluster) {
            console.log(`Cluster drag ended: moved ${clusterNodes.length} nodes`);
            isDraggingCluster = false;
            draggedNode = null;
            clusterNodes = [];
            initialPositions.clear();
            dragStartPosition = null;
        }
    });
}

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

    // ノードダブルクリックでファイルを開く
    cy.on('dbltap', 'node', function(evt: any) {
        const node = evt.target;
        const filePath = node.data('path');
        const line = node.data('line');
        if (filePath && !window.IS_STANDALONE && vscode) {
            vscode.postMessage({ type: 'openFile', path: filePath, line: line });
        }
    });

    // クラスタ全体のドラッグ移動
    setupClusterDrag(cy);
}

// ========================================
// Control Functions
// ========================================

// ========================================
// Panzoom Control Variables
// ========================================
let panAnimationId: number | null = null;
let zoomIntervalId: number | null = null;

/**
 * 円形パンコントロールを初期化
 */
function initPanControl(): void {
    const panCircle = document.getElementById('pan-circle') as HTMLElement | null;
    const panHandle = document.getElementById('pan-handle') as HTMLElement | null;
    if (!panCircle || !panHandle) {return;}

    // ローカル変数にキャッシュ（型安全のため）
    const circle = panCircle;
    const handle = panHandle;

    let isDragging = false;
    const circleRadius = circle.offsetWidth / 2;
    const handleRadius = handle.offsetWidth / 2;
    const maxOffset = circleRadius - handleRadius - 5; // パディング

    function startPan(clientX: number, clientY: number): void {
        isDragging = true;
        handle.classList.add('dragging');
        updatePan(clientX, clientY);
    }

    function updatePan(clientX: number, clientY: number): void {
        if (!isDragging) {return;}

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

        // パン方向を正規化
        if (distance > 5) { // デッドゾーン
            const dx = -(offsetX / distance) * panSpeed;
            const dy = -(offsetY / distance) * panSpeed;

            // 連続パンアニメーション
            if (panAnimationId !== null) {
                cancelAnimationFrame(panAnimationId);
            }

            function animatePan(): void {
                if (!isDragging || !cyInstance) {return;}
                cyInstance.panBy({ x: dx, y: dy });
                panAnimationId = requestAnimationFrame(animatePan);
            }
            animatePan();
        } else {
            // デッドゾーン内ならパン停止
            if (panAnimationId !== null) {
                cancelAnimationFrame(panAnimationId);
                panAnimationId = null;
            }
        }
    }

    function stopPan(): void {
        if (!isDragging) {return;}
        isDragging = false;
        handle.classList.remove('dragging');

        // ハンドルを中央に戻す
        handle.style.left = '50%';
        handle.style.top = '50%';

        // パンアニメーション停止
        if (panAnimationId !== null) {
            cancelAnimationFrame(panAnimationId);
            panAnimationId = null;
        }
    }

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
        if (!isDragging) {return;}
        const touch = e.touches[0];
        updatePan(touch.clientX, touch.clientY);
    });

    document.addEventListener('touchend', stopPan);
    document.addEventListener('touchcancel', stopPan);
}

/**
 * ズームコントロールを初期化（長押し対応）
 */
function initZoomControls(): void {
    const zoomInBtn = document.getElementById('zoom-in-btn');
    const zoomOutBtn = document.getElementById('zoom-out-btn');
    const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;

    if (!zoomInBtn || !zoomOutBtn || !zoomSlider) {return;}

    function startZoom(direction: number): void {
        zoomGraph(direction);
        // 長押し対応：50ms間隔で連続ズーム
        zoomIntervalId = window.setInterval(() => {
            zoomGraph(direction);
        }, 50);
    }

    function stopZoom(): void {
        if (zoomIntervalId !== null) {
            clearInterval(zoomIntervalId);
            zoomIntervalId = null;
        }
    }

    // ズームインボタン
    zoomInBtn.addEventListener('mousedown', () => startZoom(1));
    zoomInBtn.addEventListener('mouseup', stopZoom);
    zoomInBtn.addEventListener('mouseleave', stopZoom);
    zoomInBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startZoom(1); });
    zoomInBtn.addEventListener('touchend', stopZoom);
    zoomInBtn.addEventListener('touchcancel', stopZoom);

    // ズームアウトボタン
    zoomOutBtn.addEventListener('mousedown', () => startZoom(-1));
    zoomOutBtn.addEventListener('mouseup', stopZoom);
    zoomOutBtn.addEventListener('mouseleave', stopZoom);
    zoomOutBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startZoom(-1); });
    zoomOutBtn.addEventListener('touchend', stopZoom);
    zoomOutBtn.addEventListener('touchcancel', stopZoom);

    // スライダー
    zoomSlider.addEventListener('input', () => {
        setZoomLevel(zoomSlider.value);
    });
}

/**
 * グラフをズームする
 * @param direction ズーム方向 (1: 拡大, -1: 縮小)
 */
function zoomGraph(direction: number): void {
    if (!cyInstance) {return;}

    const zoomFactor = 0.05; // 連続ズーム用に小さめの値
    const currentZoom = cyInstance.zoom();
    const newZoom = direction > 0
        ? currentZoom * (1 + zoomFactor)
        : currentZoom * (1 - zoomFactor);

    // ズームレベルを制限 (0.1 〜 3.0)
    const clampedZoom = Math.max(0.1, Math.min(3.0, newZoom));

    cyInstance.zoom({
        level: clampedZoom,
        renderedPosition: {
            x: cyInstance.width() / 2,
            y: cyInstance.height() / 2
        }
    });

    updateZoomDisplay();
}

/**
 * ズームレベルを直接設定する
 * @param level ズームレベル (0.1 〜 3.0)
 */
function setZoomLevel(level: number | string): void {
    if (!cyInstance) {return;}

    const zoomLevel = typeof level === 'string' ? parseFloat(level) : level;

    cyInstance.zoom({
        level: zoomLevel,
        renderedPosition: {
            x: cyInstance.width() / 2,
            y: cyInstance.height() / 2
        }
    });

    updateZoomDisplay();
}

/**
 * ズーム表示を更新する
 */
function updateZoomDisplay(): void {
    if (!cyInstance) {return;}

    const currentZoom = cyInstance.zoom();

    // スライダーを更新
    const slider = document.getElementById('zoom-slider') as HTMLInputElement;
    if (slider) {
        slider.value = currentZoom.toString();
    }

    // パーセント表示を更新
    const zoomLevelDisplay = document.getElementById('zoom-level');
    if (zoomLevelDisplay) {
        zoomLevelDisplay.textContent = `${Math.round(currentZoom * 100)}%`;
    }
}

function fitGraph(): void {
    if (cyInstance) {
        cyInstance.fit();
    }
}

function resetLayout(): void {
    if (cyInstance) {
        const layout = cyInstance.layout(getCommunityLayout());
        layout.run();
    }
}

/**
 * コミュニティを折りたたむ
 * @param communityId 折りたたむコミュニティID
 */
function collapseCommunity(communityId: number): void {
    if (!cyInstance) {return;}

    // このコミュニティに属するノードを取得
    const communityNodes = cyInstance.nodes().filter((node: any) => {
        return node.data('communityId') === communityId;
    });

    if (communityNodes.length === 0) {
        console.log(`No nodes found for community ${communityId}`);
        return;
    }

    console.log(`Collapsing community ${communityId} with ${communityNodes.length} nodes`);

    // ノードを非表示にする
    communityNodes.hide();

    // このコミュニティに接続するエッジも非表示
    communityNodes.connectedEdges().hide();

    // 折りたたみ状態を記録
    collapsedCommunities.add(communityId);

    console.log(`Community ${communityId} collapsed`);
}

/**
 * コミュニティを展開する
 * @param communityId 展開するコミュニティID
 */
function expandCommunity(communityId: number): void {
    if (!cyInstance) {return;}

    // このコミュニティに属するノードを取得
    const communityNodes = cyInstance.nodes().filter((node: any) => {
        return node.data('communityId') === communityId;
    });

    if (communityNodes.length === 0) {
        console.log(`No nodes found for community ${communityId}`);
        return;
    }

    console.log(`Expanding community ${communityId} with ${communityNodes.length} nodes`);

    // ノードを表示
    communityNodes.show();

    // このコミュニティに接続するエッジも表示（両端が表示されている場合）
    communityNodes.connectedEdges().forEach((edge: any) => {
        const source = edge.source();
        const target = edge.target();
        if (source.visible() && target.visible()) {
            edge.show();
        }
    });

    // 折りたたみ状態を解除
    collapsedCommunities.delete(communityId);

    console.log(`Community ${communityId} expanded`);
}

/**
 * 全コミュニティを展開する
 */
function expandAllCommunities(): void {
    if (!cyInstance) {return;}

    console.log('Expanding all communities');
    cyInstance.nodes().show();
    cyInstance.edges().show();
    collapsedCommunities.clear();
}

/**
 * コミュニティの表示状態をトグルする
 * @param communityId コミュニティID
 */
function toggleCommunity(communityId: number): void {
    if (collapsedCommunities.has(communityId)) {
        expandCommunity(communityId);
    } else {
        collapseCommunity(communityId);
    }
}

// グローバル関数として公開
(window as any).collapseCommunity = collapseCommunity;
(window as any).expandCommunity = expandCommunity;
(window as any).expandAllCommunities = expandAllCommunities;
(window as any).toggleCommunity = toggleCommunity;

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
