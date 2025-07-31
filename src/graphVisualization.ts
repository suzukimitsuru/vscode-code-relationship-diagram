import * as vscode from 'vscode';
import locale from './locale';
import * as SYMBOL from './symbol';
import * as codeReferences from './codeReferences';
import { Logs } from './logs';
import { title } from 'process';

export class GraphVisualization {
    private panel: vscode.WebviewPanel | null = null;
    private context: vscode.ExtensionContext;
    private logs: Logs;

    constructor(context: vscode.ExtensionContext, logs: Logs) {
        this.context = context;
        this.logs = logs;
    }

    public async showGraph(symbols: SYMBOL.SymbolModel[], references: codeReferences.Reference[]) {
        const startTime = performance.now();
        
        try {
            this.logs.log('[0.000s][  0.00%] Starting code relationship diagram generation...');
            this.logs.log(`[0.000s][  0.00%] Input: ${symbols.length} symbols, ${references.length} references`);
            
            // 入力データの詳細ログ
            if (symbols.length === 0) {
                this.logs.error('No symbols provided to showGraph - this may indicate a problem with data loading');
                return;
            }
            
            // 最初の数個のシンボルをログ出力
            for (let i = 0; i < Math.min(3, symbols.length); i++) {
                this.logs.log(`[0.000s][  0.00%] Symbol ${i + 1}: ${symbols[i].name} (${vscode.SymbolKind[symbols[i].kind]}) in ${symbols[i].path}`);
            }
        
        if (this.panel) {
            this.panel.dispose();
            const elapsed = (performance.now() - startTime) / 1000;
            this.logs.log(`${elapsed.toFixed(3)}s   5.00%: Disposed existing webview panel`);
        }

        try {
            this.panel = vscode.window.createWebviewPanel(
                'codeRelationshipDiagram',
                locale('window-title'),
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );
            const panelElapsed = (performance.now() - startTime) / 1000;
            this.logs.log(`${panelElapsed.toFixed(3)}s  10.00%: Created new webview panel`);
        } catch (panelError) {
            this.logs.error(`Failed to create webview panel: ${panelError instanceof Error ? panelError.message : panelError}`);
            console.error('Panel creation error:', panelError);
            return;
        }

        // 初期HTML（ローディング状態）を表示
        this.panel.webview.html = this.generateLoadingContent(locale('window-title'));
        const loadingElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${loadingElapsed.toFixed(3)}s  15.00%: Generated loading content`);
        
        // 進捗を段階的に更新
        await this.updateProgress(20, 'Processing symbols...');
        
        const elementsStartTime = performance.now();
        const elements = this.createGraphElements(symbols, references, startTime);
        const elementsEndTime = performance.now();
        const elementsElapsed = (elementsEndTime - startTime) / 1000;
        this.logs.log(`${elementsElapsed.toFixed(3)}s  60.00%: Created graph elements: ${elements.nodes.length} nodes, ${elements.edges.length} edges (${(elementsEndTime - elementsStartTime).toFixed(3)}ms)`);
        
        await this.updateProgress(50, 'Generating graph...');
        
        // 最終的なHTMLを設定
        const htmlStartTime = performance.now();
        this.panel.webview.html = this.generateWebviewContent(locale('window-title'), elements);
        const htmlEndTime = performance.now();
        const htmlElapsed = (htmlEndTime - startTime) / 1000;
        this.logs.log(`${htmlElapsed.toFixed(3)}s  90.00%: Generated webview content (${(htmlEndTime - htmlStartTime).toFixed(3)}ms)`);
        
            const totalTime = (performance.now() - startTime) / 1000;
            this.logs.log(`${totalTime.toFixed(3)}s 100.00%: Code relationship diagram generation completed in ${totalTime.toFixed(3)}s`);
        } catch (error) {
            const errorTime = (performance.now() - startTime) / 1000;
            this.logs.error(`${errorTime.toFixed(3)}s: Error during graph visualization: ${error instanceof Error ? error.message : error}`);
            console.error('ShowGraph detailed error:', error);
            
            // エラーが発生した場合でもパネルが残っていたら削除
            if (this.panel) {
                try {
                    this.panel.dispose();
                    this.panel = null;
                } catch (disposeError) {
                    console.error('Error disposing panel:', disposeError);
                }
            }
        }
    }
    
    private async updateProgress(percent: number, message: string): Promise<void> {
        if (this.panel) {
            try {
                await this.panel.webview.postMessage({
                    type: 'progress',
                    percent: percent,
                    message: message
                });
                // 短い待機でUI更新を確実にする
                await new Promise(resolve => setTimeout(resolve, 100));
                this.logs.log(`Progress updated: ${percent}% - ${message}`);
            } catch (progressError) {
                this.logs.error(`Failed to update progress: ${progressError instanceof Error ? progressError.message : progressError}`);
                console.error('Progress update error:', progressError);
            }
        } else {
            this.logs.error('Cannot update progress: panel is null');
        }
    }

    private createGraphElements(symbols: SYMBOL.SymbolModel[], references: codeReferences.Reference[], startTime: number) {
        const currentElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${currentElapsed.toFixed(3)}s  20.00%: Creating graph elements from symbols and references...`);
        const nodes: any[] = [];
        const edges: any[] = [];
        const fileNodes = new Map<string, any>();
        const fileRelations = new Map<string, number>();

        // ファイルノードのみを作成
        let fileSymbolCount = 0;
        symbols.forEach(symbol => {
            if (symbol.kind === vscode.SymbolKind.File) {
                fileSymbolCount++;
                const fileName = this.getSymbolLabel(symbol);
                const symbolCount = this.countSymbolsInFile(symbol);
                
                fileNodes.set(symbol.path, {
                    data: {
                        id: symbol.id,
                        label: fileName,
                        path: symbol.path,
                        symbolCount: symbolCount,
                        kind: symbol.kind
                    }
                });
            }
        });
        const nodesElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${nodesElapsed.toFixed(3)}s  30.00%: Created ${fileSymbolCount} file nodes from ${symbols.length} total symbols`);

        // ファイル間の関係を集約
        let processedReferences = 0;
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 35.00%] Starting to process ${references.length} references...`);
        
