/**
 * @file Code Relationship Diagram - Multi View Graph Script
 * @description Webview script for displaying multi-view code relationship diagrams
 */

const HierarchyView_LIMIT_ONLY_FILE = 5000; // 階層構造ビューでファイルレベルのみ表示する閾値
const CallGraphView_LIMIT_ONLY_FILE = 5000; // 呼び出しグラフビューでファイルレベルのみ表示する閾値

// Type declarations for global variables injected by HTML template
declare const cytoscape: any;
declare const cytoscapeDagre: any;
declare const dagre: any;

// Global window interface extension
declare global {
    interface Window {
        GRAPH_ELEMENTS: any[];
        GRAPH_NODES_COUNT: number;
        GRAPH_EDGES_COUNT: number;
        IS_STANDALONE: boolean;
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
console.log('dagre:', typeof dagre);
console.log('cytoscapeDagre:', typeof cytoscapeDagre);

// Register cytoscape-dagre extension
if (typeof cytoscape !== 'undefined' && typeof cytoscapeDagre !== 'undefined') {
    cytoscape.use(cytoscapeDagre);
    console.log('✓ cytoscape-dagre registered successfully');
} else {
    console.error('✗ Failed to register cytoscape-dagre:', {
        cytoscape: typeof cytoscape,
        cytoscapeDagre: typeof cytoscapeDagre,
        dagre: typeof dagre
    });
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

// ディレクトリツリーを構築する関数
function buildDirectoryTree(filePaths: string[]): Map<string, string | null> {
    // Map<ディレクトリパス, 親ディレクトリパス>
    const directoryMap = new Map<string, string | null>();

    filePaths.forEach(filePath => {
        // ファイルパスをディレクトリ部分に分割
        const parts = filePath.split('/');

        // ファイル名を除く（最後の要素）
        parts.pop();

        // 各ディレクトリレベルを処理
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

// ディレクトリノードを生成する関数
function createDirectoryNodes(filePaths: string[]): any[] {
    const directoryTree = buildDirectoryTree(filePaths);
    const directoryNodes: any[] = [];

    directoryTree.forEach((parent, dirPath) => {
        const parts = dirPath.split('/');
        const label = parts[parts.length - 1]; // 最後のディレクトリ名のみ

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

// ファイルパスからディレクトリパスを取得する関数
function getDirectoryPath(filePath: string): string | null {
    const parts = filePath.split('/');
    parts.pop(); // ファイル名を除く
    return parts.length > 0 ? parts.join('/') : null;
}

// ========================================
// Global State
// ========================================

let currentView: string = 'file-deps';
let cyInstances: Record<string, any> = {};
let callGraphOrientation: string = 'TB'; // TB (Top-Bottom) or LR (Left-Right)

// ディレクトリグループ化の状態（各ビューごと）
let showDirectoryGroups: Record<string, boolean> = {
    'file-deps': false,
    'hierarchy': false,
    'call-graph': false
};

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
        updateProgress(70, 'Initializing visualization...');

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

        // 初期ビューを初期化
        (async () => {
            await initializeView('file-deps');
            updateProgress(100, 'Complete!');
        })();
    }
});

// ========================================
// Data Preparation
// ========================================

updateProgress(10, 'Initializing graph...');
console.log('Initializing Multi-View with', window.GRAPH_NODES_COUNT, 'nodes and', window.GRAPH_EDGES_COUNT, 'edges');

// データをチャンクで受信するための変数
let allNodes: any[] = [];
let allEdges: any[] = [];
let isDataLoaded = false;

// 初期データをチェック（後方互換性のため）
if (window.GRAPH_ELEMENTS && window.GRAPH_ELEMENTS.length > 0) {
    console.log('Using embedded graph data (legacy mode)');
    const allElements = window.GRAPH_ELEMENTS;
    allNodes = allElements.filter(el => !el.data.source);
    allEdges = allElements.filter(el => el.data.source);
    isDataLoaded = true;

    console.log('Total elements:', allElements.length);
    console.log('Total nodes:', allNodes.length);
    console.log('Total edges:', allEdges.length);

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
    console.log('Waiting for graph data via postMessage...');
    updateProgress(20, 'Waiting for data...');
}

// ========================================
// View Switching
// ========================================

document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', () => {
        const targetView = button.getAttribute('data-view');
        if (targetView) {
            switchView(targetView);
        }
    });
});

function switchView(viewName: string): void {
    console.log('Switching to view:', viewName);

    // タブのアクティブ状態を更新
    document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
    });
    const activeButton = document.querySelector(`.tab-button[data-view="${viewName}"]`);
    if (activeButton) {
        activeButton.classList.add('active');
    }

    // ビューコンテナの表示切り替え
    document.querySelectorAll('.view-container').forEach(container => {
        container.classList.remove('active');
    });
    const activeView = document.getElementById(`view-${viewName}`);
    if (activeView) {
        activeView.classList.add('active');
    }

    currentView = viewName;

    // ビューがまだ初期化されていない場合は初期化
    if (!cyInstances[viewName]) {
        (async () => {
            await initializeView(viewName);
        })();
    } else {
        // 既存のビューをリフレッシュ
        cyInstances[viewName].resize();
        cyInstances[viewName].fit();
    }
}

