import * as vscode from 'vscode';
import * as SYMBOL from './symbol';
import * as codeReferences from './codeReferences';

export class GraphVisualization {
    private panel: vscode.WebviewPanel | null = null;
    private context: vscode.ExtensionContext;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
    }

    public async showGraph(symbols: SYMBOL.SymbolModel[], references: codeReferences.SymbolReference[]) {
        if (this.panel) {
            this.panel.dispose();
        }

        this.panel = vscode.window.createWebviewPanel(
            'codeRelationshipDiagram',
            'Code Relationship Diagram',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        // 初期HTML（ローディング状態）を表示
        this.panel.webview.html = this.generateLoadingContent();
        
        // 進捗を段階的に更新
        await this.updateProgress(20, 'Processing symbols...');
        
        const elements = this.createGraphElements(symbols, references);
        
        await this.updateProgress(50, 'Generating graph...');
        
        // 最終的なHTMLを設定
        this.panel.webview.html = this.generateWebviewContent(elements);
    }
    
    private async updateProgress(percent: number, message: string): Promise<void> {
        if (this.panel) {
            await this.panel.webview.postMessage({
                type: 'progress',
                percent: percent,
                message: message
            });
            // 短い待機でUI更新を確実にする
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }

    private createGraphElements(symbols: SYMBOL.SymbolModel[], references: codeReferences.SymbolReference[]) {
        const nodes: any[] = [];
        const edges: any[] = [];

        const addSymbolNodes = (symbol: SYMBOL.SymbolModel, depth: number = 0) => {
            nodes.push({
                data: {
                    id: symbol.id,
                    label: this.getSymbolLabel(symbol),
                    kind: symbol.kind,
                    path: symbol.path,
                    depth: depth
                }
            });

            for (const child of symbol.children) {
                addSymbolNodes(child, depth + 1);
                edges.push({
                    data: {
                        id: `${symbol.id}-${child.id}`,
                        source: symbol.id,
                        target: child.id,
                        referenceType: 'contains'
                    }
                });
            }
        };

        symbols.forEach(symbol => addSymbolNodes(symbol));

        references.forEach(ref => {
            edges.push({
                data: {
                    id: ref.id,
                    source: ref.fromSymbolId,
                    target: ref.toSymbolId,
                    referenceType: ref.referenceType
                }
            });
        });

        return { nodes, edges };
    }

    private getSymbolLabel(symbol: SYMBOL.SymbolModel): string {
        const fileName = symbol.path.split('/').pop() || symbol.path;
        return symbol.kind === vscode.SymbolKind.File ? fileName : symbol.name;
    }
    
    private generateLoadingContent(): string {
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const backgroundColor = isDarkTheme ? '#1e1e1e' : '#ffffff';
        const controlsColor = isDarkTheme ? '#cccccc' : '#333333';
        
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Code Relationship Diagram - Loading</title>
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

    private generateWebviewContent(elements: { nodes: any[], edges: any[] }): string {
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
    <title>Code Relationship Diagram</title>
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
        }
        button:hover {
            background: ${buttonHoverBackground};
        }
    </style>
</head>
<body>
    <div id="progress-container">
        <div id="progress-bar"></div>
    </div>
    <div id="progress-text">Loading...</div>
    <div class="controls">
        <button onclick="fitGraph()">Fit to Screen</button>
        <button onclick="resetLayout()">Reset Layout</button>
        <button onclick="exportPNG()">Export PNG</button>
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
                        'background-color': '#666',
                        'label': 'data(label)',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'color': '#fff',
                        'font-size': '10px',
                        'width': '80px',
                        'height': '40px',
                        'text-wrap': 'wrap',
                        'text-max-width': '70px'
                    }
                },
                {
                    selector: 'node[kind="1"]',
                    style: {
                        'background-color': '#4A90E2',
                        'shape': 'rectangle',
                        'width': '200px',
                        'height': '150px',
                        'text-valign': 'top',
                        'text-halign': 'center',
                        'padding': '20px',
                        'border-width': '2px',
                        'border-color': '#2E5984',
                        'background-opacity': 0.2,
                        'font-size': '12px',
                        'font-weight': 'bold'
                    }
                },
                {
                    selector: 'node[kind="6"]',
                    style: {
                        'background-color': '#7ED321',
                        'shape': 'ellipse',
                        'width': '100px',
                        'height': '50px'
                    }
                },
                {
                    selector: 'node[kind="13"]',
                    style: {
                        'background-color': '#F5A623',
                        'shape': 'rectangle',
                        'width': '90px',
                        'height': '45px'
                    }
                },
                {
                    selector: 'node[kind="5"]',
                    style: {
                        'background-color': '#D0021B',
                        'shape': 'rectangle',
                        'width': '85px',
                        'height': '40px'
                    }
                },
                {
                    selector: 'node[kind="12"]',
                    style: {
                        'background-color': '#9013FE',
                        'shape': 'rectangle',
                        'width': '75px',
                        'height': '35px'
                    }
                },
                {
                    selector: 'node[depth="0"]',
                    style: {
                        'border-width': '3px',
                        'border-color': '#000'
                    }
                },
                {
                    selector: 'node[depth="1"]',
                    style: {
                        'border-width': '2px',
                        'border-color': '#333'
                    }
                },
                {
                    selector: 'node[depth="2"]',
                    style: {
                        'border-width': '1px',
                        'border-color': '#666'
                    }
                },
                {
                    selector: 'edge',
                    style: {
                        'width': 2,
                        'line-color': '#ccc',
                        'target-arrow-color': '#ccc',
                        'target-arrow-shape': 'triangle',
                        'curve-style': 'bezier'
                    }
                },
                {
                    selector: 'edge[referenceType="reference"]',
                    style: {
                        'line-color': '#E74C3C',
                        'target-arrow-color': '#E74C3C'
                    }
                },
                {
                    selector: 'edge[referenceType="contains"]',
                    style: {
                        'line-color': '#4A90E2',
                        'target-arrow-color': '#4A90E2',
                        'line-style': 'solid',
                        'width': 4,
                        'opacity': 0.9,
                        'curve-style': 'straight'
                    }
                }
            ],
            layout: {
                name: 'cose',
                animate: true,
                animationDuration: 1000,
                fit: true,
                padding: 50,
                nodeRepulsion: function( node ) {
                    // ファイルノードは強い反発力で分散配置
                    return node.data('depth') === 0 ? 80000 : 40000;
                },
                nodeOverlap: 40,
                idealEdgeLength: function( edge ) {
                    // containsエッジ（階層関係）は短く、referenceエッジは長く
                    return edge.data('referenceType') === 'contains' ? 60 : 250;
                },
                edgeElasticity: function( edge ) {
                    // containsエッジの方が強い結合力
                    return edge.data('referenceType') === 'contains' ? 500 : 50;
                },
                gravity: 30,
                numIter: 1000,
                initialTemp: 200,
                coolingFactor: 0.95,
                minTemp: 1.0,
                avoidOverlap: true,
                randomize: false
            }
        });
        
        // レイアウト開始時とレイアウト完了時の進捗表示
        cy.on('layoutstart', function() {
            updateProgress(60, 'Arranging nodes...');
        });
        
        cy.on('layoutstop', function() {
            updateProgress(100, 'Complete!');
            // レイアウト完了後に自動的にfitし、最小ズームを設定
            setTimeout(() => {
                fitGraph();
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
                animationDuration: 1000,
                fit: true,
                padding: 50,
                nodeRepulsion: function( node ) {
                    return node.data('depth') === 0 ? 80000 : 40000;
                },
                nodeOverlap: 40,
                idealEdgeLength: function( edge ) {
                    return edge.data('referenceType') === 'contains' ? 60 : 250;
                },
                edgeElasticity: function( edge ) {
                    return edge.data('referenceType') === 'contains' ? 500 : 50;
                },
                gravity: 30,
                numIter: 1000,
                initialTemp: 200,
                coolingFactor: 0.95,
                minTemp: 1.0,
                avoidOverlap: true,
                randomize: false
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