        references.forEach((ref, index) => {
            if (index < 5) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 35.${String(index + 1).padStart(2, '0')}%] Reference ${index + 1}: ${ref.fromPath} -> ${ref.toPath}`);
            }
            
            const relationKey = `${ref.fromPath}|||${ref.toPath}`;
            const reverseKey = `${ref.toPath}|||${ref.fromPath}`;
            
            // 双方向の関係を考慮して集約
            if (fileRelations.has(relationKey)) {
                fileRelations.set(relationKey, fileRelations.get(relationKey)! + 1);
            } else if (fileRelations.has(reverseKey)) {
                fileRelations.set(reverseKey, fileRelations.get(reverseKey)! + 1);
            } else {
                fileRelations.set(relationKey, 1);
            }
            processedReferences++;
        });
        const relationsElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${relationsElapsed.toFixed(3)}s  40.00%: Processed ${processedReferences} references into ${fileRelations.size} file relations`);

        // ノードを配列に追加
        nodes.push(...Array.from(fileNodes.values()));

        // ファイル間のエッジを生成
        let edgeCount = 0;
        const edgeDetails: Array<{from: string, to: string, count: number}> = [];
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 45.00%] Starting to generate edges from ${fileRelations.size} file relations...`);
        
        fileRelations.forEach((count, relationKey) => {
            const [fromPath, toPath] = relationKey.split('|||');
            if (edgeCount < 3) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 45.${String(edgeCount + 1).padStart(2, '0')}%] Processing relation: ${fromPath.split('/').pop()} -> ${toPath.split('/').pop()} (count: ${count})`);
            }
            
            const fromNode = Array.from(fileNodes.values()).find(node => node.data.path === fromPath);
            const toNode = Array.from(fileNodes.values()).find(node => node.data.path === toPath);
            
            if (fromNode && toNode) {
                edges.push({
                    data: {
                        id: `file-relation-${fromNode.data.id}-${toNode.data.id}`,
                        source: fromNode.data.id,
                        target: toNode.data.id,
                        referenceType: 'file-reference',
                        relationCount: count
                    }
                });
                edgeCount++;
                edgeDetails.push({
                    from: fromNode.data.label,
                    to: toNode.data.label,
                    count: count
                });
                const edgeElapsed = (performance.now() - startTime) / 1000;
                if (edgeCount <= 3) {
                    this.logs.log(`${edgeElapsed.toFixed(3)}s  47.${String(edgeCount).padStart(2, '0')}%: Created edge: ${fromNode.data.label} → ${toNode.data.label} (${count} relations)`);
                }
            } else {
                const skipElapsed = (performance.now() - startTime) / 1000;
                this.logs.log(`${skipElapsed.toFixed(3)}s  47.XX%: Skipped edge: ${fromPath.split('/').pop()} → ${toPath.split('/').pop()} (nodes not found)`);
                this.logs.log(`${skipElapsed.toFixed(3)}s  47.XX%: fromNode: ${fromNode ? 'found' : 'NOT FOUND'}, toNode: ${toNode ? 'found' : 'NOT FOUND'}`);
            }
        });
        const edgesElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${edgesElapsed.toFixed(3)}s  50.00%: Generated ${edgeCount} edges from ${fileRelations.size} file relations`);
        
        // 関係線の詳細情報をログ出力
        if (edgeDetails.length > 0) {
            this.logs.log(`${edgesElapsed.toFixed(3)}s  52.00%: Relationship details:`);
            
            // 関係数でソートして表示
            const sortedEdges = edgeDetails.sort((a, b) => b.count - a.count);
            sortedEdges.forEach((edge, index) => {
                const detailElapsed = (performance.now() - startTime) / 1000;
                this.logs.log(`${detailElapsed.toFixed(3)}s  52.${((index + 1) / sortedEdges.length * 100).toFixed(0).padStart(2, '0')}%:   ${edge.from} → ${edge.to}: ${edge.count} references`);
            });
            
            // 統計情報も出力
            const totalRelations = edgeDetails.reduce((sum, edge) => sum + edge.count, 0);
            const avgRelations = (totalRelations / edgeDetails.length).toFixed(2);
            const maxRelations = Math.max(...edgeDetails.map(e => e.count));
            const minRelations = Math.min(...edgeDetails.map(e => e.count));
            
            const statsElapsed = (performance.now() - startTime) / 1000;
            this.logs.log(`${statsElapsed.toFixed(3)}s  53.00%: Relations statistics: Total=${totalRelations}, Avg=${avgRelations}, Max=${maxRelations}, Min=${minRelations}`);
        }

        const totalSymbolCount = Array.from(fileNodes.values()).reduce((sum, node) => sum + node.data.symbolCount, 0);
        const summaryElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${summaryElapsed.toFixed(3)}s  58.00%: Graph summary: ${nodes.length} nodes, ${edges.length} edges, ${totalSymbolCount} total symbols`);

        return { nodes, edges };
    }

    private countSymbolsInFile(fileSymbol: SYMBOL.SymbolModel): number {
        let count = 0;
        const countRecursive = (symbol: SYMBOL.SymbolModel) => {
            count++;
            symbol.children.forEach(child => countRecursive(child));
        };
        fileSymbol.children.forEach(child => countRecursive(child));
        return count;
    }

    private getSymbolLabel(symbol: SYMBOL.SymbolModel): string {
        const fileName = symbol.path.split('/').pop() || symbol.path;
        return symbol.kind === vscode.SymbolKind.File ? fileName : symbol.name;
    }
    
    private generateLoadingContent(title: string): string {
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const backgroundColor = isDarkTheme ? '#1e1e1e' : '#ffffff';
        const controlsColor = isDarkTheme ? '#cccccc' : '#333333';
        
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${title} - Loading</title>
    <style>
        @font-face {
            font-family: 'codicon';
            src: url('data:application/font-woff2;charset=utf-8;base64,') format('woff2');
        }
        .codicon {
            font-family: 'codicon';
            font-weight: normal;
            font-style: normal;
            text-decoration: none;
            text-rendering: auto;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            user-select: none;
            -webkit-user-select: none;
            -ms-user-select: none;
        }
        .codicon-zoom-to-fit::before { content: "\\ea23"; }
        .codicon-refresh::before { content: "\\ea24"; }
        .codicon-save-as::before { content: "\\ea7c"; }
    </style>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            background-color: ${backgroundColor};
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
        }
        #progress-container {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background-color: ${isDarkTheme ? '#333' : '#e0e0e0'};
            z-index: 2000;
        }
        #progress-bar {
            height: 100%;
            background: linear-gradient(90deg, #007ACC, #4A90E2);
            width: 0%;
            transition: width 0.3s ease;
            border-radius: 0 2px 2px 0;
        }
        #progress-text {
            color: ${controlsColor};
            font-size: 16px;
            text-align: center;
        }
    </style>