async function initializeView(viewName: string): Promise<void> {
    console.log('Initializing view:', viewName);
    updateProgress(30 + (viewName === 'file-deps' ? 0 : 20), `Initializing ${viewName} view...`);

    try {
        switch (viewName) {
            case 'file-deps':
                initFileDepView();
                break;
            case 'hierarchy':
                await initHierarchyView();
                break;
            case 'call-graph':
                await initCallGraphView();
                break;
        }
        console.log(`View ${viewName} initialized successfully`);
    } catch (error) {
        console.error(`Error initializing view ${viewName}:`, error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
    }
}

// ========================================
// View 1: File Dependencies
// ========================================

function initFileDepView(): void {
    try {
        console.log('=== initFileDepView START ===');
        let fileNodes = allNodes.filter(node => node.data.kind === 0);
        const fileEdges = allEdges.filter(edge => edge.data.relationshipType === 'file-relationship');

        console.log('initFileDepView - File nodes:', fileNodes.length);
        console.log('initFileDepView - File edges:', fileEdges.length);

        if (fileNodes.length === 0) {
            console.error('initFileDepView - ERROR: No file nodes found!');
            return;
        }

        // ディレクトリグループ化が有効な場合、ディレクトリノードを追加し、ファイルノードにparent属性を設定
        const elements: any[] = [];
        if (showDirectoryGroups['file-deps']) {
            updateProgress(35, 'Creating directory nodes...');
            console.log('initFileDepView - Directory grouping enabled');
            const filePaths = fileNodes.map(node => node.data.path);
            const directoryNodes = createDirectoryNodes(filePaths);
            elements.push(...directoryNodes);
            console.log('initFileDepView - Directory nodes:', directoryNodes.length);

            updateProgress(40, 'Setting parent relationships...');
            // ファイルノードにparent属性を追加
            fileNodes = fileNodes.map(node => {
                const dirPath = getDirectoryPath(node.data.path);
                if (dirPath) {
                    return {
                        ...node,
                        data: {
                            ...node.data,
                            parent: `dir:${dirPath}`
                        }
                    };
                }
                return node;
            });
            console.log('initFileDepView - File nodes with parent:', fileNodes.filter(n => n.data.parent).length);
        } else {
            console.log('initFileDepView - Directory grouping disabled');
        }
        elements.push(...fileNodes, ...fileEdges);

        updateProgress(45, 'Rendering graph...');
        cyInstances['file-deps'] = cytoscape({
            container: document.getElementById('cy-file-deps'),
            elements: elements,
            style: [
                {
                    selector: 'node[kind=-1]', // ディレクトリノード
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
                        'font-size': '16px',
                        'font-weight': 'bold',
                        'shape': 'roundrectangle',
                        'width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 16, 'bold');
                            return Math.max(120, textWidth + 50) + 'px';
                        },
                        'height': '60px',
                        'text-wrap': 'none',
                        'border-width': '3px',
                        'border-color': '#6B8BB8',
                        'background-opacity': 0.3
                    }
                },
                {
                    selector: 'node[kind!=-1]', // ファイルノード
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
                        'font-size': '14px',
                        'font-weight': 'bold',
                        'shape': 'rectangle',
                        'width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 14, 'bold');
                            return Math.max(100, textWidth + 40) + 'px';
                        },
                        'height': '50px',
                        'text-wrap': 'none',
                        'border-width': '2px',
                        'border-color': '#2E5984',
                        'background-opacity': 0.9
                    }
                },
                {
                    selector: 'node.selected',
                    style: {
                        'border-color': '#FF6B35',
                        'border-width': '4px',
                        'background-color': '#1177bb',
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
                        'line-color': function(ele: any) {
                            const relationshipCount = ele.data('relationshipCount') || 1;
                            const intensity = Math.min(relationshipCount / 10, 1);
                            const red = Math.floor(71 + (231 - 71) * intensity);
                            const green = Math.floor(144 + (76 - 144) * intensity);
                            const blue = Math.floor(226 + (60 - 226) * intensity);
                            return `rgb(${red}, ${green}, ${blue})`;
                        },
                        'target-arrow-color': function(ele: any) {
                            const relationshipCount = ele.data('relationshipCount') || 1;
                            const intensity = Math.min(relationshipCount / 10, 1);
                            const red = Math.floor(71 + (231 - 71) * intensity);
                            const green = Math.floor(144 + (76 - 144) * intensity);
                            const blue = Math.floor(226 + (60 - 226) * intensity);
                            return `rgb(${red}, ${green}, ${blue})`;
                        },
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'opacity': function(ele: any) {
                            const relationshipCount = ele.data('relationshipCount') || 1;
                            return Math.min(0.6 + relationshipCount * 0.04, 1.0);
                        }
                    }
                }
            ],
            layout: {
                name: 'cose',
                animate: true,
                animationDuration: 1500,
                fit: true,
                padding: 120,
                nodeRepulsion: function(node: any) {
                    const symbolCount = node.data('symbolCount') || 1;
                    return 150000 + symbolCount * 8000;
                },
                nodeOverlap: 100,
                idealEdgeLength: function(edge: any) {
                    const relationshipCount = edge.data('relationshipCount') || 1;
                    return Math.max(250, 450 - relationshipCount * 15);
                },
                edgeElasticity: function(edge: any) {
                    const relationshipCount = edge.data('relationshipCount') || 1;
                    return 80 + relationshipCount * 15;
                },
                gravity: 25,
                numIter: 2000,
                initialTemp: 400,
                coolingFactor: 0.92,
                minTemp: 1.0,
                avoidOverlap: true,
                randomize: false,
                componentSpacing: 150
            }
        });

        setupCommonEventHandlers('file-deps');
        updateProgress(90, 'File dependencies view ready');
        console.log('=== initFileDepView COMPLETE ===');
    } catch (error) {
        console.error('initFileDepView - ERROR:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
    }
}

