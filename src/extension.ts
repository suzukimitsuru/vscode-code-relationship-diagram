/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFile from './codeFiles';
import * as codeSymbols from './codeSymbols';
import * as codeReferences from './codeReferences';
import { GraphVisualization } from './graphVisualization';

let _logs: Logs | null = null;

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	const logs = _logs = new Logs(context.extension.packageJSON?.displayName);
	const platform = process.platform;  // 'darwin' / 'win32' / 'linux'
	const arch = process.arch;          // 'x64' / 'arm64'
	logs.log(`extension is now active! Node.js:${process.version}, VSCode:${vscode.version}, Platform:${platform}-${arch}`);

	// 初期化するコマンドの登録
	const initializeDisposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.initialize', async () => {

		// ワークスペースが在り、ファイルの関連付けのパターンが在ったら
		const workspace_folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders : [];
		const root_folder = selectRootFolder(workspace_folders);
		const associations = readConfiguration(vscode.workspace.getConfiguration("files").get<object>("associations"));
		if (root_folder && (Object.keys(associations).length > 0)) {
			const db_file = path.join(root_folder.uri.fsPath, '.vscode', 'crd.duckdb');
			try {
				// コード関係図DBを作成する
				const db = new codeDb.Db(db_file);
				await db.table_create();
				try {
					const start = performance.now();

					// コードファイルを列挙する
					const files: codeFile.File[] = [];
					const patterns = codeFile.list(root_folder.uri.fsPath, associations, (file: codeFile.File) => {
						files.push(file);
						logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: list ${file.relative_path}`);
					});

					// コードファイルをパスでソートする
					const sorted = files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

					// コードファイルテーブルの変更を抽出する
					const rows = await db.codeFile_queryAll();
					const [upserts, removes] = codeFile.updates(sorted, rows);

					// コードファイルを更新する
					for (const upsert of upserts) {
						try {
							await db.codeFile_upsert(upsert.relative_path, upsert.updated);
							logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: upsert ${upsert.relative_path}`);
						} catch (error) {
							logs.trace(`db.codeFile_upsert(${upsert.relative_path}): ${error instanceof Error ? error.message : error}`);
						}
					}

					// コードファイルを削除する
					for (const remove of removes) {
						try {
							await db.codeFile_remove(remove);
							logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: remove ${remove}`);
						} catch (error) {
							logs.trace(`db.codeFile_remove(${remove}): ${error instanceof Error ? error.message : error}`);
						}
					}

					for (const file of sorted) {
						try {
							// コードファイルのシンボルを読み込む
							const fullname = path.join(root_folder.uri.fsPath, file.relative_path);
							const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullname));
							const symbol = await codeSymbols.load(file.relative_path, document);
							if (symbol) {
								// シンボルをDBにアップサートする
								await db.symbol_upsert(symbol);
								logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: load symbol ${symbol.path}`);
								
								// シンボル参照関係を抽出
								const references = await codeReferences.extractReferences(document, symbol.id, db, root_folder.uri.fsPath);
								for (const ref of references) {
									await db.symbolReference_upsert(ref);
								}
								if (references.length > 0) {
									logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: extracted ${references.length} references from ${symbol.path}`);
								}
							}
						} catch (error) {
							logs.trace(`codeSymbols.load(${file.relative_path}): ${error instanceof Error ? error.message : error}`);
						}
					}
					
					// DBを破棄する
					db.dispose();

					logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: processed ${files.length} files, upserted ${upserts.length} files, removed ${removes.length} files`);

					// 初期化メッセージを表示する
					logs.info(locale('initialize-message'));
				} catch (error) {
					logs.trace(`codeFile.list(${root_folder.uri.fsPath}): ${error instanceof Error ? error.message : error}`);
				}
			} catch (error) {
				logs.trace(`db.table_create(${db_file}): ${error instanceof Error ? error.message : error}`);
			}
		} else {
			logs.error(locale('error-no-associations'));
		}
	});

	// グラフ表示コマンドの登録
	const showGraphDisposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.showGraph', async () => {
		console.log('=== SHOWGRAPH COMMAND STARTED ===');
		logs.log('=== SHOWGRAPH COMMAND STARTED ===');
		
		const workspace_folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders : [];
		const root_folder = selectRootFolder(workspace_folders);
		console.log('Root folder selected:', root_folder?.uri.fsPath);
		
		if (root_folder) {
			const db_file = path.join(root_folder.uri.fsPath, '.vscode', 'crd.duckdb');
			logs.log(`Attempting to open database: ${db_file}`);
			
			// DBファイルの存在確認
			console.log('Checking database file existence:', db_file);
			if (!fs.existsSync(db_file)) {
				console.log('Database file does not exist');
				logs.error(`Database file not found: ${db_file}`);
				logs.error('Please run "Initialize Code Relationship Diagram" command first to create the database.');
				return;
			}
			console.log('Database file exists');
			
			try {
				console.log('Creating database connection...');
				const db = new codeDb.Db(db_file);
				console.log('Database connection created');
				logs.log('Database opened successfully');
				
				// 少し待機してDB接続が安定するのを待つ
				await new Promise(resolve => setTimeout(resolve, 100));
				console.log('Database initialization wait completed');
				
				// 全てのシンボルを読み込み
				const allSymbols: any[] = [];
				console.log('Starting to load code files...');
				logs.log('Loading code files...');
				
				// タイムアウト機能付きでファイル一覧を取得
				const files = await Promise.race([
					db.codeFile_queryAll(),
					new Promise((_, reject) => 
						setTimeout(() => reject(new Error('Database query timeout (10s)')), 10000)
					)
				]) as any[];
				
				console.log(`Files query completed, found: ${files.length}`);
				logs.log(`Found ${files.length} code files in database`);
				
				for (const fileRow of files) {
					console.log(`Loading symbols from file: ${fileRow.relative_path}`);
					logs.log(`Loading symbols from file: ${fileRow.relative_path}`);
					
					const symbols = await Promise.race([
						db.symbol_loadAll(fileRow.relative_path),
						new Promise((_, reject) => 
							setTimeout(() => reject(new Error(`Symbol load timeout for ${fileRow.relative_path}`)), 5000)
						)
					]) as any[];
					
					allSymbols.push(...symbols);
					console.log(`Loaded ${symbols.length} symbols from ${fileRow.relative_path}`);
					logs.log(`Loaded ${symbols.length} symbols from ${fileRow.relative_path}`);
				}
				console.log(`Total symbols loaded: ${allSymbols.length}`);
				logs.log(`Total symbols loaded: ${allSymbols.length}`);
				
				// シンボル参照関係を読み込み
				console.log('Loading symbol references...');
				logs.log('Loading symbol references...');
				
				const references = await Promise.race([
					db.symbolReference_loadAll(),
					new Promise((_, reject) => 
						setTimeout(() => reject(new Error('References load timeout (10s)')), 10000)
					)
				]) as any[];
				
				console.log(`Loaded ${references.length} symbol references`);
				logs.log(`Loaded ${references.length} symbol references`);
				
				// グラフを表示
				console.log('Starting graph visualization...');
				logs.log('Starting graph visualization...');
				const graphViz = new GraphVisualization(context, logs);
				console.log('GraphVisualization instance created');
				
				await graphViz.showGraph(allSymbols, references);
				console.log('GraphVisualization.showGraph completed');
				
				db.dispose();
				console.log('Database disposed');
				logs.info('Code relationship diagram displayed');
			} catch (error) {
				logs.error(`Failed to show graph: ${error instanceof Error ? error.message : error}`);
				console.error('ShowGraph error details:', error);
			}
		} else {
			logs.error('No workspace folder found');
		}
	});

	context.subscriptions.push(initializeDisposable);
	context.subscriptions.push(showGraphDisposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	_logs?.info('extension is now deactivate!');
}

function selectRootFolder(folders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | null {
	// フォルダが1つ以上在って
	return (folders.length > 0)
		// パスの長さが最小のフォルダのパス名を返す
		? folders.reduce((min, current) => current.uri.fsPath.length < min.uri.fsPath.length ? current : min)
		: null;
}

function readConfiguration(config: object | undefined): object {
	return config ? config : {};
}
