/**
 * @file Code Relationship Diagram - Multi View Graph Script
 * @description Webview script for displaying multi-view code relationship diagrams
 */

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
        r = parseInt(color.substr(1, 2), 16);
        g = parseInt(color.substr(3, 2), 16);
        b = parseInt(color.substr(5, 2), 16);
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
// Global State
// ========================================

let currentView: string = 'file-deps';
let cyInstances: Record<string, any> = {};
let callGraphOrientation: string = 'TB'; // TB (Top-Bottom) or LR (Left-Right)

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

// VSCode Extension からのメッセージ受信
window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'progress') {
        updateProgress(message.percent, message.message);
    }
});

// ========================================
// Data Preparation
// ========================================

updateProgress(10, 'Initializing graph...');
console.log('Initializing Multi-View with', window.GRAPH_NODES_COUNT, 'nodes and', window.GRAPH_EDGES_COUNT, 'edges');

const allElements = window.GRAPH_ELEMENTS;
const allNodes = allElements.filter(el => !el.data.source);
const allEdges = allElements.filter(el => el.data.source);

console.log('Total elements:', allElements.length);
console.log('Total nodes:', allNodes.length);
console.log('Total edges:', allEdges.length);
console.log('Sample node:', allNodes[0]);
console.log('Sample edge:', allEdges[0]);

if (allNodes.length > 0) {
    const fileNodes = allNodes.filter(n => n.data.kind === 0);
    const symbolNodes = allNodes.filter(n => n.data.kind !== 0);
    console.log('File nodes:', fileNodes.length);
    console.log('Symbol nodes:', symbolNodes.length);
    console.log('Sample file node:', fileNodes[0]);
    console.log('Sample symbol node:', symbolNodes[0]);
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
        initializeView(viewName);
    } else {
        // 既存のビューをリフレッシュ
        cyInstances[viewName].resize();
        cyInstances[viewName].fit();
    }
}

function initializeView(viewName: string): void {
    console.log('Initializing view:', viewName);
    updateProgress(30 + (viewName === 'file-deps' ? 0 : 20), `Initializing ${viewName} view...`);

    try {
        switch (viewName) {
            case 'file-deps':
                initFileDepView();
                break;
            case 'hierarchy':
                initHierarchyView();
                break;
            case 'call-graph':
                initCallGraphView();
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
        const fileNodes = allNodes.filter(node => node.data.kind === 0);
        const fileEdges = allEdges.filter(edge => edge.data.relationshipType === 'file-relationship');

        console.log('initFileDepView - File nodes:', fileNodes.length);
        console.log('initFileDepView - File edges:', fileEdges.length);

        if (fileNodes.length === 0) {
            console.error('initFileDepView - ERROR: No file nodes found!');
            return;
        }

        cyInstances['file-deps'] = cytoscape({
            container: document.getElementById('cy-file-deps'),
            elements: [...fileNodes, ...fileEdges],
            style: [
                {
                    selector: 'node',
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
        updateProgress(60, 'File dependency view initialized');
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

function initHierarchyView(): void {
    try {
        console.log('=== initHierarchyView START ===');
        const hierarchyElements = createHierarchyElements();

        console.log('initHierarchyView - Hierarchy elements:', hierarchyElements.length);

        if (hierarchyElements.length === 0) {
            console.error('initHierarchyView - ERROR: No elements found!');
            return;
        }

        cyInstances['hierarchy'] = cytoscape({
            container: document.getElementById('cy-hierarchy'),
            elements: hierarchyElements,
            style: [
                {
                    selector: 'node[kind=0]',
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
                    selector: 'node[kind!=0]',
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
                        'width': 2,
                        'line-color': '#7F8C8D',
                        'target-arrow-color': '#7F8C8D',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier'
                    }
                }
            ],
            layout: {
                name: 'dagre',
                rankDir: 'TB',
                nodeSep: 50,
                rankSep: 100,
                animate: true,
                animationDuration: 1000
            }
        });

        setupCommonEventHandlers('hierarchy');
        updateProgress(70, 'Hierarchy view initialized');
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

    let nodesWithParent = 0;
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

            if (node.data.parent) {
                element.data.parent = node.data.parent;
                nodesWithParent++;
            }

            elements.push(element);
            processedIds.add(node.data.id);
        }
    });

    console.log('createHierarchyElements - Nodes with parent:', nodesWithParent);

    let symbolEdgeCount = 0;
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

    console.log('createHierarchyElements - Symbol edges:', symbolEdgeCount);
    console.log('createHierarchyElements - Total elements:', elements.length);

    return elements;
}

// ========================================
// View 3: Call Graph
// ========================================

function initCallGraphView(): void {
    try {
        console.log('=== initCallGraphView START ===');
        const symbolNodes = allNodes.filter(node => node.data.kind !== 0);
        const symbolEdges = allEdges.filter(edge => edge.data.relationshipType !== 'file-relationship');

        console.log('initCallGraphView - Symbol nodes:', symbolNodes.length);
        console.log('initCallGraphView - Symbol edges:', symbolEdges.length);

        if (symbolNodes.length === 0) {
            console.error('initCallGraphView - ERROR: No symbol nodes found!');
            return;
        }

        cyInstances['call-graph'] = cytoscape({
            container: document.getElementById('cy-call-graph'),
            elements: [...symbolNodes, ...symbolEdges],
            style: [
                {
                    selector: 'node',
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
                name: 'dagre',
                rankDir: callGraphOrientation,
                nodeSep: 40,
                rankSep: 80,
                animate: true,
                animationDuration: 1000
            }
        });

        setupCommonEventHandlers('call-graph');
        updateProgress(80, 'Call graph view initialized');
        console.log('=== initCallGraphView COMPLETE ===');
    } catch (error) {
        console.error('initCallGraphView - ERROR:', error);
        if (error instanceof Error) {
            console.error('Error stack:', error.stack);
        }
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

// ========================================
// Export Functions
// ========================================

function toggleExportMenu(): void {
    const menu = document.getElementById('export-menu');
    if (menu) {
        menu.classList.toggle('show');
        if (menu.classList.contains('show')) {
            setTimeout(() => {
                document.addEventListener('click', closeExportMenuOnOutsideClick, true);
            }, 0);
        } else {
            document.removeEventListener('click', closeExportMenuOnOutsideClick, true);
        }
    }
}

function closeExportMenu(): void {
    const menu = document.getElementById('export-menu');
    if (menu) {
        menu.classList.remove('show');
        document.removeEventListener('click', closeExportMenuOnOutsideClick, true);
    }
}

function closeExportMenuOnOutsideClick(event: Event): void {
    const dropdown = document.querySelector('.export-dropdown');
    const menu = document.getElementById('export-menu');
    if (dropdown && menu && !dropdown.contains(event.target as Node)) {
        closeExportMenu();
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
(window as any).toggleExportMenu = toggleExportMenu;
(window as any).exportPNG = exportPNG;
(window as any).exportHTML = exportHTML;

// ========================================
// Initialize
// ========================================

initializeView('file-deps');
updateProgress(100, 'Complete!');