</head>
<body>
    <div id="progress-container">
        <div id="progress-bar"></div>
    </div>
    <div id="progress-text">Initializing...</div>
    
    <script>
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');
        
        function updateProgress(percent, message) {
            progressBar.style.width = percent + '%';
            progressText.textContent = message;
        }
        
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'progress') {
                updateProgress(message.percent, message.message);
            }
        });
        
        updateProgress(5, 'Starting...');
    </script>
</body>
</html>`;
    }

    private generateWebviewContent(title: string, elements: { nodes: any[], edges: any[] }): string {
        // VSCodeのテーマ色を取得
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const backgroundColor = isDarkTheme ? '#1e1e1e' : '#ffffff';
        const controlsBackground = isDarkTheme ? '#2d2d30' : '#ffffff';
        const controlsColor = isDarkTheme ? '#cccccc' : '#333333';
        const buttonBackground = isDarkTheme ? '#0e639c' : '#007ACC';
        const buttonHoverBackground = isDarkTheme ? '#1177bb' : '#005A9E';
        const boxShadowColor = isDarkTheme ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)';
        
        // ローカルJSファイルのURIを生成
        const cytoscapeUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')
        );
        const cytoscapeDagreUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape-dagre', 'cytoscape-dagre.js')
        );
        
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
        @font-face {
            font-family: 'codicon';
            src: url('data:application/font-woff2;charset=utf-8;base64,') format('woff2');
        }
        .codicon {
            font-family: 'codicon';
            font-weight: normal;
            font-style: normal;
            text-decoration: none;
            text-rendering: auto;
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
            user-select: none;
            -webkit-user-select: none;
            -ms-user-select: none;
        }
        .codicon-zoom-to-fit::before { content: "\\ea23"; }
        .codicon-refresh::before { content: "\\ea24"; }
        .codicon-save-as::before { content: "\\ea7c"; }
    </style>
    <script src="${cytoscapeUri}"></script>
    <script src="${cytoscapeDagreUri}"></script>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
            background-color: ${backgroundColor};
        }
        #progress-container {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 4px;
            background-color: ${isDarkTheme ? '#333' : '#e0e0e0'};
            z-index: 2000;
            opacity: 1;
            transition: opacity 0.3s ease;
        }
        #progress-bar {
            height: 100%;
            background: linear-gradient(90deg, #007ACC, #4A90E2);
            width: 0%;
            transition: width 0.3s ease;
            border-radius: 0 2px 2px 0;
        }
        #progress-text {
            position: fixed;
            top: 8px;
            left: 10px;
            color: ${controlsColor};
            font-size: 12px;
            z-index: 2001;
            opacity: 1;
            transition: opacity 0.3s ease;
        }
        #cy {
            width: 100%;
            height: 100vh;
            background-color: ${backgroundColor};
            padding-top: 4px;
        }
        .controls {
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 1000;
            background: ${controlsBackground};
            color: ${controlsColor};
            padding: 10px;
            border-radius: 5px;
            box-shadow: 0 2px 4px ${boxShadowColor};
            border: ${isDarkTheme ? '1px solid #3e3e42' : '1px solid #e1e1e1'};
        }
        button {
            margin: 5px;
            padding: 8px 12px;
            border: none;
            border-radius: 3px;
            background: ${buttonBackground};
            color: white;
            cursor: pointer;
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 13px;
            min-width: auto;
        }
        button:hover {
            background: ${buttonHoverBackground};
        }
        button i.codicon {
            font-size: 16px;
            line-height: 1;
        }
        button span {
            font-weight: normal;
        }
    </style>
</head>
<body>
    <div id="progress-container">
        <div id="progress-bar"></div>
    </div>
    <div id="progress-text">Loading...</div>
    <div class="controls">
        <button onclick="fitGraph()" title="Fit to Screen">
            <i class="codicon codicon-zoom-to-fit"></i>
            <span>Fit to Screen</span>
        </button>
        <button onclick="resetLayout()" title="Reset Layout">
            <i class="codicon codicon-refresh"></i>
            <span>Reset Layout</span>
        </button>
        <button onclick="exportPNG()" title="Export PNG">
            <i class="codicon codicon-save-as"></i>
            <span>Export PNG</span>
        </button>
    </div>
    <div id="cy"></div>
    
    <script>
        // 進捗表示の管理
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');
        const progressContainer = document.getElementById('progress-container');
        
        function updateProgress(percent, message) {
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
        
        // 初期進捗表示
        updateProgress(10, 'Initializing graph...');
        console.log('Initializing Cytoscape.js with', ${elements.nodes.length}, 'nodes and', ${elements.edges.length}, 'edges');
        
        const cy = cytoscape({
            container: document.getElementById('cy'),
            elements: ${JSON.stringify([...elements.nodes, ...elements.edges])},
            
            // ズーム制限を設定
            minZoom: 0.1,
            maxZoom: 3.0,
            wheelSensitivity: 0.2,
            
            // Compound graphsを有効にする
            // これにより親子関係のあるノードがグループ化される
            style: [
                {
                    selector: 'node',
                    style: {
                        'background-color': '#4A90E2',
                        'label': 'data(label)',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'color': '#fff',
                        'font-size': '14px',
                        'font-weight': 'bold',
                        'shape': 'rectangle',
                        'width': function( ele ) {
                            // ファイル名の長さとシンボル数に応じてサイズ調整（余裕を持たせる）
                            const labelLength = ele.data('label').length;
                            const symbolCount = ele.data('symbolCount') || 1;
                            return Math.max(140, labelLength * 9 + symbolCount * 3) + 'px';
                        },
                        'height': function( ele ) {
                            const symbolCount = ele.data('symbolCount') || 1;
                            return Math.max(70, 50 + symbolCount * 3) + 'px';
                        },
                        'text-wrap': 'wrap',
                        'text-max-width': function( ele ) {
                            const labelLength = ele.data('label').length;
                            return Math.max(100, labelLength * 8) + 'px';
                        },
                        'border-width': '2px',
                        'border-color': '#2E5984',
                        'background-opacity': 0.9
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': function( ele ) {
                            // 関係の多さに応じて線の太さを調整 (1-10の範囲)
                            const relationCount = ele.data('relationCount') || 1;
                            return Math.min(Math.max(relationCount * 0.8, 1), 10);
                        },
                        'line-color': function( ele ) {
                            // 関係の多さに応じて色の濃さを調整
                            const relationCount = ele.data('relationCount') || 1;
                            const intensity = Math.min(relationCount / 10, 1);
                            const red = Math.floor(71 + (231 - 71) * intensity);
                            const green = Math.floor(144 + (76 - 144) * intensity);
                            const blue = Math.floor(226 + (60 - 226) * intensity);
                            return \`rgb(\${red}, \${green}, \${blue})\`;
                        },
                        'target-arrow-color': function( ele ) {
                            const relationCount = ele.data('relationCount') || 1;
                            const intensity = Math.min(relationCount / 10, 1);
                            const red = Math.floor(71 + (231 - 71) * intensity);
                            const green = Math.floor(144 + (76 - 144) * intensity);
                            const blue = Math.floor(226 + (60 - 226) * intensity);
                            return \`rgb(\${red}, \${green}, \${blue})\`;
                        },
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier',
                        'opacity': function( ele ) {
                            const relationCount = ele.data('relationCount') || 1;
                            return Math.min(0.6 + relationCount * 0.04, 1.0);
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
                nodeRepulsion: function( node ) {
                    // シンボル数が多いファイルほど強い反発力（大幅に増加）
                    const symbolCount = node.data('symbolCount') || 1;
                    return 150000 + symbolCount * 8000;
                },
                nodeOverlap: 100,
                idealEdgeLength: function( edge ) {
                    // 関係の多さに応じてエッジ長を調整（最小値を大きく）
                    const relationCount = edge.data('relationCount') || 1;
                    return Math.max(250, 450 - relationCount * 15);
                },
                edgeElasticity: function( edge ) {
                    // 関係が多いほど強い結合力
                    const relationCount = edge.data('relationCount') || 1;
                    return 80 + relationCount * 15;
                },
                gravity: 25,
                numIter: 2000,
                initialTemp: 400,
                coolingFactor: 0.92,
                minTemp: 1.0,
                avoidOverlap: true,
                randomize: false,
                componentSpacing: 150,
                boundingBox: undefined
            }
        });
        
        // レイアウト開始時とレイアウト完了時の進捗表示
        cy.on('layoutstart', function() {
            updateProgress(60, 'Arranging nodes...');
            console.log('Layout started - arranging nodes...');
        });
        
        cy.on('layoutstop', function() {
            updateProgress(100, 'Complete!');
            console.log('Layout completed - graph rendering finished');
            // レイアウト完了後に自動的にfitし、最小ズームを設定
            setTimeout(() => {
                fitGraph();
                console.log('Applied fit and zoom constraints');
            }, 100);
        });
        
        // グラフ初期化完了
        updateProgress(40, 'Loading graph elements...');

        function fitGraph() {
            cy.fit();
            // Fit後のズームレベルを取得して、それを最小ズームとして設定
            const fitZoom = cy.zoom();
            cy.minZoom(Math.max(fitZoom * 0.8, 0.1)); // Fitレベルの80%まで縮小を許可
        }

        function resetLayout() {
            const layout = cy.layout({
                name: 'cose',
                animate: true,
                animationDuration: 1500,
                fit: true,
                padding: 120,
                nodeRepulsion: function( node ) {
                    const symbolCount = node.data('symbolCount') || 1;
                    return 150000 + symbolCount * 8000;
                },
                nodeOverlap: 100,
                idealEdgeLength: function( edge ) {
                    const relationCount = edge.data('relationCount') || 1;
                    return Math.max(250, 450 - relationCount * 15);
                },
                edgeElasticity: function( edge ) {
                    const relationCount = edge.data('relationCount') || 1;
                    return 80 + relationCount * 15;
                },
                gravity: 25,
                numIter: 2000,
                initialTemp: 400,
                coolingFactor: 0.92,
                minTemp: 1.0,
                avoidOverlap: true,
                randomize: false,
                componentSpacing: 150,
                boundingBox: undefined
            });
            layout.run();
            
            // レイアウト完了後にfitして最小ズームを更新
            layout.on('layoutstop', function() {
                setTimeout(() => {
                    fitGraph();
                }, 100);
            });
        }

        function exportPNG() {
            const png = cy.png({
                output: 'blob',
                bg: 'white',
                full: true
            });
            const link = document.createElement('a');
            link.download = 'code-relationship-diagram.png';
            link.href = URL.createObjectURL(png);
            link.click();
        }

        cy.on('tap', 'node', function(evt) {
            const node = evt.target;
            console.log('Node clicked:', node.data());
        });
    </script>
</body>
</html>`;
    }

    public dispose() {
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
    }
}