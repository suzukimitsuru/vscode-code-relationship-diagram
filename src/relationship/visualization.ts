import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from '../locale';
import * as SYMBOL from '../extruct/symbol';
import * as codeRelationships from './codeRelationships';
import { Logs } from '../logs';
import * as communityDetection from './communityDetection';
import { CommunityEdge } from './communityDetection';
// Cosmos.gl integration
import * as cosmosAdapter from './cosmosAdapter';
import * as hierarchicalLayout from './hierarchicalLayout';

export class Visualization {
    private panel: vscode.WebviewPanel | null = null;
    private readonly subscriptions: { dispose(): any; }[];
    private readonly extensionPath: string;
    private readonly extensionUri: vscode.Uri;
    private readonly wsFolder: string;
    private readonly htmlFilename: string;
    private readonly logs: Logs;
    private disposeCallbacks: (() => void)[] = [];

    constructor(context: vscode.ExtensionContext, wsFolder: string, htmlFilename: string, logs: Logs) {
        this.subscriptions = context.subscriptions;
        this.extensionPath = context.extensionPath;
        this.extensionUri = context.extensionUri;
        this.wsFolder = wsFolder;
        this.htmlFilename = htmlFilename;
        this.logs = logs;
    }

    /**
     * WebViewが閉じられたときに呼び出されるコールバックを登録
     */
    public onDispose(callback: () => void): void {
        this.disposeCallbacks.push(callback);
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

    /**
     * グラフを表示（Cosmos.gl使用）
     * GPU加速WebGLレンダリングで大規模グラフに対応
     */
    public async showDiagram(symbols: SYMBOL.SymbolModel[], relationships: codeRelationships.Relationship[]) {
        const startTime = performance.now();

        // Webviewの初期化完了を待つためのPromise
        let webviewReadyResolve: (() => void) | null = null;
        const webviewReadyPromise = new Promise<void>(resolve => {
            webviewReadyResolve = resolve;
        });

        try {
            this.logs.log('[Cosmos] Starting Cosmos.gl graph generation...');
            this.logs.log(`[Cosmos] Input: ${symbols.length} symbols, ${relationships.length} relationships`);

            if (symbols.length === 0) {
                this.logs.error('[Cosmos] No symbols provided');
                return;
            }

            // 既存パネルを破棄
            if (this.panel) {
                this.panel.dispose();
            }

            // Webviewパネル作成
            this.panel = vscode.window.createWebviewPanel(
                'cosmosGraphDiagram',
                locale('window-title'),
                vscode.ViewColumn.One,
                {
                    enableScripts: true,
                    retainContextWhenHidden: true
                }
            );

            // パネルが閉じられたときにコールバックを呼び出す
            this.panel.onDidDispose(() => {
                this.panel = null;
                for (const callback of this.disposeCallbacks) {
                    try {
                        callback();
                    } catch (e) {
                        console.error('Error in dispose callback:', e);
                    }
                }
            });

            // メッセージハンドラ設定
            this.panel.webview.onDidReceiveMessage(
                async (message) => {
                    switch (message.type) {
                        case 'webviewReady':
                            this.logs.log(`[Cosmos] Webview ready`);
                            if (webviewReadyResolve) {
                                webviewReadyResolve();
                            }
                            break;
                        case 'webviewLog':
                            if (message.level === 'error') {
                                this.logs.error(message.message);
                            } else {
                                this.logs.log(message.message);
                            }
                            break;
                        case 'openFile':
                            try {
                                const absolute_uri = vscode.Uri.file(path.join(this.wsFolder, message.path));
                                const document = await vscode.workspace.openTextDocument(absolute_uri);
                                const options: vscode.TextDocumentShowOptions = {};
                                if (message.line !== undefined) {
                                    options.selection = new vscode.Range(message.line, 0, message.line, 0);
                                }
                                await vscode.window.showTextDocument(document, options);
                                this.logs.log(`[Cosmos] Opened file: ${message.path}${message.line !== undefined ? `:${message.line}` : ''}`);
                            } catch (error) {
                                this.logs.error(`[Cosmos] Failed to open file: ${error instanceof Error ? error.message : error}`);
                            }
                            break;

                        // Phase 5: HTMLエクスポート
                        case 'exportCosmosHTML':
                            try {
                                await this.exportCosmosStandaloneHTML(
                                    path.join(this.wsFolder, this.htmlFilename),
                                    message.data
                                );
                                this.logs.log('[Cosmos] HTML export completed');
                            } catch (error) {
                                this.logs.error(`[Cosmos] Failed to export HTML: ${error instanceof Error ? error.message : error}`);
                            }
                            break;
                    }
                },
                undefined,
                this.subscriptions
            );

            const panelElapsed = (performance.now() - startTime) / 1000;
            this.logs.log(`[Cosmos] ${panelElapsed.toFixed(3)}s: Created webview panel`);

            // ローディング画面を表示
            const html_loading = this.loadHtmlTemplate(path.join(this.extensionPath, 'templates', 'loading.html'));
            const emptyCosmosData: cosmosAdapter.CosmosData = { nodes: [], links: [], directories: [], nodeIndex: new Map() };
            this.panel.webview.html = this.replaceCosmosPlaceholders(html_loading, locale('window-title'), emptyCosmosData);

            // シンボルとリレーションシップをCosmos.gl形式に変換
            await this.updateProgress(20, 'Converting data to Cosmos format...');
            const convertStartTime = performance.now();

            // コミュニティ検出（オプション）
            let communities: Map<string, number> | undefined;
            const fileSymbols = symbols.filter(s => s.kind === vscode.SymbolKind.File);
            if (fileSymbols.length > 10) {
                const communityNodes = fileSymbols.map(s => ({
                    id: s.id,
                    label: path.basename(s.path),
                    kind: s.kind
                }));

                // ファイル間のエッジを作成
                const fileRelations = new Map<string, number>();
                relationships.forEach(rel => {
                    const key = `${rel.reference.path}|||${rel.define.path}`;
                    const reverseKey = `${rel.define.path}|||${rel.reference.path}`;
                    if (fileRelations.has(key)) {
                        fileRelations.set(key, fileRelations.get(key)! + 1);
                    } else if (fileRelations.has(reverseKey)) {
                        fileRelations.set(reverseKey, fileRelations.get(reverseKey)! + 1);
                    } else {
                        fileRelations.set(key, 1);
                    }
                });

                const communityEdges: CommunityEdge[] = [];
                const symbolIndex = new Map(symbols.map(s => [s.path, s.id]));
                fileRelations.forEach((weight, key) => {
                    const [sourcePath, targetPath] = key.split('|||');
                    const sourceId = symbolIndex.get(sourcePath);
                    const targetId = symbolIndex.get(targetPath);
                    if (sourceId && targetId) {
                        communityEdges.push({ source: sourceId, target: targetId, weight });
                    }
                });

                // Louvainコミュニティ検出
                const communityResult = communityDetection.detectCommunities(communityNodes, communityEdges);
                communities = communityResult.communities;
                this.logs.log(`[Cosmos] Detected ${communityResult.communityCount} communities`);
            }

            // Cosmos形式に変換
            const cosmosData = cosmosAdapter.convertToCosmosFormat(symbols, relationships, communities);
            const convertElapsed = (performance.now() - convertStartTime) / 1000;
            this.logs.log(`[Cosmos] ${convertElapsed.toFixed(3)}s: Converted to Cosmos format: ${cosmosData.nodes.length} nodes, ${cosmosData.links.length} links`);

            // 階層的レイアウトを計算
            await this.updateProgress(40, 'Calculating hierarchical layout...');
            const layoutStartTime = performance.now();
            hierarchicalLayout.calculateHierarchicalLayout(cosmosData, {
                width: 4000,
                height: 4000,
                directorySpacing: 150,
                fileSpacing: 50,
                symbolSpacing: 15,
                gravity: 0.1
            });

            // フォースレイアウトで微調整
            hierarchicalLayout.applyForceLayout(cosmosData, 50);

            const layoutElapsed = (performance.now() - layoutStartTime) / 1000;
            this.logs.log(`[Cosmos] ${layoutElapsed.toFixed(3)}s: Layout calculated`);

            // Cosmos用HTMLを設定
            await this.updateProgress(60, 'Loading Cosmos view...');
            const html_cosmos = this.loadHtmlTemplate(path.join(this.extensionPath, 'templates', 'graph-view.html'));
            this.panel.webview.html = this.replaceCosmosPlaceholders(html_cosmos, locale('window-title'), cosmosData);

            // Webview準備完了を待機
            this.logs.log(`[Cosmos] Waiting for webview ready...`);
            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('Webview initialization timeout')), 10000);
            });

            try {
                await Promise.race([webviewReadyPromise, timeoutPromise]);
                this.logs.log(`[Cosmos] Webview ready confirmed`);
            } catch (error) {
                this.logs.error(`[Cosmos] Webview timeout - proceeding anyway`);
            }

            // グラフデータを送信
            await this.updateProgress(80, 'Sending graph data...');
            await this.sendCosmosDataToWebview(cosmosData, startTime);

            const totalTime = (performance.now() - startTime) / 1000;
            this.logs.log(`[Cosmos] ${totalTime.toFixed(3)}s: Cosmos.gl diagram generation completed`);

        } catch (error) {
            this.logs.error(`[Cosmos] Error: ${error instanceof Error ? error.message : error}`);
            console.error('[Cosmos] Detailed error:', error);
            if (this.panel) {
                this.panel.dispose();
                this.panel = null;
            }
        }
    }

    /**
     * Cosmos.glデータをWebviewに送信
     */
    private async sendCosmosDataToWebview(cosmosData: cosmosAdapter.CosmosData, startTime: number): Promise<void> {
        if (!this.panel) {
            this.logs.error('[Cosmos] Cannot send data: panel is null');
            return;
        }

        try {
            // グラフデータをシリアライズ可能な形式に変換
            const serializableData = {
                nodes: cosmosData.nodes.map(node => ({
                    id: node.id,
                    x: node.x,
                    y: node.y,
                    size: node.size,
                    color: node.color,
                    parentId: node.parentId,
                    level: node.level,
                    label: node.label,
                    path: node.path,
                    kind: node.kind,
                    line: node.line,
                    communityId: node.communityId,
                    childCount: node.childCount,
                    visible: node.visible
                })),
                links: cosmosData.links.map(link => ({
                    source: link.source,
                    target: link.target,
                    width: link.width,
                    color: link.color,
                    details: link.details
                })),
                directories: cosmosData.directories
            };

            // データを送信
            await this.panel.webview.postMessage({
                type: 'graphData',
                data: serializableData
            });

            this.logs.log(`[Cosmos] Sent graph data: ${serializableData.nodes.length} nodes, ${serializableData.links.length} links`);

        } catch (error) {
            this.logs.error(`[Cosmos] Failed to send data: ${error instanceof Error ? error.message : error}`);
            throw error;
        }
    }

    /**
     * Cosmos.gl用プレースホルダーを置換
     */
    private replaceCosmosPlaceholders(template: string, title: string, cosmosData: cosmosAdapter.CosmosData, isStandalone: boolean = false): string {
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;

        const replacements: { [key: string]: string } = {
            'IS_STANDALONE_PLACEHOLDER': isStandalone ? 'true' : 'false',
            'TITLE_PLACEHOLDER': title,
            'FONT_AWWSOME_CSS_URI_PLACEHOLDER': isStandalone
                ? 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'font-awesome', 'css', 'font-awesome.min.css')).toString(),
            'FONT_AWESOME_WOFF2_URI_PLACEHOLDER': isStandalone
                ? 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'font-awesome', 'fonts', 'fontawesome-webfont.woff2')).toString(),
            'FONT_AWESOME_WOFF_URI_PLACEHOLDER': isStandalone
                ? 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'font-awesome', 'fonts', 'fontawesome-webfont.woff')).toString(),
            'FONT_AWESOME_TTF_URI_PLACEHOLDER': isStandalone
                ? 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.ttf'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'font-awesome', 'fonts', 'fontawesome-webfont.ttf')).toString(),
            // Cosmos.glライブラリ
            'COSMOS_URI_PLACEHOLDER': isStandalone
                ? 'https://unpkg.com/@cosmos.gl/graph@2.6.4/dist/index.min.js'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@cosmos.gl', 'graph', 'dist', 'index.min.js')).toString(),
            'GRAPH_SCRIPT_URI_PLACEHOLDER': isStandalone
                ? `<script>${fs.readFileSync(path.join(this.extensionPath, 'dist', 'webview', 'graphView.js'), 'utf8')}</script>`
                : `<script src="${this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'graphView.js')).toString()}"></script>`,
            'NODES_COUNT_PLACEHOLDER': cosmosData.nodes.length.toString(),
            'LINKS_COUNT_PLACEHOLDER': cosmosData.links.length.toString(),
            'GRAPH_DATA_JS_URI_PLACEHOLDER': '',
            'WORKSPACE_NAME_PLACEHOLDER': this.htmlFilename.replace('.crd.html', ''),

            // テーマカラー
            'BACKGROUND_COLOR_PLACEHOLDER': isDarkTheme ? '#1e1e1e' : '#ffffff',
            'PROGRESS_BG_COLOR_PLACEHOLDER': isDarkTheme ? '#333' : '#e0e0e0',
            'CONTROLS_COLOR_PLACEHOLDER': isDarkTheme ? '#cccccc' : '#333333',
            'CONTROLS_BG_PLACEHOLDER': isDarkTheme ? '#2d2d30' : '#ffffff',
            'BOX_SHADOW_COLOR_PLACEHOLDER': isDarkTheme ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)',
            'BORDER_STYLE_PLACEHOLDER': isDarkTheme ? '1px solid #3e3e42' : '1px solid #e1e1e1',
            'BUTTON_NO_POINT_BG_PLACEHOLDER': isDarkTheme ? '#0e639c' : '#007ACC',
            'BUTTON_HOVER_BG_PLACEHOLDER': isDarkTheme ? '#1177bb' : '#005a9e',

            'EXPORT_BUTTON_PLACEHOLDER': this.createExportButton(isStandalone)
        };

        let result = template;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }

        return result;
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

    private createExportButton(isStandalone: boolean): string {
        if (isStandalone) {
            // スタンドアロン版ではエクスポートボタンなし
            return '';
        } else {
            // VSCode拡張版ではHTMLエクスポートボタン
            return `<button onclick="exportHTML()" title="Export HTML">
                    <i class="fa fa-floppy-o" aria-hidden="true"></i>
                </button>`;
        }
    }

    // ========================================
    // HTMLエクスポート
    // ========================================

    /**
     * Cosmos.glスタンドアロンHTMLをエクスポート
     */
    private async exportCosmosStandaloneHTML(
        defaultFilename: string,
        data: {
            nodes: any[];
            links: any[];
            directories: string[];
        }
    ): Promise<void> {
        try {
            // ファイル保存ダイアログを表示
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(defaultFilename),
                filters: {
                    'HTML Files': ['html'],
                    'All Files': ['*']
                }
            });

            if (!saveUri) {
                this.logs.log('[Cosmos Export] Cancelled by user');
                return;
            }

            const htmlPath = saveUri.fsPath;
            const dataJsPath = htmlPath.replace(/\.html$/i, '.data.js');
            const dataJsFilename = path.basename(dataJsPath);

            this.logs.log(`[Cosmos Export] Exporting to: ${htmlPath}`);
            this.logs.log(`[Cosmos Export] Data file: ${dataJsPath}`);

            // データJSファイルを書き込み
            await this.writeCosmosDataJsFile(dataJsPath, data);
            this.logs.log(`[Cosmos Export] Data file written: ${data.nodes.length} nodes, ${data.links.length} links`);

            // HTMLテンプレートを生成
            const html_template = this.loadHtmlTemplate(path.join(this.extensionPath, 'templates', 'graph-view.html'));
            const html_content = this.replaceCosmosPlaceholdersStandalone(html_template, dataJsFilename, data);

            // HTMLファイルを書き込み
            await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html_content, 'utf8'));
            this.logs.log(`[Cosmos Export] HTML file written (${html_content.length} bytes)`);

            // 成功メッセージを表示
            const action = await vscode.window.showInformationMessage(
                `Cosmos.gl HTML exported to: ${htmlPath}`,
                'Open File', 'Open in Browser'
            );

            if (action === 'Open File') {
                const document = await vscode.workspace.openTextDocument(saveUri);
                await vscode.window.showTextDocument(document);
            } else if (action === 'Open in Browser') {
                vscode.env.openExternal(saveUri);
            }

        } catch (error) {
            this.logs.error(`[Cosmos Export] Failed: ${error instanceof Error ? error.message : error}`);
            vscode.window.showErrorMessage(`Cosmos HTML export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Cosmos.glデータJSファイルを書き込み
     */
    private async writeCosmosDataJsFile(
        filepath: string,
        data: {
            nodes: any[];
            links: any[];
            directories: string[];
        }
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const writeStream = fs.createWriteStream(filepath, { encoding: 'utf8' });

                writeStream.on('error', (error) => {
                    this.logs.error(`[Cosmos Export] Write stream error: ${error.message}`);
                    reject(error);
                });

                writeStream.on('finish', () => {
                    resolve();
                });

                // JavaScriptファイルの開始
                writeStream.write('// Cosmos.gl Graph Data for Standalone HTML\n');
                writeStream.write('window.COSMOS_GRAPH_DATA = {\n');

                // ノード配列
                writeStream.write('  "nodes": [\n');
                for (let i = 0; i < data.nodes.length; i++) {
                    const nodeJson = JSON.stringify(data.nodes[i]);
                    const comma = i < data.nodes.length - 1 ? ',' : '';
                    writeStream.write(`    ${nodeJson}${comma}\n`);
                }
                writeStream.write('  ],\n');

                // リンク配列
                writeStream.write('  "links": [\n');
                for (let i = 0; i < data.links.length; i++) {
                    const linkJson = JSON.stringify(data.links[i]);
                    const comma = i < data.links.length - 1 ? ',' : '';
                    writeStream.write(`    ${linkJson}${comma}\n`);
                }
                writeStream.write('  ],\n');

                // ディレクトリ配列
                writeStream.write(`  "directories": ${JSON.stringify(data.directories)}\n`);

                writeStream.write('};\n');
                writeStream.end();

            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Cosmos.glスタンドアロン版用プレースホルダー置換
     */
    private replaceCosmosPlaceholdersStandalone(
        template: string,
        dataJsFilename: string,
        data: { nodes: any[]; links: any[]; directories: string[] }
    ): string {
        const replacements: { [key: string]: string } = {
            'IS_STANDALONE_PLACEHOLDER': 'true',
            'TITLE_PLACEHOLDER': `${this.htmlFilename.replace('.crd.html', '')} - Cosmos.gl (Standalone)`,
            'FONT_AWWSOME_CSS_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
            'FONT_AWESOME_WOFF2_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2',
            'FONT_AWESOME_WOFF_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff',
            'FONT_AWESOME_TTF_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.ttf',
            // Cosmos.glをCDNから読み込み
            'COSMOS_URI_PLACEHOLDER': 'https://unpkg.com/@cosmos.gl/graph@2.6.4/dist/index.min.js',
            // スタンドアロン用スクリプト（データファイル読み込み + インライン化）
            'GRAPH_SCRIPT_URI_PLACEHOLDER': `<script src="${dataJsFilename}"></script>\n<script>${fs.readFileSync(path.join(this.extensionPath, 'dist', 'webview', 'graphView.js'), 'utf8')}</script>`,
            'NODES_COUNT_PLACEHOLDER': data.nodes.length.toString(),
            'LINKS_COUNT_PLACEHOLDER': data.links.length.toString(),
            'GRAPH_DATA_JS_URI_PLACEHOLDER': dataJsFilename,
            'WORKSPACE_NAME_PLACEHOLDER': this.htmlFilename.replace('.crd.html', ''),

            // テーマカラー（ダークテーマ固定）
            'BACKGROUND_COLOR_PLACEHOLDER': '#1e1e1e',
            'PROGRESS_BG_COLOR_PLACEHOLDER': '#333',
            'CONTROLS_COLOR_PLACEHOLDER': '#cccccc',
            'CONTROLS_BG_PLACEHOLDER': '#2d2d30',
            'BOX_SHADOW_COLOR_PLACEHOLDER': 'rgba(0,0,0,0.5)',
            'BORDER_STYLE_PLACEHOLDER': '1px solid #3e3e42',
            'BUTTON_NO_POINT_BG_PLACEHOLDER': '#0e639c',
            'BUTTON_HOVER_BG_PLACEHOLDER': '#1177bb',

            // スタンドアロン版ではエクスポートボタンなし
            'EXPORT_BUTTON_PLACEHOLDER': ''
        };

        let result = template;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }

        return result;
    }

    // ========================================
    // VSCode統合 - エディタイベント連携
    // ========================================

    /**
     * パネルがアクティブかどうかを確認
     */
    public isActive(): boolean {
        return this.panel !== null;
    }

    /**
     * エディタでファイルが開かれた時にWebviewに通知
     * @param filePath ワークスペースからの相対パス
     */
    public sendEditorFileOpen(filePath: string): void {
        if (!this.panel) {return;}

        const relativePath = path.relative(this.wsFolder, filePath);
        this.panel.webview.postMessage({
            type: 'editorFileOpen',
            path: relativePath
        });
        this.logs.log(`[Phase4] Sent editorFileOpen: ${relativePath}`);
    }

    /**
     * エディタのカーソル位置が変更された時にWebviewに通知
     * @param filePath ワークスペースからの相対パス
     * @param line 行番号（0-indexed）
     */
    public sendEditorCursorChange(filePath: string, line: number): void {
        if (!this.panel) {return;}

        const relativePath = path.relative(this.wsFolder, filePath);
        this.panel.webview.postMessage({
            type: 'editorCursorChange',
            path: relativePath,
            line: line
        });
    }

    /**
     * 特定のファイルにズーム
     * @param filePath ワークスペースからの相対パス
     */
    public zoomToFile(filePath: string): void {
        if (!this.panel) {return;}

        const relativePath = path.relative(this.wsFolder, filePath);
        this.panel.webview.postMessage({
            type: 'zoomToFile',
            path: relativePath
        });
        this.logs.log(`[Phase4] Sent zoomToFile: ${relativePath}`);
    }

    /**
     * 関連コードを表示（選択範囲のシンボルとその依存関係）
     * @param filePath ファイルパス
     * @param startLine 開始行
     * @param endLine 終了行
     */
    public showRelatedCode(filePath: string, startLine: number, endLine: number): void {
        if (!this.panel) {return;}

        const relativePath = path.relative(this.wsFolder, filePath);
        this.panel.webview.postMessage({
            type: 'showRelatedCode',
            path: relativePath,
            startLine: startLine,
            endLine: endLine
        });
        this.logs.log(`[Phase4] Sent showRelatedCode: ${relativePath}:${startLine}-${endLine}`);
    }

    /**
     * パネル破棄時のコールバックを設定
     */
    public onDidDispose(callback: () => void): void {
        if (this.panel) {
            this.panel.onDidDispose(callback);
        }
    }

    public dispose() {
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
        // 登録されたコールバックを呼び出す
        for (const callback of this.disposeCallbacks) {
            try {
                callback();
            } catch (e) {
                console.error('Error in dispose callback:', e);
            }
        }
        this.disposeCallbacks = [];
    }
}