// ========================================
// View 2: Hierarchy
// ========================================

async function initHierarchyView(): Promise<void> {
    try {
        console.log('=== initHierarchyView START ===');
        const hierarchyElements = createHierarchyElements();

        console.log('initHierarchyView - Hierarchy elements:', hierarchyElements.length);

        if (hierarchyElements.length === 0) {
            console.error('initHierarchyView - ERROR: No elements found!');
            return;
        }

        // ノード数とエッジ数をカウント
        const nodeCount = hierarchyElements.filter((el: any) => !el.data.source).length;
        const edgeCount = hierarchyElements.filter((el: any) => el.data.source).length;

        console.log(`initHierarchyView - Dataset: ${nodeCount} nodes, ${edgeCount} edges`);

        // 大規模データセットの場合はプリセットレイアウトで座標を事前計算
        // 元データが大規模かエッジ数が多い場合はcoseレイアウトを使用（dagreは重い）
        const isLargeDataset = allNodes.length > HierarchyView_LIMIT_ONLY_FILE || edgeCount > 5000;
        let positions: Map<string, {x: number, y: number}> | null = null;

        if (isLargeDataset) {
            console.log('initHierarchyView - Large dataset detected. Pre-calculating positions with cose layout...');
            updateProgress(65, 'Calculating layout positions...');

            // 大規模データの場合はcoseレイアウトで座標計算（dagreより高速）
            positions = await calculateLayoutPositions(hierarchyElements, 'cose', {
                nodeRepulsion: 200000,
                idealEdgeLength: 300,
                edgeElasticity: 100,
                gravity: 30,
                numIter: 1000,
                randomize: false
            });
        } else {
            console.log('initHierarchyView - Small dataset. Pre-calculating positions with dagre layout...');
            updateProgress(65, 'Calculating layout positions...');

            // 小規模データの場合はdagreで階層構造を計算
            positions = await calculateLayoutPositions(hierarchyElements, 'dagre', {
                rankDir: 'TB',
                nodeSep: 50,
                rankSep: 100
            });
        }

        // ノードに座標を設定（親ノードを除く - 親ノードの位置は子ノードから自動計算される）
        if (positions && positions.size > 0) {
            updateProgress(75, 'Applying layout positions...');
            console.log(`initHierarchyView - Positions map size: ${positions.size}`);
            let appliedCount = 0;
            let skippedParentCount = 0;
            let notFoundCount = 0;
            hierarchyElements.forEach((el: any) => {
                if (!el.data.source) { // ノードのみ
                    // 親ノード（ディレクトリ）はスキップ - 位置は子ノードから自動計算される
                    if (el.data.kind === -1) {
                        skippedParentCount++;
                        return;
                    }

                    const pos = positions!.get(el.data.id);
                    if (pos && !isNaN(pos.x) && !isNaN(pos.y)) {
                        el.position = { x: pos.x, y: pos.y };
                        appliedCount++;
                    } else {
                        notFoundCount++;
                        if (notFoundCount <= 5) {
                            console.warn(`initHierarchyView - Invalid position for node: ${el.data.id} -> (${pos?.x}, ${pos?.y})`);
                        }
                    }
                }
            });
            console.log(`initHierarchyView - Applied positions: ${appliedCount}, Skipped parent nodes: ${skippedParentCount}, Invalid: ${notFoundCount}`);
            if (appliedCount > 0) {
                // サンプルノードの座標を表示
                const sampleNode = hierarchyElements.find((el: any) => !el.data.source && el.position && el.data.kind !== -1);
                if (sampleNode) {
                    console.log(`initHierarchyView - Sample position: ${sampleNode.data.id} -> (${sampleNode.position.x}, ${sampleNode.position.y})`);
                }
            }
        } else {
            console.warn('initHierarchyView - No positions to apply!');
        }

        updateProgress(80, 'Rendering hierarchy view...');
        console.log(`initHierarchyView - Creating Cytoscape instance with ${hierarchyElements.length} elements`);
        cyInstances['hierarchy'] = cytoscape({
            container: document.getElementById('cy-hierarchy'),
            elements: hierarchyElements,
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
                        'font-size': '14px',
                        'font-weight': 'bold',
                        'shape': 'rectangle',
                        'padding': '20px',
                        'min-width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 14, 'bold');
                            return Math.max(150, textWidth + 60) + 'px';
                        },
                        'text-wrap': 'none',
                        'border-width': '3px',
                        'border-color': '#2E5984',
                        'background-opacity': 0.3
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
                        'border-color': '#34495E'
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
                            // 大規模データセットの場合、relationshipCountを考慮
                            const relationshipCount = ele.data('relationshipCount') || 1;
                            if (nodeCount <= HierarchyView_LIMIT_ONLY_FILE) {
                                return 2;
                            } else {
                                return Math.min(Math.max(relationshipCount * 0.5, 1), 8);
                            }
                        },
                        'line-color': function(ele: any) {
                            if (nodeCount <= HierarchyView_LIMIT_ONLY_FILE) {
                                return '#7F8C8D';
                            } else {
                                const relationshipCount = ele.data('relationshipCount') || 1;
                                const intensity = Math.min(relationshipCount / 10, 1);
                                const red = Math.floor(127 + (231 - 127) * intensity);
                                const green = Math.floor(140 + (76 - 140) * intensity);
                                const blue = Math.floor(141 + (60 - 141) * intensity);
                                return `rgb(${red}, ${green}, ${blue})`;
                            }
                        },
                        'target-arrow-color': function(ele: any) {
                            if (nodeCount <= HierarchyView_LIMIT_ONLY_FILE) {
                                return '#7F8C8D';
                            } else {
                                const relationshipCount = ele.data('relationshipCount') || 1;
                                const intensity = Math.min(relationshipCount / 10, 1);
                                const red = Math.floor(127 + (231 - 127) * intensity);
                                const green = Math.floor(140 + (76 - 140) * intensity);
                                const blue = Math.floor(141 + (60 - 141) * intensity);
                                return `rgb(${red}, ${green}, ${blue})`;
                            }
                        },
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'opacity': function(ele: any) {
                            if (nodeCount <= HierarchyView_LIMIT_ONLY_FILE) {
                                return 0.8;
                            } else {
                                const relationshipCount = ele.data('relationshipCount') || 1;
                                return Math.min(0.5 + relationshipCount * 0.05, 1.0);
                            }
                        }
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

        console.log(`initHierarchyView - Cytoscape created: ${cyInstances['hierarchy'].nodes().length} nodes, ${cyInstances['hierarchy'].edges().length} edges`);

        setupCommonEventHandlers('hierarchy');
        updateProgress(90, 'Hierarchy view ready');
        console.log('=== initHierarchyView COMPLETE ===');
    } catch (error) {
        console.error('initHierarchyView - ERROR:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
    }
}

function createHierarchyElements(): any[] {
    const elements: any[] = [];
    const processedIds = new Set<string>();

    console.log('createHierarchyElements - Starting with', allNodes.length, 'nodes');

    // 大規模データセットの場合、ファイルレベルのみを表示
    const totalNodes = allNodes.length;
    const showOnlyFiles = totalNodes > HierarchyView_LIMIT_ONLY_FILE;

    if (showOnlyFiles) {
        console.log('createHierarchyElements - Large dataset detected. Showing file-level hierarchy only.');
    }

    // ディレクトリグループ化が有効な場合、ディレクトリノードを生成
    const useDirectoryGroups = showDirectoryGroups['hierarchy'] && showOnlyFiles;
    if (useDirectoryGroups) {
        console.log('createHierarchyElements - Directory grouping enabled');
        updateProgress(35, 'Creating directory nodes...');
        const filePaths = allNodes
            .filter(node => node.data.kind === 0)
            .map(node => node.data.path);
        const directoryNodes = createDirectoryNodes(filePaths);
        elements.push(...directoryNodes);
        console.log('createHierarchyElements - Directory nodes:', directoryNodes.length);
    } else {
        console.log('createHierarchyElements - Directory grouping disabled');
    }

    let nodesWithParent = 0;
    let fileNodeCount = 0;
    allNodes.forEach(node => {
        if (!processedIds.has(node.data.id)) {
            // 大規模データセットの場合、ファイルノードのみを表示
            if (showOnlyFiles && node.data.kind !== 0) {
                return; // スキップ
            }

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
                nodesWithParent++;
            }
            // ディレクトリグループ化が有効な場合、ファイルノードに親ディレクトリを設定
            else if (useDirectoryGroups && node.data.kind === 0) {
                const dirPath = getDirectoryPath(node.data.path);
                if (dirPath) {
                    element.data.parent = `dir:${dirPath}`;
                    nodesWithParent++;
                }
            }

            elements.push(element);
            processedIds.add(node.data.id);

            if (node.data.kind === 0) {
                fileNodeCount++;
            }
        }
    });

    console.log('createHierarchyElements - File nodes:', fileNodeCount);
    console.log('createHierarchyElements - Nodes with parent:', nodesWithParent);

    let symbolEdgeCount = 0;
    if (!showOnlyFiles) {
        allEdges.forEach(edge => {
            if (edge.data.relationshipType !== 'file-relationship') {
                elements.push({
                    data: {
                        id: edge.data.id,
                        source: edge.data.source,
                        target: edge.data.target
                    }
                });
                symbolEdgeCount++;
            }
        });
    } else {
        // ファイルレベルのエッジのみを追加
        allEdges.forEach(edge => {
            if (edge.data.relationshipType === 'file-relationship') {
                elements.push({
                    data: {
                        id: edge.data.id,
                        source: edge.data.source,
                        target: edge.data.target,
                        relationshipCount: edge.data.relationshipCount,
                        relationshipDetails: edge.data.relationshipDetails
                    }
                });
                symbolEdgeCount++;
            }
        });
    }

    console.log('createHierarchyElements - Edges:', symbolEdgeCount);
    console.log('createHierarchyElements - Total elements:', elements.length);

    return elements;
}

