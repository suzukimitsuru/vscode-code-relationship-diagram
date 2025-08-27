/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFiles from './codeFiles';
import * as codeSymbols from './codeSymbols';
import * as codeReferences from './codeReferences';
import { GraphVisualization } from './graphVisualization';

let _logs: Logs | null = null;

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	const short_name = context.extension.packageJSON?.shortName || '';
	const logs = _logs = new Logs(context.extension.packageJSON?.displayName);
	const platform = process.platform;  // 'darwin' / 'win32' / 'linux'
	const arch = process.arch;          // 'x64' / 'arm64'
	logs.log(`extension is now active! Node.js:${process.version}, VSCode:${vscode.version}, Platform:${platform}-${arch}`);
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);

	// 初期化するコマンドの登録
	const initializeDisposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.initialize', async () => {

		// 経過の初期表示
		statusBarItem.show();
		const updateProgress = (processed: number, total: number) => {
			const percentage = total > 0 ? ((processed / total) * 100).toFixed(2) : "0.00";
			statusBarItem.text = `$(sync~spin) ${short_name}: ${processed}/${total} ${percentage}%`;
		};

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
					let progress_total = 0;
					let progressed = 0;
					updateProgress(progressed, progress_total);

					// コードファイルを列挙する
					const files: codeFiles.File[] = [];
					const patterns = codeFiles.list(root_folder.uri.fsPath, associations, (file: codeFiles.File) => {
						files.push(file);
						logs.log(`Listed file: ${file.relative_path}`);
						updateProgress(progressed++, progress_total++);
					});

					// コードファイルをパスでソートする
					const sorted = files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

					// コードファイルテーブルの変更を抽出する
					const rows = await db.codeFile_query(null);
					const [upserts, nochanges, removes] = codeFiles.updates(sorted, rows);

					// コードファイルのシンボルを抽出する
					const symbol_dic: Record<string,codeSymbols.Dictionary> = {};
					const upsert_dic: Record<string,codeSymbols.Dictionary> = {};
					for (const upsert of upserts) {
						try {
							const fullname = path.join(root_folder.uri.fsPath, upsert.relative_path);
							const document = await vscode.workspace.openTextDocument(vscode.Uri.file(fullname));
							const symbol = await codeSymbols.extract(upsert.relative_path, document);
							upsert_dic[upsert.relative_path] = new codeSymbols.Dictionary(upsert.updated, upsert.language_id, symbol);
							symbol_dic[upsert.relative_path] = new codeSymbols.Dictionary(upsert.updated, upsert.language_id, symbol);
							logs.log(`Extructed symbol: ${upsert.relative_path}`);
							updateProgress(progressed++, progress_total++);
						} catch (error) {
							logs.error(`Failed to open document ${upsert.relative_path}: `, error);
						}
					}
					logs.log(`Extructed symbols: ${Object.keys(upsert_dic).length} files`);

					// 変更のないファイルを追加する
					for (const nochange of nochanges) {
						try {
							const symbols = await db.symbol_load(nochange.relative_path);
							for (const symbol of symbols) {
								symbol_dic[symbol.path] = new codeSymbols.Dictionary(nochange.updated, nochange.language_id, symbol);
								logs.log(`Not changed: ${symbol.path}`);
								updateProgress(progressed++, progress_total++);
							}
						} catch (error) {
							logs.error(`Failed to load symbols for ${nochange.relative_path}: `, error);
						}
					}										
					logs.log(`Symbols ${Object.keys(symbol_dic).length} files`);

					const save_promises: Promise<void>[] = [];
					//progress_total = upserts.length + nochanges.length + removes.length;
					//updateProgress(progressed, progress_total);

					// ファイル削除を追加する
					for (const remove of removes) {
						save_promises.push(new Promise<void>((resolve, reject) => {
							db.symbol_delete(remove).then(() => {
								db.codeFile_delete(remove).then(() => {
									logs.log(`Removed file: ${remove}`);
									updateProgress(progressed++, progress_total);
									resolve();
								}).catch(error => {
									reject(`db.codeFile_delete(${remove}): ${error instanceof Error ? error.message : error}`);
								});
							}).catch(error => {
								reject(`db.symbol_delete(${remove}): ${error instanceof Error ? error.message : error}`);
							});
						}));
					}

					// ファイル更新を追加する
					Object.values(upsert_dic).forEach(({updated, languageId, symbol: root}) => {
						save_promises.push(new Promise<void>((resolve, reject) => {

							// 参照先を検索
							db.reference_toPath(root.path).then(to_refs => {

								// シンボルを削除する
								db.symbol_delete(root.path).then(() => {

									// シンボルをDBにアップサートする
									db.symbol_save(root, null).then(() => {
										logs.log(`Saved symbol: ${root.path}`);

										// 参照関係を抽出
										codeReferences.extract(root_folder.uri.fsPath, languageId, root, symbol_dic).then(from_refs => {
											const inserts: Promise<void>[] = [];
											logs.log(`Extract reference: ${root.path} ${from_refs.length} counts`);

											// 参照関係を保存する
											for (const ref of from_refs) {
												inserts.push( db.reference_insert(ref) );
											}
											// 参照先を更新する
											for (const ref of to_refs) {

												// シンボルが見つかったら
												codeSymbols.each(root, (symbol) => {
													if (symbol.id === ref.to.id) {

														// 参照先を更新する
														ref.to.path = symbol.path;
														ref.to.startLine = symbol.startLine;
													}
												});

												// 参照先を保存する
												inserts.push( db.reference_insert(ref) );
											}
											Promise.all(inserts).then(() => {

												// コードファイルを更新または挿入する
												db.codeFile_upsert(root.path, updated).then(() => {
													logs.log(`Upserted file: ${root.path}`);
													updateProgress(progressed++, progress_total);
													resolve();
												}).catch(error => {
													reject(`db.codeFile_upsert(${root.path}): ${error instanceof Error ? error.message : error}`);
												});
											}).catch(error => {
												logs.error(`Failed to insert references for ${root.path}: ${error instanceof Error ? error.message : error}`);
											});
										}).catch(error => {
											logs.error(`Failed to extract references from ${root.path}: ${error instanceof Error ? error.message : error}`);
										});
									}).catch(error => {
										reject(`db.symbol_save(${root.path}): ${error instanceof Error ? error.message : error}`);
									});											
								}).catch(error => {
									reject(`db.symbol_delete(${root.path}): ${error instanceof Error ? error.message : error}`);
								});
							}).catch(error => {
								logs.error(`Failed to query references for ${root.path}: ${error instanceof Error ? error.message : error}`);
							});
						}));
					});

					// 保存処理を実行する
					/*
					for (const save_promise of save_promises) {
						try {
							await save_promise;
						} catch (error) {
							logs.trace('save_promises(): ', error);
						}
					}
					*/
					try {
						await Promise.all(save_promises);
					} catch (error) {
						logs.trace('save_promises(): ', error);
					}
					logs.log(`Upserted ${upserts.length} files, no changed ${nochanges.length} files, removed ${removes.length} files`);

					// DBを破棄する
					db.dispose();

					logs.log(`${((performance.now() - start) / 1000).toFixed(3)}s: processed ${files.length} files, upserted ${upserts.length} files, removed ${removes.length} files`);

					// 初期化メッセージを表示する
					statusBarItem.text = `$(check) ${short_name}: ${progressed}/${progress_total} (100.00%)`;
					setTimeout(() => {
						statusBarItem.text = short_name;
						statusBarItem.command = 'vscode-code-relationship-diagram.showDiagram';
						statusBarItem.tooltip = 'Show diagram';
					}, 3000);
					logs.info(locale('initialize-message'));
				} catch (error) {
					statusBarItem.text = `$(error) ${short_name}`;
					setTimeout(() => statusBarItem.dispose(), 3000);
					logs.trace(`codeFile.list(${root_folder.uri.fsPath}): `, error);
				}
			} catch (error) {
				statusBarItem.text = `$(error) ${short_name}`;
				setTimeout(() => statusBarItem.dispose(), 3000);
				logs.trace(`db.table_create(${db_file}): `, error);
			}
		} else {
			statusBarItem.text = `$(error) ${short_name}`;
			setTimeout(() => statusBarItem.dispose(), 3000);
			logs.error(locale('error-no-associations'));
		}
	});

	// グラフ表示コマンドの登録
	const showDiagramDisposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.showDiagram', async () => {
		logs.log('=== SHOWDIAGRAM COMMAND STARTED ===');
		
		const workspace_folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders : [];
		const root_folder = selectRootFolder(workspace_folders);
		logs.log('Root folder selected:', root_folder?.uri.fsPath);
		
		if (root_folder) {
			const db_file = path.join(root_folder.uri.fsPath, '.vscode', 'crd.duckdb');
			logs.log(`Attempting to open database: ${db_file}`);
			
			// DBファイルの存在確認
			logs.log('Checking database file existence:', db_file);
			if (!fs.existsSync(db_file)) {
				logs.error(`Database file not found: ${db_file}`);
				logs.error('Please run "Initialize Code Relationship Diagram" command first to create the database.');
			} else {
				try {
					const db = new codeDb.Db(db_file);
					logs.log('Database opened successfully');
					
					// 少し待機してDB接続が安定するのを待つ
					await new Promise(resolve => setTimeout(resolve, 100));
					logs.log('Database initialization wait completed');
					
					// 全てのシンボルを読み込み
					const allSymbols: any[] = [];
					logs.log('Loading code files...');
					
					// タイムアウト機能付きでファイル一覧を取得
					const files = await Promise.race([
						db.codeFile_query(null),
						new Promise((_, reject) => 
							setTimeout(() => reject(new Error('Database query timeout (10s)')), 10000)
						)
					]) as any[];
					
					logs.log(`Found ${files.length} code files in database`);
					
					for (const fileRow of files) {
						const symbols = await db.symbol_load(fileRow.relative_path);
						allSymbols.push(...symbols);
						logs.log(`Loaded ${symbols.length} symbols from ${fileRow.relative_path}`);
					}
					logs.log(`Total symbols loaded: ${allSymbols.length}`);
					
					// シンボル参照関係を読み込み
					logs.log('Loading symbol references...');
					
					const references = await Promise.race([
						db.reference_quaryAll(),
						new Promise((_, reject) => 
							setTimeout(() => reject(new Error('References load timeout (10s)')), 10000)
						)
					]) as any[];
					
					logs.log(`Loaded ${references.length} symbol references`);
					
					// グラフを表示
					const graphViz = new GraphVisualization(context, logs);
					logs.log('GraphVisualization instance created');
					
					await graphViz.showDiagram(allSymbols, references);
					logs.log('GraphVisualization.showDiagram completed');
					
					db.dispose();
					logs.info('Code relationship diagram displayed');
				} catch (error) {
					logs.error('Failed to show graph: ', error);
				}
			}
		} else {
			logs.error('No workspace folder found');
		}
	});

	context.subscriptions.push(initializeDisposable);
	context.subscriptions.push(showDiagramDisposable);
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
