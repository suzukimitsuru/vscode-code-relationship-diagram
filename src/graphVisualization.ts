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

        const elements = this.createGraphElements(symbols, references);
        
        this.panel.webview.html = this.generateWebviewContent(elements);
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
        #cy {
            width: 100%;
            height: 100vh;
            background-color: ${backgroundColor};
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
    <div class="controls">
        <button onclick="fitGraph()">Fit to Screen</button>
        <button onclick="resetLayout()">Reset Layout</button>
        <button onclick="exportPNG()">Export PNG</button>
    </div>
    <div id="cy"></div>
    
    <script>
        const cy = cytoscape({
            container: document.getElementById('cy'),
            elements: ${JSON.stringify([...elements.nodes, ...elements.edges])},
            
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

        function fitGraph() {
            cy.fit();
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