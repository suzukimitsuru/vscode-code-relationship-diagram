import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import * as SYMBOL from './symbol';
import * as codeRelationships from './codeRelationships';
import { Logs } from './logs';

export class GraphVisualization {
    private panel: vscode.WebviewPanel | null = null;
    private readonly context: vscode.ExtensionContext;
    private readonly wsFolder: string;
    private readonly htmlFilename: string;
    private readonly logs: Logs;

    constructor(context: vscode.ExtensionContext, wsFolder: string, htmlFilename: string, logs: Logs) {
        this.context = context;
        this.wsFolder = wsFolder;
        this.htmlFilename = htmlFilename;
        this.logs = logs;
    }

    public async showDiagram(symbols: SYMBOL.SymbolModel[], relationships: codeRelationships.Relationship[]) {
        const startTime = performance.now();
        
        try {
            this.logs.log('[0.000s][  0.00%] Starting code relationship diagram generation...');
            this.logs.log(`[0.000s][  0.00%] Input: ${symbols.length} symbols, ${relationships.length} relationships`);
            
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
                                // ファイルを開く
                                const absolute_uri = vscode.Uri.file(path.join(this.wsFolder, message.path));
                                const document = await vscode.workspace.openTextDocument(absolute_uri);

                                // 行番号が指定されている場合は該当行に移動
                                const options: vscode.TextDocumentShowOptions = {};
                                if (message.line !== undefined) {
                                    options.selection = new vscode.Range(message.line, 0, message.line, 0);
                                }

                                await vscode.window.showTextDocument(document, options);
                                this.logs.log(`Opened file: ${message.path}${message.line ? `:${message.line}` : ''}`);
                            } catch (error) {
                                this.logs.error(`Failed to open file ${message.path}: ${error instanceof Error ? error.message : error}`);
                            }
                            break;
                        case 'exportHTML':
                            try {
                                await this.exportStandaloneHTML(path.join(this.wsFolder, this.htmlFilename), message.data);
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
        const html_loading = this.loadHtmlTemplate(path.join(this.context.extensionPath, 'templates', 'loading.html'));
        this.panel.webview.html = this.replacePlaceholders(html_loading, locale('window-title'), { nodes: [], edges: [] });
        const loadingElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${loadingElapsed.toFixed(3)}s  15.00%: Generated loading content`);
        
        // 進捗を段階的に更新
        await this.updateProgress(20, 'Processing symbols...');
        
        const elementsStartTime = performance.now();
        const elements = this.createGraphElements(symbols, relationships, startTime);
        const elementsEndTime = performance.now();
        const elementsElapsed = (elementsEndTime - startTime) / 1000;
        this.logs.log(`${elementsElapsed.toFixed(3)}s  60.00%: Created graph elements: ${elements.nodes.length} nodes, ${elements.edges.length} edges (${(elementsEndTime - elementsStartTime).toFixed(3)}ms)`);
        
        await this.updateProgress(50, 'Generating graph...');
        
        // 最終的なHTMLを設定
        const htmlStartTime = performance.now();
        const html_load = this.loadHtmlTemplate(path.join(this.context.extensionPath, 'templates', 'graph.html'));
        this.panel.webview.html = this.replacePlaceholders(html_load, locale('window-title'), elements);
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

    private createGraphElements(symbols: SYMBOL.SymbolModel[], relationships: codeRelationships.Relationship[], startTime: number) {
        const currentElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${currentElapsed.toFixed(3)}s  20.00%: Creating graph elements from symbols and relationships...`);
        const nodes: any[] = [];
        const edges: any[] = [];
        const fileNodes = new Map<string, any>();
        const fileRelations = new Map<string, number>();
        const fileRelationDetails = new Map<string, Array<{
            referenceSymbolName: string;
            defineSymbolName: string;
            referenceLine: number;
            defineLine: number;
            referencePath: string;
            definePath: string;
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
        let processedRelationships = 0;
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 35.00%] Starting to process ${relationships.length} relationships...`);

        relationships.forEach((rel, index) => {
            if (index < 5) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 35.${String(index + 1).padStart(2, '0')}%] Relationship ${index + 1}: ${rel.reference.path} -> ${rel.define.path}`);
            }

            const relationshipKey = `${rel.reference.path}|||${rel.define.path}`;
            const reverseKey = `${rel.define.path}|||${rel.reference.path}`;

            // 詳細情報を作成 - インデックスを使用して高速検索
            const referenceSymbol = symbolIndex.get(rel.reference.id);
            const defineSymbol = symbolIndex.get(rel.define.id);

            // デバッグ用のログ出力（最初の数個のみ）
            if (index < 3) {
                console.log(`Debug relationship ${index}: from.id=${rel.reference.id}, to.id=${rel.define.id}`);
                console.log(`Debug symbols sample:`, symbols.slice(0, 2).map(s => ({id: s.id, name: s.name})));
                console.log(`Found referenceSymbol: ${referenceSymbol ? referenceSymbol.name : 'NOT FOUND'}`);
                console.log(`Found defineSymbol: ${defineSymbol ? defineSymbol.name : 'NOT FOUND'}`);

                // さらに詳細なデバッグ
                this.logs.log(`Debug ref ${index}: from.id=${rel.reference.id}, to.id=${rel.define.id}`);
                this.logs.log(`Debug symbols total count: ${symbols.length}`);
                this.logs.log(`Found referenceSymbol: ${referenceSymbol ? referenceSymbol.name : 'NOT FOUND'}`);
                this.logs.log(`Found defineSymbol: ${defineSymbol ? defineSymbol.name : 'NOT FOUND'}`);
            }

            const detailInfo = {
                referenceSymbolName: referenceSymbol?.name || 'Unknown',
                defineSymbolName: defineSymbol?.name || 'Unknown',
                referenceLine: rel.reference.startLine,
                defineLine: rel.define.startLine,
                referencePath: rel.reference.path,
                definePath: rel.define.path
            };

            // 双方向の関係を考慮して集約
            let actualKey = relationshipKey;
            if (fileRelations.has(relationshipKey)) {
                fileRelations.set(relationshipKey, fileRelations.get(relationshipKey)! + 1);
            } else if (fileRelations.has(reverseKey)) {
                fileRelations.set(reverseKey, fileRelations.get(reverseKey)! + 1);
                actualKey = reverseKey;
            } else {
                fileRelations.set(relationshipKey, 1);
            }

            // 詳細情報を追加
            if (!fileRelationDetails.has(actualKey)) {
                fileRelationDetails.set(actualKey, []);
            }
            fileRelationDetails.get(actualKey)!.push(detailInfo);

            processedRelationships++;
        });
        const relationsElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${relationsElapsed.toFixed(3)}s  40.00%: Processed ${processedRelationships} relationships into ${fileRelations.size} file relations`);

        // ノードを配列に追加
        nodes.push(...Array.from(fileNodes.values()));

        // ファイル間のエッジを生成
        let edgeCount = 0;
        const edgeDetails: Array<{from: string, to: string, count: number}> = [];
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 45.00%] Starting to generate edges from ${fileRelations.size} file relations...`);
        
        fileRelations.forEach((count, relationshipKey) => {
            const [referencePath, definePath] = relationshipKey.split('|||');
            if (edgeCount < 3) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 45.${String(edgeCount + 1).padStart(2, '0')}%] Processing relation: ${path.basename(referencePath)} -> ${path.basename(definePath)} (count: ${count})`);
            }
            
            const referenceNode = Array.from(fileNodes.values()).find(node => node.data.path === referencePath);
            const toNode = Array.from(fileNodes.values()).find(node => node.data.path === definePath);
            
            if (referenceNode && toNode) {
                const relationshipDetails = fileRelationDetails.get(relationshipKey) || [];
                edges.push({
                    data: {
                        id: `file-relation-${referenceNode.data.id}-${toNode.data.id}`,
                        source: referenceNode.data.id,
                        target: toNode.data.id,
                        relationshipType: 'file-relationship',
                        relationshipCount: count,
                        relationshipDetails: relationshipDetails
                    }
                });
                edgeCount++;
                edgeDetails.push({
                    from: referenceNode.data.label,
                    to: toNode.data.label,
                    count: count
                });
                const edgeElapsed = (performance.now() - startTime) / 1000;
                if (edgeCount <= 3) {
                    this.logs.log(`${edgeElapsed.toFixed(3)}s  47.${String(edgeCount).padStart(2, '0')}%: Created edge: ${referenceNode.data.label} → ${toNode.data.label} (${count} relations)`);
                }
            } else {
                const skipElapsed = (performance.now() - startTime) / 1000;
                this.logs.log(`${skipElapsed.toFixed(3)}s  47.XX%: Skipped edge: ${path.basename(referencePath)} → ${path.basename(definePath)} (nodes not found)`);
                this.logs.log(`${skipElapsed.toFixed(3)}s  47.XX%: referenceNode: ${referenceNode ? 'found' : 'NOT FOUND'}, toNode: ${toNode ? 'found' : 'NOT FOUND'}`);
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
                this.logs.log(`${detailElapsed.toFixed(3)}s  52.${((index + 1) / sortedEdges.length * 100).toFixed(0).padStart(2, '0')}%:   ${edge.from} → ${edge.to}: ${edge.count} relationships`);
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

    private loadHtmlTemplate(path: string): string {
        try {
            return fs.readFileSync(path, 'utf8');
        } catch (error) {
            this.logs.log(`Error loading HTML template: ${error}`);
            // フォールバック用の最小HTML
            return `<!DOCTYPE html><html><head><title>Error</title></head><body>Template not found</body></html>`;
        }
    }

    private replacePlaceholders(template: string, title: string, elements: any, isStandalone: boolean = false): string {
        // VSCodeのテーマ色を取得
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const replacements: { [key: string]: string } = {
            'IS_STANDALONE_PLACEHOLDER':        isStandalone ? 'true' : 'false',
            'TITLE_PLACEHOLDER':                title,
            'FONT_AWWSOME_CSS_URI_PLACEHOLDER': isStandalone
                ?  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'font-awesome', 'css', 'font-awesome.min.css')).toString(),
            'CYTOSCAPE_URI_PLACEHOLDER':        isStandalone
                ? 'https://unpkg.com/cytoscape@3.26.0/dist/cytoscape.min.js'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')).toString(),
            'CYTOSCAPE_DAGRE_URI_PLACEHOLDER':  isStandalone
                ? 'https://cdn.jsdelivr.net/npm/cytoscape-dagre@2.5.0/cytoscape-dagre.min.js'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', 'cytoscape-dagre', 'cytoscape-dagre.js')).toString(),

            'BACKGROUND_COLOR_PLACEHOLDER':     isDarkTheme ? '#1e1e1e' : '#ffffff',
            'PROGRESS_BG_COLOR_PLACEHOLDER':    isDarkTheme ? '#333' : '#e0e0e0',

            'CONTROLS_COLOR_PLACEHOLDER':       isDarkTheme ? '#cccccc' : '#333333',
            'CONTROLS_BG_PLACEHOLDER':          isDarkTheme ? '#2d2d30' : '#ffffff',
            'BOX_SHADOW_COLOR_PLACEHOLDER':     isDarkTheme ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)',
            'BORDER_STYLE_PLACEHOLDER':         isDarkTheme ? '1px solid #3e3e42' : '1px solid #e1e1e1',

            'BUTTON_NO_POINT_BG_PLACEHOLDER':   isDarkTheme ? '#0e639c' : '#007ACC',
            'BUTTON_HOVER_BG_PLACEHOLDER':      isDarkTheme ? '#1177bb' : '#005a9e',

            'ELEMENTS_PLACEHOLDER':             JSON.stringify([...elements.nodes, ...elements.edges]),
            'ELEMENTS_NODES_LENGTH_PLACEHOLDER': elements.nodes.length.toString(),
            'ELEMENTS_EDGES_LENGTH_PLACEHOLDER': elements.edges.length.toString(),

            'EXPORT_BUTTON_PLACEHOLDER':         isStandalone ? `
                <div class="export-dropdown">
                    <button onclick="exportPNG()" title="Export PNG">Export PNG</button>
                </div>` : `
                <div class="export-dropdown">
                    <button class="export-main" title="Export File">
                        <i class="fa fa-floppy-o" aria-hidden="true"></i>
                    </button>
                    <button class="export-toggle" onclick="toggleExportMenu()" title="More export options">
                        <i class="fa fa-chevron-down" aria-hidden="true"></i>
                    </button>
                    <div class="export-menu" id="export-menu">
                        <button onclick="exportHTML(); closeExportMenu();" title="Export HTML">
                            <i class="fa fa-code" aria-hidden="true"></i>
                            <span>HTML</span>
                        </button>
                        <button onclick="exportPNG(); closeExportMenu();" title="Export PNG">
                            <i class="fa fa-picture-o" aria-hidden="true"></i>
                            <span>PNG</span>
                        </button>
                    </div>
                </div>`
        };

        let result = template;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }

        return result;
    }
    
    private async exportStandaloneHTML(filename: string, data: { nodes: any[], edges: any[] }) {
        const html_load = this.loadHtmlTemplate(path.join(this.context.extensionPath, 'templates', 'graph.html'));
        const html_text = this.replacePlaceholders(html_load, locale('window-title') + ' - Standalone', data, true);

        // ファイル保存ダイアログを表示
        const saveUri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(filename),
            filters: {
                'HTML Files': ['html'],
                'All Files': ['*']
            }
        });

        if (saveUri) {
            // ファイルに書き込み
            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html_text, 'utf8'));

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