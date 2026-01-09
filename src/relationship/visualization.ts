import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from '../locale';
import * as SYMBOL from '../extruct/symbol';
import * as codeRelationships from './codeRelationships';
import { Logs } from '../logs';
import * as dagreLayout from './dagreLayout';
import * as codeDb from '../codeDb';

export class Visualization {
    private panel: vscode.WebviewPanel | null = null;
    private readonly subscriptions: { dispose(): any; }[];
    private readonly extensionPath: string;
    private readonly extensionUri: vscode.Uri;
    private readonly wsFolder: string;
    private readonly htmlFilename: string;
    private readonly logs: Logs;

    // HTMLエクスポート時のチャンク蓄積用
    private exportData?: { nodes: any[], edges: any[] };
    private exportLayoutPositionsChunks: Map<string, Array<{id: string, x: number, y: number}>[]> = new Map();

    constructor(context: vscode.ExtensionContext, wsFolder: string, htmlFilename: string, logs: Logs) {
        this.subscriptions = context.subscriptions;
        this.extensionPath = context.extensionPath;
        this.extensionUri = context.extensionUri;
        this.wsFolder = wsFolder;
        this.htmlFilename = htmlFilename;
        this.logs = logs;
    }

    public async showDiagram(symbols: SYMBOL.SymbolModel[], relationships: codeRelationships.Relationship[]) {
        const startTime = performance.now();

        // Webviewの初期化完了を待つためのPromise
        let webviewReadyResolve: (() => void) | null = null;
        const webviewReadyPromise = new Promise<void>(resolve => {
            webviewReadyResolve = resolve;
        });

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
                            case 'webviewReady':
                                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  62.00%: Webview initialization complete (received ready signal)`);
                                if (webviewReadyResolve) {
                                    webviewReadyResolve();
                                }
                                break;
                            case 'openFile':
                                try {
                                    // ファイルを開く
                                    const absolute_uri = vscode.Uri.file(path.join(this.wsFolder, message.path));
                                    const document = await vscode.workspace.openTextDocument(absolute_uri);

                                    // 行番号が指定されている場合は該当行に移動
                                    const options: vscode.TextDocumentShowOptions = {};
                                    if (message.line) {
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
                                    // データを保存して、チャンク受信を開始
                                    this.exportData = message.data;
                                    this.exportLayoutPositionsChunks.clear();
                                    this.logs.log('HTML export started, waiting for layout position chunks...');
                                } catch (error) {
                                    this.logs.error(`Failed to start HTML export: ${error instanceof Error ? error.message : error}`);
                                }
                                break;

                            case 'layoutPositionsChunk':
                                try {
                                    const { viewType, chunk, totalChunks, positions } = message;

                                    // viewTypeごとのチャンク配列を初期化
                                    if (!this.exportLayoutPositionsChunks.has(viewType)) {
                                        this.exportLayoutPositionsChunks.set(viewType, []);
                                    }

                                    // チャンクを保存
                                    const chunks = this.exportLayoutPositionsChunks.get(viewType)!;
                                    chunks[chunk] = positions;

                                    this.logs.log(`Received layout positions chunk ${chunk + 1}/${totalChunks} for '${viewType}' (${positions.length} positions)`);
                                } catch (error) {
                                    this.logs.error(`Failed to receive layout positions chunk: ${error instanceof Error ? error.message : error}`);
                                }
                                break;

                            case 'layoutPositionsComplete':
                                try {
                                    // 全チャンクを結合
                                    const layoutPositions: { [viewType: string]: Array<{id: string, x: number, y: number}> } = {};
                                    this.exportLayoutPositionsChunks.forEach((chunks, viewType) => {
                                        layoutPositions[viewType] = chunks.flat();
                                        this.logs.log(`Merged ${chunks.length} chunks for '${viewType}': ${layoutPositions[viewType].length} positions`);
                                    });

                                    // exportStandaloneHTMLを呼び出し
                                    if (this.exportData) {
                                        await this.exportStandaloneHTML(
                                            path.join(this.wsFolder, this.htmlFilename),
                                            this.exportData,
                                            Object.keys(layoutPositions).length > 0 ? layoutPositions : undefined
                                        );
                                        this.logs.log('HTML exported successfully');

                                        // クリーンアップ
                                        this.exportData = undefined;
                                        this.exportLayoutPositionsChunks.clear();
                                    } else {
                                        throw new Error('Export data not found');
                                    }
                                } catch (error) {
                                    this.logs.error(`Failed to export HTML: ${error instanceof Error ? error.message : error}`);
                                    // エラー時もクリーンアップ
                                    this.exportData = undefined;
                                    this.exportLayoutPositionsChunks.clear();
                                }
                                break;
                        }
                    },
                    undefined,
                    this.subscriptions
                );

                const panelElapsed = (performance.now() - startTime) / 1000;
                this.logs.log(`${panelElapsed.toFixed(3)}s  10.00%: Created new webview panel`);
            } catch (panelError) {
                this.logs.error(`Failed to create webview panel: ${panelError instanceof Error ? panelError.message : panelError}`);
                console.error('Panel creation error:', panelError);
                return;
            }

            // 初期HTML（ローディング状態）を表示
            const html_loading = this.loadHtmlTemplate(path.join(this.extensionPath, 'templates', 'loading.html'));
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

            // 最終的なHTMLを設定（空のデータで初期化）
            const htmlStartTime = performance.now();
            const html_load = this.loadHtmlTemplate(path.join(this.extensionPath, 'templates', 'graph-multiview.html'));
            const emptyElements = { nodes: [], edges: [] };
            this.panel.webview.html = this.replacePlaceholders(html_load, locale('window-title'), emptyElements);
            const htmlEndTime = performance.now();
            const htmlElapsed = (htmlEndTime - startTime) / 1000;
            this.logs.log(`${htmlElapsed.toFixed(3)}s  70.00%: Generated webview content (multi-view) (${(htmlEndTime - htmlStartTime).toFixed(3)}ms)`);

            await this.updateProgress(60, 'Sending graph data...');

            // Webviewの初期化完了を待つ（webviewReady メッセージの受信を待機）
            this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  61.00%: Waiting for webview initialization...`);

            // タイムアウト付きで待機（最大10秒）
            const timeoutPromise = new Promise<void>((_, reject) => {
                setTimeout(() => reject(new Error('Webview initialization timeout')), 10000);
            });

