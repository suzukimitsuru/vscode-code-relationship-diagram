import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import * as SYMBOL from './symbol';
import * as codeReferences from './codeReferences';
import { Logs } from './logs';

export class GraphVisualization {
    private panel: vscode.WebviewPanel | null = null;
    private context: vscode.ExtensionContext;
    private rootFolder: vscode.WorkspaceFolder;
    private logs: Logs;

    constructor(context: vscode.ExtensionContext, rootFolder: vscode.WorkspaceFolder, logs: Logs) {
        this.context = context;
        this.rootFolder = rootFolder;
        this.logs = logs;
    }

    public async showDiagram(symbols: SYMBOL.SymbolModel[], references: codeReferences.Reference[]) {
        const startTime = performance.now();
        
        try {
            this.logs.log('[0.000s][  0.00%] Starting code relationship diagram generation...');
            this.logs.log(`[0.000s][  0.00%] Input: ${symbols.length} symbols, ${references.length} references`);
            
            // 入力データの詳細ログ
            if (symbols.length === 0) {
                this.logs.error('No symbols provided to showDiagram - this may indicate a problem with data loading');
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

            // Webviewからのメッセージを受信
            this.panel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.type) {
                        case 'openFile':
                            try {
                                // 相対パスを絶対パスに変換
                                const absolutePath = vscode.Uri.joinPath(this.rootFolder.uri, message.path);

                                // ファイルを開く
                                const document = await vscode.workspace.openTextDocument(absolutePath);
                                await vscode.window.showTextDocument(document);

                                this.logs.log(`Opened file: ${message.path}`);
                            } catch (error) {
                                this.logs.error(`Failed to open file ${message.path}: ${error instanceof Error ? error.message : error}`);
                            }
                            break;
                        case 'exportHTML':
                            try {
                                await this.exportStandaloneHTML(message.data);
                                this.logs.log('HTML exported successfully');
                            } catch (error) {
                                this.logs.error(`Failed to export HTML: ${error instanceof Error ? error.message : error}`);
                            }
                            break;
                    }
                },
                undefined,
                this.context.subscriptions
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
        this.panel.webview.html = this.generateWebviewContent(locale('window-title'), this.panel.webview, elements);
        const htmlEndTime = performance.now();
        const htmlElapsed = (htmlEndTime - startTime) / 1000;
        this.logs.log(`${htmlElapsed.toFixed(3)}s  90.00%: Generated webview content (${(htmlEndTime - htmlStartTime).toFixed(3)}ms)`);
        
            const totalTime = (performance.now() - startTime) / 1000;
            this.logs.log(`${totalTime.toFixed(3)}s 100.00%: Code relationship diagram generation completed in ${totalTime.toFixed(3)}s`);
        } catch (error) {
            const errorTime = (performance.now() - startTime) / 1000;
            this.logs.error(`${errorTime.toFixed(3)}s: Error during graph visualization: ${error instanceof Error ? error.message : error}`);
            console.error('showDiagram detailed error:', error);
            
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
        const fileRelationDetails = new Map<string, Array<{
            fromSymbolName: string;
            toSymbolName: string;
            fromLine: number;
            toLine: number;
            fromPath: string;
            toPath: string;
        }>>();

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

        // シンボルIDのインデックスを作成してパフォーマンスを向上
        const symbolIndex = new Map<string, SYMBOL.SymbolModel>();
        symbols.forEach((symbol, index) => {
            symbolIndex.set(symbol.id, symbol);
            // 最初の5つのシンボルIDをデバッグ出力
            if (index < 5) {
                this.logs.log(`Symbol ${index}: id=${symbol.id}, name=${symbol.name}, kind=${symbol.kind}, path=${symbol.path}`);
            }
        });
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 34.50%] Created symbol index with ${symbolIndex.size} entries`);

        // ファイル間の関係を集約
        let processedReferences = 0;
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 35.00%] Starting to process ${references.length} references...`);

        references.forEach((ref, index) => {
            if (index < 5) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 35.${String(index + 1).padStart(2, '0')}%] Reference ${index + 1}: ${ref.from.path} -> ${ref.to.path}`);
            }

            const relationKey = `${ref.from.path}|||${ref.to.path}`;
            const reverseKey = `${ref.to.path}|||${ref.from.path}`;

            // 詳細情報を作成 - インデックスを使用して高速検索
            const fromSymbol = symbolIndex.get(ref.from.id);
            const toSymbol = symbolIndex.get(ref.to.id);

            // デバッグ用のログ出力（最初の数個のみ）
            if (index < 3) {
                console.log(`Debug ref ${index}: from.id=${ref.from.id}, to.id=${ref.to.id}`);
                console.log(`Debug symbols sample:`, symbols.slice(0, 2).map(s => ({id: s.id, name: s.name})));
                console.log(`Found fromSymbol: ${fromSymbol ? fromSymbol.name : 'NOT FOUND'}`);
                console.log(`Found toSymbol: ${toSymbol ? toSymbol.name : 'NOT FOUND'}`);

                // さらに詳細なデバッグ
                this.logs.log(`Debug ref ${index}: from.id=${ref.from.id}, to.id=${ref.to.id}`);
                this.logs.log(`Debug symbols total count: ${symbols.length}`);
                this.logs.log(`Found fromSymbol: ${fromSymbol ? fromSymbol.name : 'NOT FOUND'}`);
                this.logs.log(`Found toSymbol: ${toSymbol ? toSymbol.name : 'NOT FOUND'}`);
            }

            const detailInfo = {
                fromSymbolName: fromSymbol?.name || 'Unknown',
                toSymbolName: toSymbol?.name || 'Unknown',
                fromLine: ref.from.startLine,
                toLine: ref.to.startLine,
                fromPath: ref.from.path,
                toPath: ref.to.path
            };

            // 双方向の関係を考慮して集約
            let actualKey = relationKey;
            if (fileRelations.has(relationKey)) {
                fileRelations.set(relationKey, fileRelations.get(relationKey)! + 1);
            } else if (fileRelations.has(reverseKey)) {
                fileRelations.set(reverseKey, fileRelations.get(reverseKey)! + 1);
                actualKey = reverseKey;
            } else {
                fileRelations.set(relationKey, 1);
            }

            // 詳細情報を追加
            if (!fileRelationDetails.has(actualKey)) {
                fileRelationDetails.set(actualKey, []);
            }
            fileRelationDetails.get(actualKey)!.push(detailInfo);

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
                this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 45.${String(edgeCount + 1).padStart(2, '0')}%] Processing relation: ${path.basename(fromPath)} -> ${path.basename(toPath)} (count: ${count})`);
            }
            
            const fromNode = Array.from(fileNodes.values()).find(node => node.data.path === fromPath);
            const toNode = Array.from(fileNodes.values()).find(node => node.data.path === toPath);
            
            if (fromNode && toNode) {
                const relationDetails = fileRelationDetails.get(relationKey) || [];
                edges.push({
                    data: {
                        id: `file-relation-${fromNode.data.id}-${toNode.data.id}`,
                        source: fromNode.data.id,
                        target: toNode.data.id,
                        referenceType: 'file-reference',
                        relationCount: count,
                        relationDetails: relationDetails
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
                this.logs.log(`${skipElapsed.toFixed(3)}s  47.XX%: Skipped edge: ${path.basename(fromPath)} → ${path.basename(toPath)} (nodes not found)`);
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
        return symbol.kind === vscode.SymbolKind.File ? path.basename(symbol.path) : symbol.name;
    }

    private loadHtmlTemplate(): string {
        const templatePath = path.join(this.context.extensionPath, 'src', 'templates', 'graph.html');
        try {
            return fs.readFileSync(templatePath, 'utf8');
        } catch (error) {
            this.logs.log(`Error loading HTML template: ${error}`);
            // フォールバック用の最小HTML
            return `<!DOCTYPE html><html><head><title>Error</title></head><body>Template not found</body></html>`;
        }
    }

    private replaceTemplatePlaceholders(template: string, elements: any): string {
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const backgroundColor = isDarkTheme ? '#1e1e1e' : '#ffffff';
        const controlsColor = isDarkTheme ? '#cccccc' : '#333333';
        const controlsBackground = isDarkTheme ? '#2d2d30' : '#f3f3f3';
        const boxShadowColor = isDarkTheme ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)';
        const buttonBackground = isDarkTheme ? '#0e639c' : '#007ACC';
        const buttonHoverBackground = isDarkTheme ? '#1177bb' : '#005a9e';
        const progressBgColor = isDarkTheme ? '#333' : '#e0e0e0';
        const borderStyle = isDarkTheme ? '1px solid #3e3e42' : '1px solid #e1e1e1';

        const cytoscapeUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')
        );
        const cytoscapeDagreUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape-dagre', 'cytoscape-dagre.js')
        );
        const codiconsUri = this.panel!.webview.asWebviewUri(
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css')
        );

        const replacements: { [key: string]: string } = {
            'TITLE_PLACEHOLDER': 'Code Relationship Diagram',
            'BACKGROUND_COLOR_PLACEHOLDER': backgroundColor,
            'CONTROLS_COLOR_PLACEHOLDER': controlsColor,
            'CONTROLS_BG_PLACEHOLDER': controlsBackground,
            'BOX_SHADOW_COLOR_PLACEHOLDER': boxShadowColor,
            'BUTTON_BG_PLACEHOLDER': buttonBackground,
            'BUTTON_HOVER_BG_PLACEHOLDER': buttonHoverBackground,
            'PROGRESS_BG_COLOR_PLACEHOLDER': progressBgColor,
            'BORDER_STYLE_PLACEHOLDER': borderStyle,
            'CODICONS_CSS_URI_PLACEHOLDER': codiconsUri.toString(),
            'CYTOSCAPE_URI_PLACEHOLDER': cytoscapeUri.toString(),
            'CYTOSCAPE_DAGRE_URI_PLACEHOLDER': cytoscapeDagreUri.toString(),
            'ELEMENTS_PLACEHOLDER': JSON.stringify([...elements.nodes, ...elements.edges]),
            'ELEMENTS_NODES_LENGTH_PLACEHOLDER': elements.nodes.length.toString(),
            'ELEMENTS_EDGES_LENGTH_PLACEHOLDER': elements.edges.length.toString()
        };

        let result = template;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }

        return result;
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

    private generateWebviewContent(title: string, webview: vscode.Webview | null, elements: { nodes: any[], edges: any[] }, isStandalone: boolean = false): string {
        // VSCodeのテーマ色を取得
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const backgroundColor = isDarkTheme ? '#1e1e1e' : '#ffffff';
        const controlsBackground = isDarkTheme ? '#2d2d30' : '#ffffff';
        const controlsColor = isDarkTheme ? '#cccccc' : '#333333';
        const buttonBackground = isDarkTheme ? '#0e639c' : '#007ACC';
        const buttonHoverBackground = isDarkTheme ? '#1177bb' : '#005A9E';
        const boxShadowColor = isDarkTheme ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)';
        
        // リソースURIの設定（スタンドアロン版とVSCode版で分ける）
        let codiconCssUri: string, codiconFontUri: string, cytoscapeUri: string, cytoscapeDagreUri: string;

        if (isStandalone) {
            // スタンドアロン版：CDNを使用
            codiconCssUri = '';
            codiconFontUri = '';
            cytoscapeUri = 'https://unpkg.com/cytoscape@3.26.0/dist/cytoscape.min.js';
            cytoscapeDagreUri = '';
        } else {
            // VSCode版：ローカルファイルを使用
            const mediaPath = vscode.Uri.joinPath(this.context.extensionUri, 'media');
            codiconCssUri = webview!.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'codicon.css')).toString();
            codiconFontUri = webview!.asWebviewUri(vscode.Uri.joinPath(mediaPath, 'codicon.ttf')).toString();
            cytoscapeUri = webview!.asWebviewUri(
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')
            ).toString();
            cytoscapeDagreUri = webview!.asWebviewUri(
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape-dagre', 'cytoscape-dagre.js')
            ).toString();
        }
        
        return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>${title}</title>
    ${isStandalone ? '' : `<link href="${codiconCssUri}" rel="stylesheet">`}
    ${isStandalone ? '' : `
    <style>
        @font-face {
            font-family: "codicon";
            font-display: block;
            src: url("${codiconFontUri}") format("truetype");
        }
    </style>`}
    <script src="${cytoscapeUri}"></script>
    ${isStandalone ? '' : `<script src="${cytoscapeDagreUri}"></script>`}
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
        }
        button span {
            font-weight: normal;
        }
        .export-dropdown {
            position: relative;
            display: inline-flex;
            margin: 5px;
        }
        .export-main {
            border-radius: 3px 0 0 3px;
            margin: 0;
        }
        .export-toggle {
            border-radius: 0 3px 3px 0;
            border-left: 1px solid ${isDarkTheme ? '#1177bb' : '#005a9e'};
            margin: 0;
            padding: 8px 6px;
            min-width: auto;
        }
        .export-menu {
            position: absolute;
            top: 100%;
            left: 0;
            background: ${controlsBackground};
            border: ${isDarkTheme ? '1px solid #3e3e42' : '1px solid #e1e1e1'};
            border-radius: 3px;
            box-shadow: 0 4px 8px ${boxShadowColor};
            min-width: 120px;
            z-index: 1001;
            display: none;
            flex-direction: column;
            padding: 4px 0;
        }
        .export-menu.show {
            display: flex;
        }
        .export-menu button {
            margin: 0;
            padding: 8px 12px;
            background: transparent;
            color: ${controlsColor};
            border-radius: 0;
            justify-content: flex-start;
            text-align: left;
            border: none;
        }
        .export-menu button:hover {
            background: ${isDarkTheme ? '#2a2d2e' : '#f0f0f0'};
        }
        .export-menu button i {
            margin-right: 8px;
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
            ${isStandalone ? 'Fit Graph' : '<i class="codicon codicon-go-to-editing-session"></i>'}
        </button>
        <button onclick="resetLayout()" title="Reset Layout">
            ${isStandalone ? 'Reset' : '<i class="codicon codicon-refresh"></i>'}
        </button>
        ${isStandalone ? `
        <div class="export-dropdown">
            <button onclick="exportPNG()" title="Export PNG">Export PNG</button>
        </div>` : `
        <div class="export-dropdown">
            <button class="export-main" onclick="exportHTML()" title="Export HTML">
                <i class="codicon codicon-save-as"></i>
            </button>
            <button class="export-toggle" onclick="toggleExportMenu()" title="More export options">
                <i class="codicon codicon-chevron-down"></i>
            </button>
            <div class="export-menu" id="export-menu">
                <button onclick="exportHTML(); closeExportMenu();" title="Export HTML">
                    <i class="codicon codicon-file-code"></i>
                    <span>HTML</span>
                </button>
                <button onclick="exportPNG(); closeExportMenu();" title="Export PNG">
                    <i class="codicon codicon-file-media"></i>
                    <span>PNG</span>
                </button>
            </div>
        </div>`}
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
            //minZoom: 0.1,
            //maxZoom: 3.0,
            wheelSensitivity: 1.0,
            
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
                        'source-arrow-color': function( ele ) {
                            const relationCount = ele.data('relationCount') || 1;
                            const intensity = Math.min(relationCount / 10, 1);
                            const red = Math.floor(71 + (231 - 71) * intensity);
                            const green = Math.floor(144 + (76 - 144) * intensity);
                            const blue = Math.floor(226 + (60 - 226) * intensity);
                            return \`rgb(\${red}, \${green}, \${blue})\`;
                        },
                        'source-arrow-shape': 'triangle',
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

        // ドロップダウンメニュー制御関数
        function toggleExportMenu() {
            const menu = document.getElementById('export-menu');
            if (menu) {
                menu.classList.toggle('show');

                // メニュー外クリックで閉じる
                if (menu.classList.contains('show')) {
                    setTimeout(() => {
                        document.addEventListener('click', closeExportMenuOnOutsideClick, true);
                    }, 0);
                } else {
                    document.removeEventListener('click', closeExportMenuOnOutsideClick, true);
                }
            }
        }

        function closeExportMenu() {
            const menu = document.getElementById('export-menu');
            if (menu) {
                menu.classList.remove('show');
                document.removeEventListener('click', closeExportMenuOnOutsideClick, true);
            }
        }

        function closeExportMenuOnOutsideClick(event) {
            const dropdown = document.querySelector('.export-dropdown');
            const menu = document.getElementById('export-menu');

            if (dropdown && menu && !dropdown.contains(event.target)) {
                closeExportMenu();
            }
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

        function exportHTML() {
            // 現在のグラフデータを取得
            const nodes = cy.nodes().map(node => ({ data: node.data() }));
            const edges = cy.edges().map(edge => ({ data: edge.data() }));

            // VSCodeエクステンションにエクスポート要求を送信
            ${isStandalone ? '// スタンドアロン版ではエクスポート機能なし' : `vscode.postMessage({
                type: 'exportHTML',
                data: {
                    nodes: nodes,
                    edges: edges
                }
            });`}
        }

        // VSCode API インスタンスを一度だけ取得（スタンドアロン版では条件分岐）
        ${isStandalone ? 'let vscode = null;' : 'const vscode = acquireVsCodeApi();'}

        // ツールチップ要素の作成
        const tooltip = document.createElement('div');
        tooltip.style.cssText = \`
            position: absolute;
            background: rgba(0, 0, 0, 0.9);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-family: monospace;
            z-index: 9999;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s ease;
            max-width: 300px;
            white-space: pre-wrap;
            word-wrap: break-word;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        \`;
        document.body.appendChild(tooltip);

        // エッジのマウスホバー処理
        cy.on('mouseover', 'edge', function(evt) {
            const edge = evt.target;
            const relationCount = edge.data('relationCount') || 1;
            const referenceType = edge.data('referenceType') || 'unknown';
            const relationDetails = edge.data('relationDetails') || [];
            const sourceLabel = cy.getElementById(edge.data('source')).data('label');
            const targetLabel = cy.getElementById(edge.data('target')).data('label');

            let tooltipText = \`\`;

            // 詳細情報がある場合は表示 - toSymbolNameでグルーピング
            if (relationDetails.length > 0) {

                // toSymbolNameでグルーピング
                const groupedByTarget = new Map();
                relationDetails.forEach(detail => {
                    const targetSymbol = detail.toSymbolName;
                    if (!groupedByTarget.has(targetSymbol)) {
                        groupedByTarget.set(targetSymbol, []);
                    }
                    groupedByTarget.get(targetSymbol).push(detail.fromSymbolName);
                });

                // グルーピングした結果を表示（最大10個の対象シンボル）
                let displayCount = 0;
                for (const [targetSymbol, fromSymbols] of groupedByTarget) {
                    if (displayCount >= 10) break;

                    const uniqueFromSymbols = [...new Set(fromSymbols)]; // 重複を除去
                    tooltipText += \`\${targetSymbol}\\n\`;
                    for (const fromSymbol of uniqueFromSymbols) {
                        tooltipText += \`  \${fromSymbol}\\n\`;
                    }
                    displayCount++;
                }

                if (groupedByTarget.size > 10) {
                    tooltipText += \`  ... \${groupedByTarget.size} 件\\n\`;
                }
            }

            tooltip.textContent = tooltipText;
            tooltip.style.opacity = '1';
        });

        cy.on('mouseout', 'edge', function(evt) {
            tooltip.style.opacity = '0';
        });

        // マウス移動でツールチップ位置を更新
        cy.on('mousemove', function(evt) {
            if (tooltip.style.opacity === '1') {
                tooltip.style.left = (evt.originalEvent.pageX + 10) + 'px';
                tooltip.style.top = (evt.originalEvent.pageY - 10) + 'px';
            }
        });

        // ファイル開くための複数の方法を実装
        let clickTimer = null;
        let clickCount = 0;

        // 方法1: タイマーベースのダブルクリック判定（ドラッグ干渉回避）
        cy.on('tap', 'node', function(evt) {
            const node = evt.target;
            clickCount++;

            if (clickTimer) {
                clearTimeout(clickTimer);
            }

            clickTimer = setTimeout(() => {
                if (clickCount === 1) {
                    console.log('Node single clicked:', node.data());
                } else if (clickCount >= 2) {
                    // ダブルクリック処理
                    const filePath = node.data('path');
                    if (filePath) {
                        console.log('Node double-clicked (timer), opening file:', filePath);
                        ${isStandalone ? `alert('File: ' + node.data('label') + '\\\\nPath: ' + filePath + '\\\\nSymbols: ' + (node.data('symbolCount') || 0) + '\\\\n\\\\n(Standalone version - file opening not available)');` : `vscode.postMessage({
                            type: 'openFile',
                            path: filePath
                        });`}
                    }
                }
                clickCount = 0;
            }, 300); // 300ms以内の連続クリックをダブルクリックと判定
        });

        // 方法2: 右クリックでファイルを開く
        cy.on('cxttap', 'node', function(evt) {
            const node = evt.target;
            const filePath = node.data('path');
            if (filePath) {
                console.log('Node right-clicked, opening file:', filePath);
                ${isStandalone ? `alert('File: ' + node.data('label') + '\\\\nPath: ' + filePath + '\\\\nSymbols: ' + (node.data('symbolCount') || 0) + '\\\\n\\\\n(Standalone version - file opening not available)');` : `vscode.postMessage({
                    type: 'openFile',
                    path: filePath
                });`}
            }
        });

        // 方法3: Ctrl+クリックでファイルを開く
        cy.on('tap', 'node', function(evt) {
            if (evt.originalEvent && (evt.originalEvent.ctrlKey || evt.originalEvent.metaKey)) {
                const node = evt.target;
                const filePath = node.data('path');
                if (filePath) {
                    console.log('Node Ctrl+clicked, opening file:', filePath);
                    ${isStandalone ? `alert('File: ' + node.data('label') + '\\\\nPath: ' + filePath + '\\\\nSymbols: ' + (node.data('symbolCount') || 0) + '\\\\n\\\\n(Standalone version - file opening not available)');` : `vscode.postMessage({
                        type: 'openFile',
                        path: filePath
                    });`}
                }
            }
        });
    </script>
</body>
</html>`;
    }

    private async exportStandaloneHTML(data: { nodes: any[], edges: any[] }) {
        const htmlContent = this.generateWebviewContent('Code Relationship Diagram - Standalone', null, data, true);

        // ファイル保存ダイアログを表示
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.joinPath(this.rootFolder.uri, 'code-relationship-diagram.html'),
            filters: {
                'HTML Files': ['html'],
                'All Files': ['*']
            }
        });

        if (saveUri) {
            // ファイルに書き込み
            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(htmlContent, 'utf8'));

            // 成功メッセージを表示
            const action = await vscode.window.showInformationMessage(
                `HTML file exported to: ${saveUri.fsPath}`,
                'Open File', 'Open in Browser'
            );

            if (action === 'Open File') {
                const document = await vscode.workspace.openTextDocument(saveUri);
                await vscode.window.showTextDocument(document);
            } else if (action === 'Open in Browser') {
                vscode.env.openExternal(saveUri);
            }
        }
    }


    public dispose() {
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
    }
}