/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
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
						logs.log(`${(performance.now() - start).toFixed(2)} ms: list ${file.relative_path}`);
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
							logs.log(`${(performance.now() - start).toFixed(2)} ms: upsert ${upsert.relative_path}`);
						} catch (error) {
							logs.trace(`db.codeFile_upsert(${upsert.relative_path}): ${error instanceof Error ? error.message : error}`);
						}
					}

					// コードファイルを削除する
					for (const remove of removes) {
						try {
							await db.codeFile_remove(remove);
							logs.log(`${(performance.now() - start).toFixed(2)} ms: remove ${remove}`);
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
								logs.log(`${(performance.now() - start).toFixed(2)} ms: load symbol ${symbol.path} (${vscode.SymbolKind[symbol.kind]})`);
								
								// シンボル参照関係を抽出
								const references = await codeReferences.extractReferences(document, symbol.id);
								for (const ref of references) {
									await db.symbolReference_upsert(ref);
								}
								if (references.length > 0) {
									logs.log(`${(performance.now() - start).toFixed(2)} ms: extracted ${references.length} references from ${symbol.path}`);
								}
							}
						} catch (error) {
							logs.trace(`codeSymbols.load(${file.relative_path}): ${error instanceof Error ? error.message : error}`);
						}
					}
					
					// DBを破棄する
					db.dispose();

					logs.log(`${(performance.now() - start).toFixed(2)} ms list ${files.length} files, upserted ${upserts.length} files, removed ${removes.length} files`);

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
		const workspace_folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders : [];
		const root_folder = selectRootFolder(workspace_folders);
		
		if (root_folder) {
			const db_file = path.join(root_folder.uri.fsPath, '.vscode', 'crd.duckdb');
			try {
				const db = new codeDb.Db(db_file);
				
				// 全てのシンボルを読み込み
				const allSymbols: any[] = [];
				const files = await db.codeFile_queryAll();
				for (const fileRow of files) {
					const symbols = await db.symbol_loadAll(fileRow.relative_path);
					allSymbols.push(...symbols);
				}
				
				// シンボル参照関係を読み込み
				const references = await db.symbolReference_loadAll();
				
				// グラフを表示
				const graphViz = new GraphVisualization();
				await graphViz.showGraph(allSymbols, references);
				
				db.dispose();
				logs.info('Code relationship diagram displayed');
			} catch (error) {
				logs.error(`Failed to show graph: ${error instanceof Error ? error.message : error}`);
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