            try {
                await Promise.race([webviewReadyPromise, timeoutPromise]);
                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  63.00%: Webview ready confirmed, starting data transmission...`);
            } catch (error) {
                this.logs.error(`Webview initialization timeout - proceeding anyway: ${error instanceof Error ? error.message : error}`);
            }

            // 階層構造ビュー用のレイアウト計算（拡張機能側でDagreレイアウトを計算）
            await this.updateProgress(64, 'Calculating hierarchy layout...');
            const layoutStartTime = performance.now();
            const hierarchyPositions = await this.calculateHierarchyLayout(elements, startTime);
            const layoutEndTime = performance.now();
            const layoutElapsed = (layoutEndTime - startTime) / 1000;
            this.logs.log(`${layoutElapsed.toFixed(3)}s  75.00%: Calculated hierarchy layout: ${hierarchyPositions.size} positions (${(layoutEndTime - layoutStartTime).toFixed(3)}ms)`);

            // レイアウト座標をWebviewに送信
            if (hierarchyPositions.size > 0) {
                const positionsArray = Array.from(hierarchyPositions.entries()).map(([id, pos]) => ({
                    id,
                    x: pos.x,
                    y: pos.y
                }));

                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  76.00%: Sending ${positionsArray.length} hierarchy positions to webview...`);
                // サンプル座標をログ出力
                if (positionsArray.length > 0) {
                    this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  76.50%: Sample positions: ${positionsArray.slice(0, 3).map(p => `${p.id}=(${p.x.toFixed(0)},${p.y.toFixed(0)})`).join(', ')}`);
                }

                await this.panel.webview.postMessage({
                    type: 'layoutPositions',
                    viewType: 'hierarchy',
                    positions: positionsArray
                });
                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  78.00%: ✓ Sent hierarchy layout positions to webview`);
            } else {
                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  76.00%: ⚠️  No hierarchy positions calculated, webview will use fallback layout`);
            }

            // 呼び出しグラフビュー用のレイアウト計算
            await this.updateProgress(79, 'Calculating call graph layout...');
            const callGraphLayoutStartTime = performance.now();
            const callGraphPositions = await this.calculateCallGraphLayout(elements, startTime);
            const callGraphLayoutEndTime = performance.now();
            const callGraphLayoutElapsed = (callGraphLayoutEndTime - startTime) / 1000;
            this.logs.log(`${callGraphLayoutElapsed.toFixed(3)}s  82.00%: Calculated call graph layout: ${callGraphPositions.size} positions (${(callGraphLayoutEndTime - callGraphLayoutStartTime).toFixed(3)}ms)`);

            // レイアウト座標をWebviewに送信
            if (callGraphPositions.size > 0) {
                const positionsArray = Array.from(callGraphPositions.entries()).map(([id, pos]) => ({
                    id,
                    x: pos.x,
                    y: pos.y
                }));

                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  83.00%: Sending ${positionsArray.length} call graph positions to webview...`);

                await this.panel.webview.postMessage({
                    type: 'layoutPositions',
                    viewType: 'call-graph',
                    positions: positionsArray
                });
                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  85.00%: ✓ Sent call graph layout positions to webview`);
            } else {
                this.logs.log(`${((performance.now() - startTime) / 1000).toFixed(3)}s  83.00%: ⚠️  No call graph positions calculated, webview will use fallback layout`);
            }

            // データをpostMessageで送信（大規模データの場合はチャンク分割）
            const sendStartTime = performance.now();
            await this.sendGraphDataToWebview(elements, startTime);
            const sendEndTime = performance.now();
            const sendElapsed = (sendEndTime - startTime) / 1000;
            this.logs.log(`${sendElapsed.toFixed(3)}s  95.00%: Sent graph data to webview (${(sendEndTime - sendStartTime).toFixed(3)}ms)`);

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

    private async sendGraphDataToWebview(elements: any, startTime: number): Promise<void> {
        if (!this.panel) {
            this.logs.error('Cannot send data: panel is null');
            return;
        }

        const totalElements = elements.nodes.length + elements.edges.length;
        const CHUNK_SIZE = 5000; // チャンクサイズ

        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 61.00%] Sending ${totalElements} elements in chunks of ${CHUNK_SIZE}...`);

        try {
            // ノードをチャンクに分割して送信
            for (let i = 0; i < elements.nodes.length; i += CHUNK_SIZE) {
                const chunk = elements.nodes.slice(i, i + CHUNK_SIZE);
                const chunkIndex = Math.floor(i / CHUNK_SIZE);
                const totalChunks = Math.ceil(elements.nodes.length / CHUNK_SIZE);

                await this.panel.webview.postMessage({
                    type: 'graphData',
                    dataType: 'nodes',
                    chunk: chunk,
                    chunkIndex: chunkIndex,
                    totalChunks: totalChunks,
                    isLastChunk: i + CHUNK_SIZE >= elements.nodes.length
                });

                // UI更新のための小さな待機
                await new Promise(resolve => setTimeout(resolve, 50));

                if (chunkIndex === 0 || chunkIndex % 5 === 0 || i + CHUNK_SIZE >= elements.nodes.length) {
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s][ ${(61 + (i / elements.nodes.length) * 10).toFixed(2)}%] Sent nodes chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} nodes)`);
                }
            }

            // エッジをチャンクに分割して送信
            for (let i = 0; i < elements.edges.length; i += CHUNK_SIZE) {
                const chunk = elements.edges.slice(i, i + CHUNK_SIZE);
                const chunkIndex = Math.floor(i / CHUNK_SIZE);
                const totalChunks = Math.ceil(elements.edges.length / CHUNK_SIZE);

                await this.panel.webview.postMessage({
                    type: 'graphData',
                    dataType: 'edges',
                    chunk: chunk,
                    chunkIndex: chunkIndex,
                    totalChunks: totalChunks,
                    isLastChunk: i + CHUNK_SIZE >= elements.edges.length
                });

                // UI更新のための小さな待機
                await new Promise(resolve => setTimeout(resolve, 50));

                if (chunkIndex === 0 || chunkIndex % 10 === 0 || i + CHUNK_SIZE >= elements.edges.length) {
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s][ ${(71 + (i / elements.edges.length) * 15).toFixed(2)}%] Sent edges chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} edges)`);
                }
            }

            // 完了通知
            await this.panel.webview.postMessage({
                type: 'graphDataComplete',
                totalNodes: elements.nodes.length,
                totalEdges: elements.edges.length
            });

            this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 86.00%] Data transmission complete`);

        } catch (error) {
            this.logs.error(`Failed to send graph data: ${error instanceof Error ? error.message : error}`);
            console.error('Data send error:', error);
            throw error;
        }
    }

    private createGraphElements(symbols: SYMBOL.SymbolModel[], relationships: codeRelationships.Relationship[], startTime: number) {
        const currentElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${currentElapsed.toFixed(3)}s  20.00%: Creating graph elements from symbols and relationships (multi-view)...`);
        const nodes: any[] = [];
        const edges: any[] = [];
        const fileNodes = new Map<string, any>();
        const allSymbolNodes = new Map<string, any>();
        const fileRelations = new Map<string, number>();
        const fileRelationDetails = new Map<string, Array<{
            referenceSymbolName: string;
            defineSymbolName: string;
            referenceLine: number;
            defineLine: number;
            referencePath: string;
            definePath: string;
        }>>();

        // 全シンボルノードを作成（フラットな配列から生成）
        let fileSymbolCount = 0;
        let totalNodeCount = 0;

        // フラットな配列から全シンボルノードを作成
        let nodesWithParent = 0;
        symbols.forEach(symbol => {
            const nodeData: any = {
                id: symbol.id,
                label: this.getSymbolLabel(symbol),
                path: symbol.path,
                kind: symbol.kind,
                line: symbol.define.line
            };

            // 親IDがある場合は設定（階層構造ビュー用）
            if (symbol.parentId) {
                nodeData.parent = symbol.parentId;
                nodesWithParent++;
            }

            // ファイルノードの場合はシンボル数を追加
            if (symbol.kind === vscode.SymbolKind.File) {
                nodeData.symbolCount = this.countSymbolsInFile(symbol);
                fileSymbolCount++;
                // ファイルノードマップに追加
                fileNodes.set(symbol.path, { data: nodeData });
            }

            allSymbolNodes.set(symbol.id, { data: nodeData });
            totalNodeCount++;
        });

        const nodesElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${nodesElapsed.toFixed(3)}s  30.00%: Created ${fileSymbolCount} file nodes and ${totalNodeCount} total symbol nodes`);
        this.logs.log(`${nodesElapsed.toFixed(3)}s  30.50%: Nodes with parent: ${nodesWithParent} (${(nodesWithParent / totalNodeCount * 100).toFixed(2)}%)`);

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

        // 全シンボルノードを配列に追加（マルチビュー対応）
        nodes.push(...Array.from(allSymbolNodes.values()));
        this.logs.log(`[${(performance.now() - startTime) / 1000}s][ 42.00%] Added ${allSymbolNodes.size} nodes to graph`);

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
        this.logs.log(`${edgesElapsed.toFixed(3)}s  50.00%: Generated ${edgeCount} file-level edges from ${fileRelations.size} file relations`);

        // シンボル間の関係エッジを追加（マルチビュー対応）
        let symbolEdgeCount = 0;
        relationships.forEach((rel) => {
            // 参照元と定義先のシンボルが両方存在する場合のみエッジを作成
            if (allSymbolNodes.has(rel.reference.id) && allSymbolNodes.has(rel.define.id)) {
                edges.push({
                    data: {
                        id: `symbol-relation-${rel.reference.id}-${rel.define.id}`,
                        source: rel.reference.id,
                        target: rel.define.id,
                        relationshipType: 'symbol-relationship'
                    }
                });
                symbolEdgeCount++;
            }
        });
        const symbolEdgesElapsed = (performance.now() - startTime) / 1000;
        this.logs.log(`${symbolEdgesElapsed.toFixed(3)}s  51.00%: Generated ${symbolEdgeCount} symbol-level edges from ${relationships.length} relationships`);

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
        this.logs.log(`${summaryElapsed.toFixed(3)}s  58.00%: Multi-view graph summary:`);
        this.logs.log(`${summaryElapsed.toFixed(3)}s  58.50%:   - Total nodes: ${nodes.length} (${fileSymbolCount} files, ${nodes.length - fileSymbolCount} symbols)`);
        this.logs.log(`${summaryElapsed.toFixed(3)}s  59.00%:   - Total edges: ${edges.length} (${edgeCount} file-level, ${symbolEdgeCount} symbol-level)`);
        this.logs.log(`${summaryElapsed.toFixed(3)}s  59.50%:   - Total symbols in files: ${totalSymbolCount}`);

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

    private createExportButton(viewName: string, isStandalone: boolean): string {
        if (isStandalone) {
            return `
                <div class="export-dropdown">
                    <button onclick="exportPNG()" title="Export PNG">Export PNG</button>
                </div>`;
        } else {
            return `
                <div class="export-dropdown">
                    <button class="export-main" title="Export File">
                        <i class="fa fa-floppy-o" aria-hidden="true"></i>
                    </button>
                    <button class="export-toggle" onclick="toggleExportMenu('${viewName}')" title="More export options">
                        <i class="fa fa-chevron-down" aria-hidden="true"></i>
                    </button>
                    <div class="export-menu" id="export-menu-${viewName}">
                        <button onclick="exportHTML(); closeExportMenu('${viewName}');" title="Export HTML">
                            <i class="fa fa-code" aria-hidden="true"></i>
                            <span>HTML</span>
                        </button>
                        <button onclick="exportPNG(); closeExportMenu('${viewName}');" title="Export PNG">
                            <i class="fa fa-picture-o" aria-hidden="true"></i>
                            <span>PNG</span>
                        </button>
                    </div>
                </div>`;
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
            'CYTOSCAPE_URI_PLACEHOLDER':        isStandalone
                ? 'https://unpkg.com/cytoscape@3.26.0/dist/cytoscape.min.js'
                : this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js')).toString(),
            // Note: Dagre layout calculation is now performed on extension side (Node.js)
            // Dagre library URIs are no longer needed in webview
            'GRAPH_MULTIVIEW_SCRIPT_URI_PLACEHOLDER': isStandalone
                ? `<script>${fs.readFileSync(path.join(this.extensionPath, 'dist', 'webview', 'graphMultiview.js'), 'utf8')}</script>`
                : `<script src="${this.panel!.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'graphMultiview.js')).toString()}"></script>`,

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
            'GRAPH_DATA_JS_URI_PLACEHOLDER':    '',  // 通常のWebviewでは使用しない

            'EXPORT_BUTTON_FILE_DEPS_PLACEHOLDER': this.createExportButton('file-deps', isStandalone),
            'EXPORT_BUTTON_HIERARCHY_PLACEHOLDER': this.createExportButton('hierarchy', isStandalone),
            'EXPORT_BUTTON_CALL_GRAPH_PLACEHOLDER': this.createExportButton('call-graph', isStandalone)
        };

        let result = template;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }

        return result;
    }

    private replacePlaceholdersWithDataJsUri(template: string, title: string, elements: any, dataJsFilename: string): string {
        // VSCodeのテーマ色を取得
        const isDarkTheme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const replacements: { [key: string]: string } = {
            'IS_STANDALONE_PLACEHOLDER':        'true',
            'TITLE_PLACEHOLDER':                title,
            'FONT_AWWSOME_CSS_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css',
            'FONT_AWESOME_WOFF2_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2',
            'FONT_AWESOME_WOFF_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.woff',
            'FONT_AWESOME_TTF_URI_PLACEHOLDER': 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/4.7.0/fonts/fontawesome-webfont.ttf',
            'CYTOSCAPE_URI_PLACEHOLDER':        'https://unpkg.com/cytoscape@3.26.0/dist/cytoscape.min.js',
            // Note: Dagre layout calculation is now performed on extension side (Node.js)
            // Standalone HTML exports use pre-calculated positions in data file
            'GRAPH_MULTIVIEW_SCRIPT_URI_PLACEHOLDER': `<script>${fs.readFileSync(path.join(this.extensionPath, 'dist', 'webview', 'graphMultiview.js'), 'utf8')}</script>`,

            'BACKGROUND_COLOR_PLACEHOLDER':     isDarkTheme ? '#1e1e1e' : '#ffffff',
            'PROGRESS_BG_COLOR_PLACEHOLDER':    isDarkTheme ? '#333' : '#e0e0e0',

            'CONTROLS_COLOR_PLACEHOLDER':       isDarkTheme ? '#cccccc' : '#333333',
            'CONTROLS_BG_PLACEHOLDER':          isDarkTheme ? '#2d2d30' : '#ffffff',
            'BOX_SHADOW_COLOR_PLACEHOLDER':     isDarkTheme ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.1)',
            'BORDER_STYLE_PLACEHOLDER':         isDarkTheme ? '1px solid #3e3e42' : '1px solid #e1e1e1',

            'BUTTON_NO_POINT_BG_PLACEHOLDER':   isDarkTheme ? '#0e639c' : '#007ACC',
            'BUTTON_HOVER_BG_PLACEHOLDER':      isDarkTheme ? '#1177bb' : '#005a9e',

            // データは空にして、代わりにデータJSファイルのURIを設定
            'ELEMENTS_PLACEHOLDER':             '[]',
            'ELEMENTS_NODES_LENGTH_PLACEHOLDER': '0',
            'ELEMENTS_EDGES_LENGTH_PLACEHOLDER': '0',
            'GRAPH_DATA_JS_URI_PLACEHOLDER':    dataJsFilename,

            'EXPORT_BUTTON_FILE_DEPS_PLACEHOLDER': this.createExportButton('file-deps', true),
            'EXPORT_BUTTON_HIERARCHY_PLACEHOLDER': this.createExportButton('hierarchy', true),
            'EXPORT_BUTTON_CALL_GRAPH_PLACEHOLDER': this.createExportButton('call-graph', true)
        };

        let result = template;
        for (const [placeholder, value] of Object.entries(replacements)) {
            result = result.replace(new RegExp(placeholder, 'g'), value);
        }

        return result;
    }

    private async exportStandaloneHTML(
        filename: string,
        data: { nodes: any[], edges: any[] },
        layoutPositions?: { [viewType: string]: Array<{id: string, x: number, y: number}> }
    ) {
        try {
            // 進捗を通知
            await this.updateExportProgress(60, 'Opening file save dialog...');

            // ファイル保存ダイアログを表示
            const saveUri = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.file(filename),
                filters: {
                    'HTML Files': ['html'],
                    'All Files': ['*']
                }
            });

            if (saveUri) {
                try {
                    // データファイルのパスを決定（HTMLと同じディレクトリ、同じベース名、.data.js拡張子）
                    const htmlPath = saveUri.fsPath;
                    const dataJsPath = htmlPath.replace(/\.html$/i, '.data.js');
                    const dataJsUri = vscode.Uri.file(dataJsPath);

                    // データJSファイル名（相対パス）
                    const dataJsFilename = path.basename(dataJsPath);

                    this.logs.log(`Exporting HTML to: ${htmlPath}`);
                    this.logs.log(`Exporting data to: ${dataJsPath}`);
                    this.logs.log(`Data size: ${data.nodes.length} nodes, ${data.edges.length} edges`);
                    if (layoutPositions) {
                        const hierarchyCount = layoutPositions['hierarchy']?.length || 0;
                        const callGraphCount = layoutPositions['call-graph']?.length || 0;
                        this.logs.log(`Layout positions: hierarchy=${hierarchyCount}, call-graph=${callGraphCount}`);
                    }

                    await this.updateExportProgress(70, 'Writing data file...');

                    // データをJavaScriptファイルとして保存（ストリーム書き込みを使用して大規模データに対応）
                    await this.writeDataJsFileInChunks(dataJsPath, data, layoutPositions);

                    this.logs.log(`Data JavaScript file saved to: ${dataJsPath}`);

                    await this.updateExportProgress(90, 'Writing HTML file...');

                    // HTMLテンプレートを生成（データは埋め込まず、JavaScriptファイルのURIを指定）
                    const html_load = this.loadHtmlTemplate(path.join(this.extensionPath, 'templates', 'graph-multiview.html'));
                    const emptyData = { nodes: [], edges: [] };
                    const html_text = this.replacePlaceholdersWithDataJsUri(html_load, locale('window-title') + ' - Standalone', emptyData, dataJsFilename);

                    // HTMLファイルに書き込み
                    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html_text, 'utf8'));

                    this.logs.log(`HTML file saved (${html_text.length} bytes)`);

                    // 完了通知
                    await this.notifyExportComplete();

                    // 成功メッセージを表示
                    const action = await vscode.window.showInformationMessage(
                        `HTML and data files exported to: ${htmlPath}`,
                        'Open File', 'Open in Browser'
                    );

                    if (action === 'Open File') {
                        const document = await vscode.workspace.openTextDocument(saveUri);
                        await vscode.window.showTextDocument(document);
                    } else if (action === 'Open in Browser') {
                        vscode.env.openExternal(saveUri);
                    }
                } catch (error) {
                    this.logs.error(`Export failed: ${error instanceof Error ? error.message : error}`);
                    vscode.window.showErrorMessage(`Export failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
                    // エラー時も完了通知を送る
                    await this.notifyExportComplete();
                }
            } else {
                // キャンセルされた場合も完了通知を送る
                this.logs.log('Export cancelled by user');
                await this.notifyExportComplete();
            }
        } catch (error) {
            this.logs.error(`Export failed: ${error instanceof Error ? error.message : error}`);
            await this.notifyExportComplete();
        }
    }

    private async updateExportProgress(percent: number, message: string): Promise<void> {
        if (this.panel) {
            try {
                await this.panel.webview.postMessage({
                    type: 'exportHTMLProgress',
                    percent: percent,
                    message: message
                });
                // UI更新のための短い待機
                await new Promise(resolve => setTimeout(resolve, 50));
            } catch (error) {
                this.logs.error(`Failed to update export progress: ${error instanceof Error ? error.message : error}`);
            }
        }
    }

    private async notifyExportComplete(): Promise<void> {
        if (this.panel) {
            try {
                await this.panel.webview.postMessage({
                    type: 'exportHTMLComplete'
                });
            } catch (error) {
                this.logs.error(`Failed to notify export complete: ${error instanceof Error ? error.message : error}`);
            }
        }
    }

    private async writeDataJsFileInChunks(
        filepath: string,
        data: { nodes: any[], edges: any[] },
        layoutPositions?: { [viewType: string]: Array<{id: string, x: number, y: number}> }
    ): Promise<void> {
        return new Promise((resolve, reject) => {
            try {
                const writeStream = fs.createWriteStream(filepath, { encoding: 'utf8' });

                writeStream.on('error', (error) => {
                    this.logs.error(`Data JS write stream error: ${error.message}`);
                    reject(error);
                });

                writeStream.on('finish', () => {
                    this.logs.log('Data JS write stream finished');
                    resolve();
                });

                // JavaScriptファイルの開始
                writeStream.write('// Graph data for standalone HTML\n');
                writeStream.write('window.GRAPH_DATA = {\n  "nodes": [\n');

                // ノードを1つずつ書き込み
                for (let i = 0; i < data.nodes.length; i++) {
                    const nodeJson = JSON.stringify(data.nodes[i]);
                    if (i < data.nodes.length - 1) {
                        writeStream.write('    ' + nodeJson + ',\n');
                    } else {
                        writeStream.write('    ' + nodeJson + '\n');
                    }

                    // 進捗ログ（1000件ごと）
                    if (i > 0 && i % 1000 === 0) {
                        this.logs.log(`Writing nodes: ${i}/${data.nodes.length}`);
                    }
                }

                writeStream.write('  ],\n  "edges": [\n');

                // エッジを1つずつ書き込み
                for (let i = 0; i < data.edges.length; i++) {
                    const edgeJson = JSON.stringify(data.edges[i]);
                    if (i < data.edges.length - 1) {
                        writeStream.write('    ' + edgeJson + ',\n');
                    } else {
                        writeStream.write('    ' + edgeJson + '\n');
                    }

                    // 進捗ログ（1000件ごと）
                    if (i > 0 && i % 1000 === 0) {
                        this.logs.log(`Writing edges: ${i}/${data.edges.length}`);
                    }
                }

                writeStream.write('  ]');

                // layoutPositionsを書き込み（存在する場合）
                if (layoutPositions && Object.keys(layoutPositions).length > 0) {
                    writeStream.write(',\n  "layoutPositions": {\n');
                    const viewTypes = Object.keys(layoutPositions);
                    viewTypes.forEach((viewType, viewIndex) => {
                        const positions = layoutPositions[viewType];
                        writeStream.write(`    "${viewType}": [\n`);

                        // 座標を1つずつ書き込み
                        for (let i = 0; i < positions.length; i++) {
                            const posJson = JSON.stringify(positions[i]);
                            if (i < positions.length - 1) {
                                writeStream.write('      ' + posJson + ',\n');
                            } else {
                                writeStream.write('      ' + posJson + '\n');
                            }

                            // 進捗ログ（1000件ごと）
                            if (i > 0 && i % 1000 === 0) {
                                this.logs.log(`Writing ${viewType} layout positions: ${i}/${positions.length}`);
                            }
                        }

                        const comma = viewIndex < viewTypes.length - 1 ? ',' : '';
                        writeStream.write(`    ]${comma}\n`);
                    });
                    writeStream.write('  }\n');
                    this.logs.log(`Written layout positions for ${viewTypes.length} view types`);
                } else {
                    writeStream.write('\n');
                }

                // JavaScriptファイルの終了
                writeStream.write('};\n');
                writeStream.end();

            } catch (error) {
                this.logs.error(`writeDataJsFileInChunks error: ${error instanceof Error ? error.message : error}`);
                reject(error);
            }
        });
    }

    /**
     * DuckDBを使って階層レベルを高速計算（トポロジカルソート版）
     * @param startTime 開始時刻（パフォーマンス測定用）
     * @returns ファイルパスと階層レベルのマップ
     */
    private async calculateHierarchyLevelsWithDuckDB(startTime: number): Promise<Map<string, number>> {
        const dbPath = path.join(this.wsFolder, '.vscode', 'crd.duckdb');

        if (!fs.existsSync(dbPath)) {
            this.logs.error('Database file not found for hierarchy calculation');
            return new Map();
        }

        try {
            const db = new codeDb.Db(dbPath);

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Calculating hierarchy levels using DuckDB (topological sort)...`);

            // まず、ファイル間の依存関係データがあるか確認（修正版）
            const checkQuery = `
                SELECT COUNT(*) as total_files,
                       (SELECT COUNT(DISTINCT s_ref.path)
                        FROM table_relationships r
                        JOIN table_symbols s_ref ON r.reference_id = s_ref.id
                        JOIN table_symbols s_def ON r.define_id = s_def.id
                        WHERE s_ref.path != s_def.path) as files_with_deps
                FROM table_symbols s
                WHERE s.kind = 0;
            `;
            const checkResult = await db.executeQuery<{ total_files: number; files_with_deps: number }>(checkQuery);
            if (checkResult.length > 0) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Files: ${checkResult[0].total_files}, Files with dependencies: ${checkResult[0].files_with_deps}`);
            }

            // トポロジカルソートによる真の階層レベル計算（修正版 + 深さ制限）
            // ファイルAがファイルBに依存 = ファイルA内のシンボルがファイルB内のシンボルを参照
            // レベル0: 他のファイルに依存していないファイル（基盤ファイル）
            // レベルN: 依存先ファイルの最大レベル + 1
            const query = `
                WITH RECURSIVE topology AS (
                    -- ベースケース: 依存先のないファイル（レベル0）
                    SELECT
                        s.path as file_path,
                        0 as level,
                        0 as iteration
                    FROM table_symbols s
                    WHERE s.kind = 0  -- ファイルのみ
                      AND NOT EXISTS (
                          -- このファイル内のシンボルが、他のファイルのシンボルを参照していない
                          SELECT 1
                          FROM table_symbols s_ref  -- このファイル内のシンボル
                          JOIN table_relationships r ON r.reference_id = s_ref.id
                          JOIN table_symbols s_def ON r.define_id = s_def.id
                          WHERE s_ref.path = s.path  -- このファイル内のシンボル
                            AND s_def.path != s.path  -- 異なるファイルのシンボルを参照
                      )

                    UNION ALL

                    -- 再帰ステップ: 依存先ファイルの最大レベル + 1
                    SELECT DISTINCT
                        s_ref.path as file_path,
                        t.level + 1 as level,
                        t.iteration + 1 as iteration
                    FROM table_symbols s_ref  -- 参照元ファイル内のシンボル
                    JOIN table_relationships r ON r.reference_id = s_ref.id
                    JOIN table_symbols s_def ON r.define_id = s_def.id  -- 参照先シンボル
                    JOIN topology t ON t.file_path = s_def.path  -- 参照先ファイル
                    WHERE s_ref.path != s_def.path  -- 異なるファイル間の参照のみ
                      AND t.iteration < 50  -- 深さ制限（循環参照対策）
                )
                SELECT
                    file_path,
                    MAX(level) as level  -- 複数パスがある場合は最大レベルを採用
                FROM topology
                GROUP BY file_path
                ORDER BY level, file_path;
            `;

            const rows = await db.executeQuery<{ file_path: string; level: number }>(query);
            const result = new Map<string, number>();
            for (const row of rows) {
                result.set(row.file_path, row.level);
            }

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Calculated hierarchy levels for ${result.size} files`);

            // レベル分布をログ出力
            const levelCounts = new Map<number, number>();
            let maxLevel = 0;
            for (const level of result.values()) {
                levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
                maxLevel = Math.max(maxLevel, level);
            }
            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Level distribution (0-${maxLevel}): ${Array.from(levelCounts.entries()).sort((a, b) => a[0] - b[0]).map(([l, c]) => `L${l}:${c}`).join(', ')}`);

            // トポロジカルソートの結果をチェック：異常な分布の場合はフォールバック
            const level0Count = levelCounts.get(0) || 0;
            const level0Ratio = result.size > 0 ? level0Count / result.size : 1;
            const maxLevelCount = levelCounts.get(maxLevel) || 0;
            const maxLevelRatio = result.size > 0 ? maxLevelCount / result.size : 0;

            // フォールバック条件：
            // 1. 80%以上がレベル0（依存関係が取得できていない）
            // 2. 最高レベルが30以上（循環参照でiteration制限に到達）
            // 3. 最高レベルに80%以上集中（トポロジカルソートが破綻）
            const needsFallback = (level0Ratio > 0.8 || maxLevel >= 30 || maxLevelRatio > 0.8) && result.size > 10;

            if (needsFallback) {
                if (level0Ratio > 0.8) {
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s] ⚠️  Warning: ${(level0Ratio * 100).toFixed(1)}% of files are at level 0. Using dependency-count fallback...`);
                } else if (maxLevel >= 30) {
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s] ⚠️  Warning: Max level is ${maxLevel} (likely circular dependencies). Using dependency-count fallback...`);
                } else {
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s] ⚠️  Warning: ${(maxLevelRatio * 100).toFixed(1)}% of files are at level ${maxLevel}. Using dependency-count fallback...`);
                }

                const fallbackQuery = `
                    WITH file_dependencies AS (
                        SELECT
                            s_file.path as file_path,
                            COUNT(DISTINCT s_def.path) as dependency_count
                        FROM table_symbols s_file
                        LEFT JOIN table_symbols s_ref ON s_ref.path = s_file.path  -- このファイル内のシンボル
                        LEFT JOIN table_relationships r ON r.reference_id = s_ref.id
                        LEFT JOIN table_symbols s_def ON r.define_id = s_def.id
                            AND s_def.path != s_file.path  -- 異なるファイルを参照
                        WHERE s_file.kind = 0  -- ファイルレベル
                        GROUP BY s_file.path
                    ),
                    level_ranges AS (
                        SELECT
                            MAX(dependency_count) as max_deps,
                            MIN(dependency_count) as min_deps
                        FROM file_dependencies
                    )
                    SELECT
                        fd.file_path,
                        CASE
                            WHEN lr.max_deps = lr.min_deps THEN 0
                            ELSE CAST(
                                199.0 * (fd.dependency_count - lr.min_deps) /
                                (lr.max_deps - lr.min_deps) AS INTEGER
                            )
                        END as level
                    FROM file_dependencies fd
                    CROSS JOIN level_ranges lr
                    ORDER BY level, file_path;
                `;

                const fallbackRows = await db.executeQuery<{ file_path: string; level: number }>(fallbackQuery);
                result.clear();
                for (const row of fallbackRows) {
                    result.set(row.file_path, row.level);
                }

                // フォールバック結果のレベル分布を再計算
                levelCounts.clear();
                maxLevel = 0;
                for (const level of result.values()) {
                    levelCounts.set(level, (levelCounts.get(level) || 0) + 1);
                    maxLevel = Math.max(maxLevel, level);
                }
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Fallback level distribution (0-${maxLevel}): ${Array.from(levelCounts.entries()).sort((a, b) => a[0] - b[0]).map(([l, c]) => `L${l}:${c}`).join(', ')}`);
            }

            // デバッグ: 各レベルのサンプルファイルを表示
            if (result.size > 0) {
                const samplesByLevel = new Map<number, string[]>();
                for (const [filepath, level] of result.entries()) {
                    if (!samplesByLevel.has(level)) {
                        samplesByLevel.set(level, []);
                    }
                    if (samplesByLevel.get(level)!.length < 3) {
                        samplesByLevel.get(level)!.push(filepath);
                    }
                }
                for (const [level, samples] of Array.from(samplesByLevel.entries()).sort((a, b) => a[0] - b[0])) {
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s]   Level ${level} samples: ${samples.join(', ')}`);
                }
            }

            // データベース接続を閉じる
            db.dispose();

            return result;
        } catch (error) {
            this.logs.error(`Failed to calculate hierarchy levels with DuckDB: ${error instanceof Error ? error.message : error}`);
            return new Map();
        }
    }

    /**
     * 階層構造ビュー用のレイアウトを計算（ハイブリッド戦略）
     * @param elements ノードとエッジのデータ
     * @param startTime 開始時刻（パフォーマンス測定用）
     * @returns ノードIDと座標のマップ
     */
    private async calculateHierarchyLayout(elements: any, startTime: number): Promise<Map<string, dagreLayout.Position>> {
        try {
            const nodeCount = elements.nodes.length;
            const edgeCount = elements.edges.length;

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Calculating hierarchy layout for ${nodeCount} nodes, ${edgeCount} edges...`);

            // ハイブリッド戦略の閾値
            const SMALL_DAGRE_NODE_LIMIT = 3000;   // 小規模: Dagreで美しい配置
            const SMALL_DAGRE_EDGE_LIMIT = 15000;
            const HierarchyView_LIMIT_ONLY_FILE = 15000;

            // ファイルレベルのノードのみを抽出（kind=0）または全ノード
            const showOnlyFiles = nodeCount > HierarchyView_LIMIT_ONLY_FILE;
            const layoutNodes = showOnlyFiles
                ? elements.nodes.filter((n: any) => n.data.kind === 0)
                : elements.nodes;

            const actualNodeCount = layoutNodes.length;
            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Using ${actualNodeCount} nodes (${showOnlyFiles ? 'files only' : 'all symbols'})`);

            // データサイズに応じて最適な手法を選択
            if (actualNodeCount < SMALL_DAGRE_NODE_LIMIT && edgeCount < SMALL_DAGRE_EDGE_LIMIT) {
                // 小規模データ: Dagreで最高品質のレイアウト
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Small dataset detected. Using Dagre layout for optimal quality...`);
                return await this.calculateHierarchyLayoutWithDagre(elements, startTime, layoutNodes, showOnlyFiles);
            } else {
                // 中規模・大規模データ: DuckDBで高速レイアウト
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Medium/Large dataset detected. Using DuckDB layout for performance...`);
                return await this.calculateHierarchyLayoutWithDuckDB_Simple(elements, startTime, layoutNodes);
            }
        } catch (error) {
            this.logs.error(`Failed to calculate hierarchy layout: ${error instanceof Error ? error.message : error}`);
            console.error('Hierarchy layout error:', error);
            return new Map();
        }
    }

    /**
     * エッジの統計情報を分析（仮説検証用）
     * @param edges エッジリスト
     * @param positions ノード座標
     * @param startTime 開始時刻
     */
    private analyzeEdgeStatistics(edges: any[], positions: Map<string, dagreLayout.Position>, startTime: number): void {
        let totalLength = 0;
        let totalDeltaX = 0;
        let totalAbsDeltaX = 0;
        let totalDeltaY = 0;
        let verticalCount = 0;  // deltaX < 200px（ほぼ垂直）のエッジ数
        let validEdgeCount = 0;

        for (const edge of edges) {
            const sourcePos = positions.get(edge.data.source);
            const targetPos = positions.get(edge.data.target);

            if (sourcePos && targetPos) {
                const deltaX = targetPos.x - sourcePos.x;
                const deltaY = targetPos.y - sourcePos.y;
                const length = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

                totalLength += length;
                totalDeltaX += deltaX;
                totalAbsDeltaX += Math.abs(deltaX);
                totalDeltaY += Math.abs(deltaY);
                validEdgeCount++;

                // ほぼ垂直なエッジ（X方向の距離が1ノード分以下）
                if (Math.abs(deltaX) < 200) {
                    verticalCount++;
                }
            }
        }

        if (validEdgeCount > 0) {
            const avgLength = totalLength / validEdgeCount;
            const avgDeltaX = totalDeltaX / validEdgeCount;
            const avgAbsDeltaX = totalAbsDeltaX / validEdgeCount;
            const avgDeltaY = totalDeltaY / validEdgeCount;
            const verticalRatio = (verticalCount / validEdgeCount) * 100;

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Edge Statistics (${validEdgeCount} edges):`);
            this.logs.log(`[${(performance.now() - startTime) / 1000}s]   - Avg length: ${avgLength.toFixed(1)}px`);
            this.logs.log(`[${(performance.now() - startTime) / 1000}s]   - Avg deltaX: ${avgDeltaX.toFixed(1)}px (bias indicator)`);
            this.logs.log(`[${(performance.now() - startTime) / 1000}s]   - Avg |deltaX|: ${avgAbsDeltaX.toFixed(1)}px`);
            this.logs.log(`[${(performance.now() - startTime) / 1000}s]   - Avg |deltaY|: ${avgDeltaY.toFixed(1)}px`);
            this.logs.log(`[${(performance.now() - startTime) / 1000}s]   - Vertical edges (|deltaX|<200): ${verticalRatio.toFixed(1)}%`);
        }
    }

    /**
     * ノードの依存先の重心X座標を計算（重み付きバリセントリック法）
     * @param nodeId ノードID
     * @param dependencyMap 依存関係マップ（source -> Map<target, weight>）
     * @param positions 既に配置されたノードの座標
     * @returns 重心X座標（依存先がない場合は0）
     */
    private calculateCentroid(nodeId: string, dependencyMap: Map<string, Map<string, number>>, positions: Map<string, dagreLayout.Position>): number {
        const dependencies = dependencyMap.get(nodeId);
        if (!dependencies || dependencies.size === 0) {
            // 依存先がない場合は0（中央）
            return 0;
        }

        let weightedSumX = 0;
        let totalWeight = 0;
        for (const [targetId, weight] of dependencies.entries()) {
            const pos = positions.get(targetId);
            if (pos) {
                // エッジの重み（関係数）を考慮した重み付き平均
                weightedSumX += pos.x * weight;
                totalWeight += weight;
            }
        }

        if (totalWeight === 0) {
            // 依存先が未配置の場合は0（中央）
            return 0;
        }

        // 重み付き平均X座標（重心）
        return weightedSumX / totalWeight;
    }

    /**
     * DuckDBベースのシンプルな階層レイアウト計算（中規模・大規模データ用）
     * @param elements ノードとエッジのデータ
     * @param startTime 開始時刻（パフォーマンス測定用）
     * @param layoutNodes レイアウト対象のノード
     * @returns ノードIDと座標のマップ
     */
    private async calculateHierarchyLayoutWithDuckDB_Simple(elements: any, startTime: number, layoutNodes: any[]): Promise<Map<string, dagreLayout.Position>> {
        try {
            // DuckDBを使って階層レベルを高速計算
            const hierarchyLevels = await this.calculateHierarchyLevelsWithDuckDB(startTime);

            if (hierarchyLevels.size === 0) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] No hierarchy levels calculated. Using fallback layout.`);
                return new Map();
            }

            // レベルごとにノードをグループ化
            const nodesByLevel = new Map<number, any[]>();
            for (const node of layoutNodes) {
                const filePath = node.data.path || node.data.id;
                const level = hierarchyLevels.get(filePath) ?? 0;

                if (!nodesByLevel.has(level)) {
                    nodesByLevel.set(level, []);
                }
                nodesByLevel.get(level)!.push(node);
            }

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Assigning positions based on hierarchy levels...`);

            // レイアウト対象ノードのIDセットを作成（ファイルのみ）
            const layoutNodeIds = new Set(layoutNodes.map(n => n.data.id));

            // file-levelエッジのみから重み付き依存関係マップを作成（エッジ交差最小化のため）
            // エッジの重み（関係数）を考慮して、強く接続されたノードを近くに配置
            const dependencyMap = new Map<string, Map<string, number>>();
            let fileLevelEdgeCount = 0;
            for (const edge of elements.edges) {
                const source = edge.data.source;
                const target = edge.data.target;
                const weight = edge.data.relationshipCount || 1;  // 関係数を重みとして使用

                // sourceとtargetの両方がレイアウト対象ノード（ファイル）の場合のみ追加
                if (layoutNodeIds.has(source) && layoutNodeIds.has(target)) {
                    if (!dependencyMap.has(source)) {
                        dependencyMap.set(source, new Map());
                    }
                    dependencyMap.get(source)!.set(target, weight);
                    fileLevelEdgeCount++;
                }
            }
            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Using ${fileLevelEdgeCount} file-level edges for weighted barycentric method`);

            // 逆方向の依存関係マップを作成（依存元を追跡、重み付き）
            const reverseDependencyMap = new Map<string, Map<string, number>>();
            for (const [source, targets] of dependencyMap.entries()) {
                for (const [target, weight] of targets.entries()) {
                    if (!reverseDependencyMap.has(target)) {
                        reverseDependencyMap.set(target, new Map());
                    }
                    reverseDependencyMap.get(target)!.set(source, weight);
                }
            }

            // 孤立ノード（エッジが全く無いノード）を検出して、一番下のレベルに移動
            const isolatedNodes: any[] = [];
            for (const node of layoutNodes) {
                const nodeId = node.data.id;
                const hasOutgoing = dependencyMap.has(nodeId) && dependencyMap.get(nodeId)!.size > 0;
                const hasIncoming = reverseDependencyMap.has(nodeId) && reverseDependencyMap.get(nodeId)!.size > 0;

                if (!hasOutgoing && !hasIncoming) {
                    isolatedNodes.push(node);
                }
            }

            // 孤立ノードを元のレベルから削除し、新しいレベル-1に配置
            if (isolatedNodes.length > 0) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Found ${isolatedNodes.length} isolated nodes (no edges), moving to bottom level`);

                // 各レベルから孤立ノードを削除
                for (const [level, nodes] of nodesByLevel.entries()) {
                    const filteredNodes = nodes.filter(n => !isolatedNodes.includes(n));
                    if (filteredNodes.length > 0) {
                        nodesByLevel.set(level, filteredNodes);
                    } else {
                        nodesByLevel.delete(level);
                    }
                }

                // 孤立ノードを新しいレベル-1に配置（一番下）
                nodesByLevel.set(-1, isolatedNodes);
            }

            // レベルに基づいて座標を割り当て（重み付きバリセントリック法でエッジ交差最小化）
            const positions = new Map<string, dagreLayout.Position>();
            const levelHeight = 150;  // レベル間の垂直間隔

            // Y軸を反転：レベル0（定義提供）を下部、レベルN（参照多）を上部に配置
            // ノードがあるレベルのみを抽出して圧縮（空レベルをスキップ）
            // レベルを昇順にソート（低レベルから高レベルへ）
            // これにより、各ノードを配置する時点で、その依存先（低レベル）が既に配置されている
            const sortedLevels = Array.from(nodesByLevel.entries()).sort((a, b) => a[0] - b[0]);
            const maxCompactedLevel = sortedLevels.length - 1;

            // 各レベルのノード数に応じて可変のnodeWidthを計算（エッジの重なり削減）
            // 全レベルが同じ最大幅に収まるように調整
            const maxNodesInLevel = Math.max(...sortedLevels.map(([_, nodes]) => nodes.length));
            const TARGET_MAX_WIDTH = 30000;  // 全レベルの目標最大幅（px）
            const MIN_NODE_WIDTH = 100;      // 最小ノード間隔（px）
            const MAX_NODE_WIDTH = 400;      // 最大ノード間隔（px）

            // 各レベルのnodeWidthを計算
            const nodeWidthPerLevel = new Map<number, number>();
            for (const [level, nodes] of sortedLevels) {
                if (nodes.length === 1) {
                    // 1ノードの場合は幅0だが、計算上はMAX_NODE_WIDTHを使用
                    nodeWidthPerLevel.set(level, MAX_NODE_WIDTH);
                } else {
                    // レベル幅 = TARGET_MAX_WIDTH / (ノード数 - 1)
                    const width = TARGET_MAX_WIDTH / (nodes.length - 1);
                    // 最小値と最大値でクランプ
                    const clampedWidth = Math.max(MIN_NODE_WIDTH, Math.min(MAX_NODE_WIDTH, width));
                    nodeWidthPerLevel.set(level, clampedWidth);
                }
            }

            // デバッグ用：各レベルのnodeWidthをログ出力
            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Variable nodeWidth per level (max=${maxNodesInLevel} nodes, target width=${TARGET_MAX_WIDTH}px):`);
            let logCount = 0;
            for (const [level, nodes] of sortedLevels) {
                if (logCount < 5 || nodes.length > 50) {
                    const width = nodeWidthPerLevel.get(level)!;
                    const totalWidth = (nodes.length - 1) * width;
                    this.logs.log(`[${(performance.now() - startTime) / 1000}s]   Level ${level}: ${nodes.length} nodes, nodeWidth=${width.toFixed(0)}px, total width=${totalWidth.toFixed(0)}px`);
                    logCount++;
                }
            }

            // 最大レベル幅を計算（可変nodeWidthを考慮）
            let maxLevelWidth = 0;
            for (const [level, nodes] of sortedLevels) {
                const width = nodeWidthPerLevel.get(level)!;
                const levelWidth = (nodes.length - 1) * width;
                maxLevelWidth = Math.max(maxLevelWidth, levelWidth);
            }

            // 初期配置：レベルを下から上（低レベルから高レベル）に処理
            sortedLevels.forEach(([originalLevel, nodes], compactedIndex) => {
                const y = (maxCompactedLevel - compactedIndex) * levelHeight;
                const nodeWidth = nodeWidthPerLevel.get(originalLevel)!;  // このレベルのnodeWidth

                // バリセントリック法：依存先ノードの重心X座標に基づいてソート
                const sortedNodes = nodes.sort((a, b) => {
                    const centroidA = this.calculateCentroid(a.data.id, dependencyMap, positions);
                    const centroidB = this.calculateCentroid(b.data.id, dependencyMap, positions);

                    if (Math.abs(centroidA - centroidB) < 0.1) {
                        const pathA = a.data.path || a.data.id;
                        const pathB = b.data.path || b.data.id;
                        const dirA = path.dirname(pathA);
                        const dirB = path.dirname(pathB);
                        if (dirA !== dirB) {
                            return dirA.localeCompare(dirB);
                        }
                        return path.basename(pathA).localeCompare(path.basename(pathB));
                    }

                    return centroidA - centroidB;
                });

                // 各レベルのノードを中央揃えで配置（エッジ長の最小化、可変nodeWidth）
                const levelWidth = (sortedNodes.length - 1) * nodeWidth;
                const levelOffset = (maxLevelWidth - levelWidth) / 2;  // 中央揃えのオフセット

                sortedNodes.forEach((node, index) => {
                    const x = levelOffset + index * nodeWidth;
                    positions.set(node.data.id, { x, y });
                });
            });

            // バリセントリック法を反復適用してエッジの長さを最小化（4回の最適化パス）
            const OPTIMIZATION_ITERATIONS = 4;
            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Starting ${OPTIMIZATION_ITERATIONS} optimization passes...`);

            for (let iter = 0; iter < OPTIMIZATION_ITERATIONS; iter++) {
                // 下から上へのパス（依存先の重心に基づいて調整）
                for (let i = 0; i < sortedLevels.length; i++) {
                    const [level, nodes] = sortedLevels[i];
                    const nodeWidth = nodeWidthPerLevel.get(level)!;  // このレベルのnodeWidth

                    const sortedNodes = nodes.sort((a, b) => {
                        const centroidA = this.calculateCentroid(a.data.id, dependencyMap, positions);
                        const centroidB = this.calculateCentroid(b.data.id, dependencyMap, positions);
                        return centroidA - centroidB;
                    });

                    const y = positions.get(sortedNodes[0].data.id)!.y;
                    const levelWidth = (sortedNodes.length - 1) * nodeWidth;
                    const levelOffset = (maxLevelWidth - levelWidth) / 2;

                    sortedNodes.forEach((node, index) => {
                        const x = levelOffset + index * nodeWidth;
                        positions.set(node.data.id, { x, y });
                    });
                }

                // 上から下へのパス（依存元の重心に基づいて調整）
                for (let i = sortedLevels.length - 1; i >= 0; i--) {
                    const [level, nodes] = sortedLevels[i];
                    const nodeWidth = nodeWidthPerLevel.get(level)!;  // このレベルのnodeWidth

                    const sortedNodes = nodes.sort((a, b) => {
                        const centroidA = this.calculateCentroid(a.data.id, reverseDependencyMap, positions);
                        const centroidB = this.calculateCentroid(b.data.id, reverseDependencyMap, positions);
                        return centroidA - centroidB;
                    });

                    const y = positions.get(sortedNodes[0].data.id)!.y;
                    const levelWidth = (sortedNodes.length - 1) * nodeWidth;
                    const levelOffset = (maxLevelWidth - levelWidth) / 2;

                    sortedNodes.forEach((node, index) => {
                        const x = levelOffset + index * nodeWidth;
                        positions.set(node.data.id, { x, y });
                    });
                }
            }

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Optimization complete (${OPTIMIZATION_ITERATIONS} iterations)`);

            // 全体の配置を中央に調整（左偏り解消 + エッジ長最適化）
            if (positions.size > 0) {
                // 全ノードのX座標の範囲を計算
                let minX = Infinity, maxX = -Infinity;
                for (const pos of positions.values()) {
                    minX = Math.min(minX, pos.x);
                    maxX = Math.max(maxX, pos.x);
                }

                // 全体の中心を0にするオフセットを計算
                const centerOffset = -(minX + maxX) / 2;

                // 全ノードを中央にシフト
                const centeredPositions = new Map<string, dagreLayout.Position>();
                for (const [id, pos] of positions.entries()) {
                    centeredPositions.set(id, { x: pos.x + centerOffset, y: pos.y });
                }

                // エッジの統計情報を計算（仮説検証用）
                this.analyzeEdgeStatistics(elements.edges, centeredPositions, startTime);

                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Hierarchy layout calculation complete: ${centeredPositions.size} positions (centered: offset=${centerOffset.toFixed(1)}, range: ${minX.toFixed(0)} to ${maxX.toFixed(0)})`);

                return centeredPositions;
            }

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Hierarchy layout calculation complete: ${positions.size} positions`);

            return positions;
        } catch (error) {
            this.logs.error(`Failed to calculate hierarchy layout: ${error instanceof Error ? error.message : error}`);
            console.error('Hierarchy layout error:', error);
            return new Map();
        }
    }

    /**
     * 階層構造ビュー用のDagreレイアウトを計算（小規模データ用）
     * @param elements ノードとエッジのデータ
     * @param startTime 開始時刻（パフォーマンス測定用）
     * @param layoutNodes レイアウト対象のノード
     * @param showOnlyFiles ファイルレベルのみ表示するか
     * @returns ノードIDと座標のマップ
     */
    private async calculateHierarchyLayoutWithDagre(elements: any, startTime: number, layoutNodes: any[], showOnlyFiles: boolean): Promise<Map<string, dagreLayout.Position>> {
        try {
            const edgeCount = elements.edges.length;

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Calculating Dagre layout for ${layoutNodes.length} nodes, ${edgeCount} edges...`);

            // Dagreレイアウトの制限値
            const HierarchyView_DAGRE_LAYOUT_LIMIT_NODES = 5000;
            const HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES = 20000;

            // 階層構造ビューでは、親子関係をエッジとして使用
            // Dagreは親子関係（parent プロパティ）ではなく、エッジベースで階層を計算するため、
            // parentプロパティを持つノードから親へのエッジを生成する
            const parentChildEdges: Array<{source: string, target: string}> = [];

            layoutNodes.forEach((n: any) => {
                if (n.data.parent) {
                    // 親から子へのエッジを追加（Dagreは親→子の方向で階層を作成）
                    parentChildEdges.push({
                        source: n.data.parent,
                        target: n.data.id
                    });
                }
            });

            // ファイルレベルまたはシンボルレベルの依存関係エッジも追加
            let relationshipEdges;
            if (showOnlyFiles) {
                // ファイルレベルのみの場合は、ファイル間の関係
                relationshipEdges = elements.edges.filter((e: any) =>
                    e.data.relationshipType === 'file-relationship'
                ).map((e: any) => ({
                    source: e.data.source,
                    target: e.data.target
                }));
            } else {
                // シンボルレベルの場合は、シンボル間の関係（file-relationship以外）
                relationshipEdges = elements.edges.filter((e: any) =>
                    e.data.relationshipType !== 'file-relationship'
                ).map((e: any) => ({
                    source: e.data.source,
                    target: e.data.target
                }));
            }

            // 実際にレイアウトするノード数とエッジ数を取得
            const actualNodeCount = layoutNodes.length;
            let actualEdgeCount = parentChildEdges.length + relationshipEdges.length;

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Using ${actualNodeCount} nodes (${showOnlyFiles ? 'files only' : 'all symbols'})`);
            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Parent-child edges: ${parentChildEdges.length}, Relationship edges: ${relationshipEdges.length}, Total: ${actualEdgeCount}`);

            // エッジ数が多すぎる場合はサンプリング
            if (actualEdgeCount > HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Too many edges (${actualEdgeCount}). Sampling to ${HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES} edges for layout calculation.`);

                // エッジをサンプリング（ランダムサンプリング）
                const samplingRatio = HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES / actualEdgeCount;
                const sampledRelationshipEdges = relationshipEdges.filter(() => {
                    return Math.random() < samplingRatio;
                }).slice(0, HierarchyView_DAGRE_LAYOUT_LIMIT_EDGES - parentChildEdges.length);

                relationshipEdges = sampledRelationshipEdges;
                actualEdgeCount = parentChildEdges.length + relationshipEdges.length;

                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Sampled edges: ${actualEdgeCount} (${parentChildEdges.length} parent-child + ${relationshipEdges.length} relationship)`);
            }

            // データセットサイズに応じてレイアウト計算の可否を判定（抽出後の実際の要素数で判定）
            if (actualNodeCount > HierarchyView_DAGRE_LAYOUT_LIMIT_NODES) {
                // ノード数が多すぎる場合はCOSEレイアウトを使用（Webview側で計算）
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Too many nodes (${actualNodeCount}). Using COSE layout on webview side.`);
                return new Map();
            }

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Sample nodes: ${layoutNodes.slice(0, 3).map((n: any) => `${n.data.label} (kind=${n.data.kind}, parent=${n.data.parent || 'none'})`).join(', ')}`);

            // Dagreレイアウトを計算
            const nodes: dagreLayout.LayoutNode[] = layoutNodes.map((n: any) => ({
                id: n.data.id,
                label: n.data.label,
                kind: n.data.kind
            }));

            // 親子関係エッジと依存関係エッジを結合
            // 親子関係エッジを優先（階層構造の主要な構造）
            const edges: dagreLayout.LayoutEdge[] = [
                ...parentChildEdges,
                ...relationshipEdges
            ];

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Total edges for Dagre: ${edges.length} (parent-child + relationship)`);
            if (edges.length > 0 && edges.length <= 5) {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Sample edges: ${edges.map(e => `${e.source}->${e.target}`).join(', ')}`);
            }

            // プログレスコールバック
            const progressCallback: dagreLayout.ProgressCallback = (percent, message) => {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Hierarchy layout: ${message} (${percent}%)`);
            };

            // レイアウト計算を実行
            const positions = await dagreLayout.calculateDagreLayout(
                nodes,
                edges,
                {
                    rankDir: 'TB',
                    nodeSep: 50,
                    rankSep: 100,
                    ranker: 'tight-tree'  // 高速化
                },
                progressCallback
            );

            // Y軸を反転：レベル0（定義提供）を下部、レベルN（参照多）を上部に配置
            const maxY = Math.max(...Array.from(positions.values()).map(pos => pos.y));
            const flippedPositions = new Map<string, dagreLayout.Position>();
            for (const [id, pos] of positions.entries()) {
                flippedPositions.set(id, { x: pos.x, y: maxY - pos.y });
            }

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Hierarchy layout calculation complete: ${flippedPositions.size} positions`);

            return flippedPositions;
        } catch (error) {
            this.logs.error(`Failed to calculate hierarchy layout: ${error instanceof Error ? error.message : error}`);
            console.error('Hierarchy layout error:', error);
            return new Map();
        }
    }

    /**
     * 呼び出しグラフビュー用のDagreレイアウトを計算
     * @param elements ノードとエッジのデータ
     * @param startTime 開始時刻（パフォーマンス測定用）
     * @returns ノードIDと座標のマップ
     */
    private async calculateCallGraphLayout(elements: any, startTime: number): Promise<Map<string, dagreLayout.Position>> {
        try {
            const nodeCount = elements.nodes.length;
            const edgeCount = elements.edges.length;

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Calculating call graph layout for ${nodeCount} nodes, ${edgeCount} edges...`);

            // 新しい制限値を適用
            const CallGraphView_LIMIT_ONLY_FILE = 15000;
            const CallGraphView_DAGRE_LAYOUT_LIMIT_NODES = 10000;
            const CallGraphView_DAGRE_LAYOUT_LIMIT_EDGES = 15000;

            // ファイルレベルのノードのみを抽出（kind=0）または全ノード
            const showOnlyFiles = nodeCount > CallGraphView_LIMIT_ONLY_FILE;
            const layoutNodes = showOnlyFiles
                ? elements.nodes.filter((n: any) => n.data.kind === 0)
                : elements.nodes;

            // シンボルレベルのエッジを抽出
            const layoutEdges = elements.edges.filter((e: any) =>
                e.data.relationshipType === 'symbol-relationship'
            );

            // 実際にレイアウトするノード数とエッジ数を取得
            const actualNodeCount = layoutNodes.length;
            const actualEdgeCount = layoutEdges.length;

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Using ${actualNodeCount} nodes (${showOnlyFiles ? 'files only' : 'all symbols'}) and ${actualEdgeCount} edges for layout calculation`);

            // データセットサイズに応じてレイアウト計算の可否を判定（抽出後の実際の要素数で判定）
            if (actualNodeCount > CallGraphView_DAGRE_LAYOUT_LIMIT_NODES || actualEdgeCount > CallGraphView_DAGRE_LAYOUT_LIMIT_EDGES) {
                // 大規模すぎる場合はCOSEレイアウトを使用（Webview側で計算）
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Dataset too large for Dagre (nodes: ${actualNodeCount}, edges: ${actualEdgeCount}). Using COSE layout on webview side.`);
                return new Map();
            }

            // Dagreレイアウトを計算
            const nodes: dagreLayout.LayoutNode[] = layoutNodes.map((n: any) => ({
                id: n.data.id,
                label: n.data.label,
                kind: n.data.kind
            }));

            const edges: dagreLayout.LayoutEdge[] = layoutEdges.map((e: any) => ({
                source: e.data.source,
                target: e.data.target
            }));

            // プログレスコールバック
            const progressCallback: dagreLayout.ProgressCallback = (percent, message) => {
                this.logs.log(`[${(performance.now() - startTime) / 1000}s] Call graph layout: ${message} (${percent}%)`);
            };

            // レイアウト計算を実行
            const positions = await dagreLayout.calculateDagreLayout(
                nodes,
                edges,
                {
                    rankDir: 'TB',
                    nodeSep: 40,
                    rankSep: 80,
                    ranker: 'tight-tree'  // 高速化
                },
                progressCallback
            );

            this.logs.log(`[${(performance.now() - startTime) / 1000}s] Call graph layout calculation complete: ${positions.size} positions`);

            return positions;
        } catch (error) {
            this.logs.error(`Failed to calculate call graph layout: ${error instanceof Error ? error.message : error}`);
            console.error('Call graph layout error:', error);
            return new Map();
        }
    }


    public dispose() {
        if (this.panel) {
            this.panel.dispose();
            this.panel = null;
        }
    }
}
