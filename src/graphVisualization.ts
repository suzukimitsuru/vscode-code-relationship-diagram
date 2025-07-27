import * as vscode from 'vscode';
import * as SYMBOL from './symbol';
import * as codeReferences from './codeReferences';

export class GraphVisualization {
    private panel: vscode.WebviewPanel | null = null;

    constructor() {
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

        const addSymbolNodes = (symbol: SYMBOL.SymbolModel) => {
            nodes.push({
                data: {
                    id: symbol.id,
                    label: this.getSymbolLabel(symbol),
                    kind: symbol.kind,
                    path: symbol.path
                }
            });

            for (const child of symbol.children) {
                addSymbolNodes(child);
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
        const kindName = vscode.SymbolKind[symbol.kind];
        const fileName = symbol.path.split('/').pop() || symbol.path;
        return symbol.kind === vscode.SymbolKind.File ? fileName : `${kindName}`;
    }

    private generateWebviewContent(elements: { nodes: any[], edges: any[] }): string {
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>Code Relationship Diagram</title>
    <script src="https://unpkg.com/cytoscape@3.30.3/dist/cytoscape.min.js"></script>
    <style>
        body {
            margin: 0;
            padding: 0;
            font-family: Arial, sans-serif;
        }
        #cy {
            width: 100%;
            height: 100vh;
            background-color: #fafafa;
        }
        .controls {
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 1000;
            background: white;
            padding: 10px;
            border-radius: 5px;
            box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        }
        button {
            margin: 5px;
            padding: 8px 12px;
            border: none;
            border-radius: 3px;
            background: #007ACC;
            color: white;
            cursor: pointer;
        }
        button:hover {
            background: #005A9E;
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
            style: [
                {
                    selector: 'node',
                    style: {
                        'background-color': '#666',
                        'label': 'data(label)',
                        'text-valign': 'center',
                        'text-halign': 'center',
                        'color': '#fff',
                        'font-size': '12px',
                        'width': '60px',
                        'height': '60px'
                    }
                },
                {
                    selector: 'node[kind="1"]',
                    style: {
                        'background-color': '#4A90E2',
                        'shape': 'rectangle'
                    }
                },
                {
                    selector: 'node[kind="6"]',
                    style: {
                        'background-color': '#7ED321',
                        'shape': 'ellipse'
                    }
                },
                {
                    selector: 'node[kind="13"]',
                    style: {
                        'background-color': '#F5A623',
                        'shape': 'diamond'
                    }
                },
                {
                    selector: 'node[kind="5"]',
                    style: {
                        'background-color': '#D0021B',
                        'shape': 'hexagon'
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
                }
            ],
            layout: {
                name: 'cose',
                animate: true,
                animationDuration: 1000,
                nodeRepulsion: 10000,
                idealEdgeLength: 100,
                edgeElasticity: 100
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
                nodeRepulsion: 10000,
                idealEdgeLength: 100,
                edgeElasticity: 100
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