// ========================================
// View 3: Call Graph
// ========================================

async function initCallGraphView(): Promise<void> {
    try {
        console.log('=== initCallGraphView START ===');

        // 大規模データセットの場合、ファイルレベルのみを表示
        const totalNodes = allNodes.length;
        const showOnlyFiles = totalNodes > CallGraphView_LIMIT_ONLY_FILE;

        let callGraphElements: any[];
        let nodeCount: number;
        let edgeCount: number;

        if (showOnlyFiles) {
            console.log('initCallGraphView - Large dataset detected. Showing file-level only.');
            let fileNodes = allNodes.filter(node => node.data.kind === 0);
            const fileEdges = allEdges.filter(edge => edge.data.relationshipType === 'file-relationship');

            callGraphElements = [];

            // ディレクトリグループ化が有効な場合、ディレクトリノードを追加し、ファイルノードにparent属性を設定
            if (showDirectoryGroups['call-graph']) {
                console.log('initCallGraphView - Directory grouping enabled');
                updateProgress(35, 'Creating directory nodes...');
                const filePaths = fileNodes.map(node => node.data.path);
                const directoryNodes = createDirectoryNodes(filePaths);
                callGraphElements.push(...directoryNodes);
                console.log('initCallGraphView - Directory nodes:', directoryNodes.length);

                updateProgress(40, 'Setting parent relationships...');
                // ファイルノードにparent属性を追加
                fileNodes = fileNodes.map(node => {
                    const dirPath = getDirectoryPath(node.data.path);
                    if (dirPath) {
                        return {
                            ...node,
                            data: {
                                ...node.data,
                                parent: `dir:${dirPath}`
                            }
                        };
                    }
                    return node;
                });
                console.log('initCallGraphView - File nodes with parent:', fileNodes.filter(n => n.data.parent).length);
            } else {
                console.log('initCallGraphView - Directory grouping disabled');
            }

            callGraphElements.push(...fileNodes, ...fileEdges);
            nodeCount = fileNodes.length;
            edgeCount = fileEdges.length;
        } else {
            console.log('initCallGraphView - Small dataset. Showing symbol-level.');
            const symbolNodes = allNodes.filter(node => node.data.kind !== 0);
            const symbolEdges = allEdges.filter(edge => edge.data.relationshipType !== 'file-relationship');
            callGraphElements = [...symbolNodes, ...symbolEdges];
            nodeCount = symbolNodes.length;
            edgeCount = symbolEdges.length;
        }

        console.log(`initCallGraphView - Dataset: ${nodeCount} nodes, ${edgeCount} edges`);

        if (nodeCount === 0) {
            console.error('initCallGraphView - ERROR: No nodes found!');
            return;
        }

        // プリセットレイアウトで座標を事前計算
        console.log('initCallGraphView - Pre-calculating positions...');
        updateProgress(75, 'Calculating layout positions...');

        let positions: Map<string, {x: number, y: number}> | null = null;

        // エッジ数が多い場合もcoseレイアウトを使用（dagreは重い）
        const useCoseLayout = showOnlyFiles || edgeCount > 5000;

        if (useCoseLayout) {
            // ファイルレベルまたは大規模データの場合はcoseレイアウト
            positions = await calculateLayoutPositions(callGraphElements, 'cose', {
                nodeRepulsion: 200000,
                idealEdgeLength: 300,
                edgeElasticity: 100,
                gravity: 30,
                numIter: 1000,
                randomize: false
            });
        } else {
            // 小規模シンボルレベルの場合はdagreレイアウト
            positions = await calculateLayoutPositions(callGraphElements, 'dagre', {
                rankDir: callGraphOrientation,
                nodeSep: 40,
                rankSep: 80
            });
        }

        // ノードに座標を設定（親ノードを除く - 親ノードの位置は子ノードから自動計算される）
        if (positions && positions.size > 0) {
            updateProgress(75, 'Applying layout positions...');
            console.log(`initCallGraphView - Positions map size: ${positions.size}`);
            let appliedCount = 0;
            let skippedParentCount = 0;
            let notFoundCount = 0;
            callGraphElements.forEach((el: any) => {
                if (!el.data.source) { // ノードのみ
                    // 親ノード（ディレクトリ）はスキップ - 位置は子ノードから自動計算される
                    if (el.data.kind === -1) {
                        skippedParentCount++;
                        return;
                    }

                    const pos = positions!.get(el.data.id);
                    if (pos && !isNaN(pos.x) && !isNaN(pos.y)) {
                        el.position = { x: pos.x, y: pos.y };
                        appliedCount++;
                    } else {
                        notFoundCount++;
                        if (notFoundCount <= 5) {
                            console.warn(`initCallGraphView - Invalid position for node: ${el.data.id} -> (${pos?.x}, ${pos?.y})`);
                        }
                    }
                }
            });
            console.log(`initCallGraphView - Applied positions: ${appliedCount}, Skipped parent nodes: ${skippedParentCount}, Invalid: ${notFoundCount}`);
            if (appliedCount > 0) {
                // サンプルノードの座標を表示
                const sampleNode = callGraphElements.find((el: any) => !el.data.source && el.position && el.data.kind !== -1);
                if (sampleNode) {
                    console.log(`initCallGraphView - Sample position: ${sampleNode.data.id} -> (${sampleNode.position.x}, ${sampleNode.position.y})`);
                }
            }
        } else {
            console.warn('initCallGraphView - No positions to apply!');
        }

        updateProgress(80, 'Rendering call graph view...');
        cyInstances['call-graph'] = cytoscape({
            container: document.getElementById('cy-call-graph'),
            elements: callGraphElements,
            style: [
                {
                    selector: 'node[kind=-1]', // ディレクトリノード
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
                        'font-size': '15px',
                        'font-weight': 'bold',
                        'shape': 'roundrectangle',
                        'width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 15, 'bold');
                            return Math.max(110, textWidth + 50) + 'px';
                        },
                        'height': '60px',
                        'text-wrap': 'none',
                        'border-width': '3px',
                        'border-color': '#6B8BB8',
                        'background-opacity': 0.3
                    }
                },
                {
                    selector: 'node[kind!=-1]', // ファイル・シンボルノード
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
                        'font-size': '12px',
                        'shape': 'ellipse',
                        'width': function(ele: any) {
                            const label = ele.data('label');
                            const textWidth = measureTextWidth(label, 12, 'normal');
                            return Math.max(80, textWidth + 40) + 'px';
                        },
                        'height': '50px',
                        'text-wrap': 'none',
                        'border-width': '2px',
                        'border-color': '#34495E'
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
                        'width': 2,
                        'line-color': '#3498DB',
                        'target-arrow-color': '#3498DB',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier'
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

        console.log(`initCallGraphView - Cytoscape created: ${cyInstances['call-graph'].nodes().length} nodes, ${cyInstances['call-graph'].edges().length} edges`);

        setupCommonEventHandlers('call-graph');
        updateProgress(90, 'Call graph view ready');
        console.log('=== initCallGraphView COMPLETE ===');
    } catch (error) {
        console.error('initCallGraphView - ERROR:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
    }
}

// ========================================
// Layout Position Calculation Helper
// ========================================

/**
 * 事前にレイアウト計算を行い、各ノードの座標を返す（非同期）
 * @param elements - ノードとエッジの配列
 * @param layoutName - 使用するレイアウト名（'cose' または 'dagre'）
 * @param layoutOptions - レイアウトオプション
 * @returns 各ノードIDと座標のマップ
 */
async function calculateLayoutPositions(elements: any[], layoutName: string, layoutOptions: any): Promise<Map<string, {x: number, y: number}>> {
    console.log(`calculateLayoutPositions - Computing ${layoutName} layout for ${elements.length} elements...`);
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

function setupCommonEventHandlers(viewName: string): void {
    const cy = cyInstances[viewName];

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

function fitGraph(viewName: string): void {
    if (cyInstances[viewName]) {
        cyInstances[viewName].fit();
    }
}

function resetLayout(viewName: string): void {
    if (cyInstances[viewName]) {
        const cy = cyInstances[viewName];
        const layout = cy.layout(cy.options().layout);
        layout.run();
    }
}

function expandAll(): void {
    console.log('Expand all nodes');
}

function collapseAll(): void {
    console.log('Collapse all nodes');
}

function toggleOrientation(): void {
    callGraphOrientation = callGraphOrientation === 'TB' ? 'LR' : 'TB';
    const label = document.getElementById('orientation-label');
    if (label) {
        label.textContent = callGraphOrientation === 'TB' ? 'Horizontal' : 'Vertical';
    }

    if (cyInstances['call-graph']) {
        const cy = cyInstances['call-graph'];
        const layout = cy.layout({
            name: 'dagre',
            rankDir: callGraphOrientation,
            nodeSep: 40,
            rankSep: 80,
            animate: true,
            animationDuration: 1000
        });
        layout.run();
    }
}

function toggleDirectoryGroups(viewName: string): void {
    // 状態をトグル
    showDirectoryGroups[viewName] = !showDirectoryGroups[viewName];

    // ラベルを更新
    const label = document.getElementById(`dir-label-${viewName}`);
    if (label) {
        label.textContent = showDirectoryGroups[viewName] ? 'Dir: ON' : 'Dir: OFF';
    }

    console.log(`toggleDirectoryGroups - ${viewName}: ${showDirectoryGroups[viewName]}`);

    // ビューを再初期化
    (async () => {
        // プログレスバーを再表示
        progressContainer.style.display = 'block';
        progressContainer.style.opacity = '1';
        progressText.style.display = 'block';
        progressText.style.opacity = '1';

        updateProgress(10, showDirectoryGroups[viewName] ? 'Enabling directory grouping...' : 'Disabling directory grouping...');

        // 既存のインスタンスを破棄
        if (cyInstances[viewName]) {
            updateProgress(20, 'Destroying previous view...');
            cyInstances[viewName].destroy();
            delete cyInstances[viewName];
        }

        updateProgress(30, 'Rebuilding view...');

        // ビューを再初期化
        await initializeView(viewName);

        updateProgress(100, 'Complete!');
    })();
}

// ========================================
// Export Functions
// ========================================

// 現在開いているメニューのビュー名を保持
let currentOpenMenuView: string | null = null;

function toggleExportMenu(viewName: string): void {
    const menu = document.getElementById(`export-menu-${viewName}`);
    if (menu) {
        const isOpening = !menu.classList.contains('show');

        // 他のメニューを閉じる
        ['file-deps', 'hierarchy', 'call-graph'].forEach(view => {
            const otherMenu = document.getElementById(`export-menu-${view}`);
            if (otherMenu && view !== viewName) {
                otherMenu.classList.remove('show');
            }
        });

        menu.classList.toggle('show');
        if (isOpening) {
            currentOpenMenuView = viewName;
            setTimeout(() => {
                document.addEventListener('click', closeExportMenuOnOutsideClick, true);
            }, 0);
        } else {
            currentOpenMenuView = null;
            document.removeEventListener('click', closeExportMenuOnOutsideClick, true);
        }
    }
}

function closeExportMenu(viewName: string): void {
    const menu = document.getElementById(`export-menu-${viewName}`);
    if (menu) {
        menu.classList.remove('show');
        currentOpenMenuView = null;
        document.removeEventListener('click', closeExportMenuOnOutsideClick, true);
    }
}

function closeExportMenuOnOutsideClick(event: Event): void {
    if (currentOpenMenuView === null) {
        return;
    }

    const menu = document.getElementById(`export-menu-${currentOpenMenuView}`);
    if (!menu) {
        return;
    }

    // クリックされた要素がメニューまたはその親要素内かチェック
    let target = event.target as Node;
    let isInside = false;

    while (target) {
        if (target === menu || (target as Element).classList?.contains('export-dropdown')) {
            isInside = true;
            break;
        }
        target = target.parentNode as Node;
    }

    if (!isInside) {
        closeExportMenu(currentOpenMenuView);
    }
}

function exportPNG(): void {
    const cy = cyInstances[currentView];
    if (cy) {
        const png = cy.png({
            output: 'blob',
            bg: 'white',
            full: true
        });
        const link = document.createElement('a');
        link.download = `code-relationship-${currentView}.png`;
        link.href = URL.createObjectURL(png);
        link.click();
    }
}

function exportHTML(): void {
    const cy = cyInstances[currentView];
    if (cy && !window.IS_STANDALONE && vscode) {
        const nodes = cy.nodes().map((node: any) => ({ data: node.data() }));
        const edges = cy.edges().map((edge: any) => ({ data: edge.data() }));
        vscode.postMessage({
            type: 'exportHTML',
            data: { nodes, edges }
        });
    }
}

// Make functions available globally for HTML onclick handlers
(window as any).fitGraph = fitGraph;
(window as any).resetLayout = resetLayout;
(window as any).expandAll = expandAll;
(window as any).collapseAll = collapseAll;
(window as any).toggleOrientation = toggleOrientation;
(window as any).toggleDirectoryGroups = toggleDirectoryGroups;
(window as any).toggleExportMenu = toggleExportMenu;
(window as any).exportPNG = exportPNG;
(window as any).exportHTML = exportHTML;

// ========================================
// Initialize
// ========================================

// データが既にロード済みの場合（埋め込みデータ）のみ初期化
// postMessageでデータが送られる場合は、graphDataCompleteハンドラーで初期化される
if (isDataLoaded) {
    console.log('Initializing with embedded data...');
    (async () => {
        await initializeView('file-deps');
        updateProgress(100, 'Complete!');
    })();
} else {
    console.log('Waiting for data from extension...');
}
