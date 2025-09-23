/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFiles from './codeFiles';
import * as codeSymbols from './codeSymbols';
import * as codeRelationships from './codeRelationships';
import * as lc from './languageConfig';
import * as ls from './languageServer';
import { GraphVisualization } from './graphVisualization';

let _logs: Logs | null = null;

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	const short_name = context.extension.packageJSON?.shortName || '';
	const version = context.extension.packageJSON?.version || '';
	const logs = _logs = new Logs(context.extension.packageJSON?.displayName);
	const platform = process.platform;  // 'darwin' / 'win32' / 'linux'
	const arch = process.arch;          // 'x64' / 'arm64'
	logs.log(`extension is now active! ${version} Node.js:${process.version}, VSCode:${vscode.version}, Platform:${platform}-${arch}`);
	const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	statusBarItem.show();
	statusBarItem.text = short_name;
	statusBarItem.command = 'vscode-code-relationship-diagram.showDiagram';
	statusBarItem.tooltip = 'Show diagram';

	// 初期化するコマンドの登録
	const initializeDisposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.initialize', async () => {

		// 経過の初期表示
		statusBarItem.show();
		const updateProgress = (processed: number, total: number, message: string = '') => {
			const percentage = total > 0 ? ((processed / total) * 100).toFixed(2) : "0.00";
			statusBarItem.text = `$(sync~spin) ${short_name}: ${processed}/${total} ${percentage}% ${message}`;
		};

		// ワークスペースが在り、ファイルの関連付けのパターンが在ったら
		const workspace_file = vscode.workspace.workspaceFile;
		const associations = readConfiguration(vscode.workspace.getConfiguration("files").get<object>("associations"));
		if (workspace_file && (Object.keys(associations).length > 0)) {
			const workspace_folder = path.dirname(workspace_file.fsPath);
			const db_file = path.join(workspace_folder, '.vscode', 'crd.duckdb');
			try {
				// コード関係図DBを作成する
				const db = new codeDb.Db(db_file);
				await db.table_create();
				try {
					const start = performance.now();
					let progress_total = 0;
					let progressed = 0;
					updateProgress(progressed, progress_total);
					const last_phase = 7;

					// コードファイルを列挙する
					const files: codeFiles.File[] = [];
					const ignores = codeFiles.loadGitignorePatterns(workspace_folder);
					const patterns = codeFiles.list(workspace_folder, associations, ignores, (file: codeFiles.File) => {
						files.push(file);
						logs.log(`1/${last_phase} Listed file: ${file.relative_path}`);
						updateProgress(progressed, progress_total++);
					});
					logs.log(`Listed file: ${files.length} files`);

					// コードファイルをパスでソートする
					const sorted = files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

					// コードファイルテーブルの変更を抽出する
					const rows = await db.codeFile_query(null);
					const [upserts, nochanges, removes] = codeFiles.updates(sorted, rows);
					progress_total += upserts.length + nochanges.length + removes.length;

					// コードファイルのシンボルを抽出する
					const symbol_dic: Record<string,codeSymbols.Dictionary> = {};
					const upsert_dic: Record<string,codeSymbols.DocumentDictionary> = {};
					for (const upsert of upserts) {
						try {
							const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace_folder, upsert.relative_path)));
							const symbol = await codeSymbols.extract(upsert.relative_path, doc);
							upsert_dic[upsert.relative_path] = new codeSymbols.DocumentDictionary(upsert.updated, upsert.language_id, symbol, doc);
							symbol_dic[upsert.relative_path] = new codeSymbols.Dictionary(upsert.updated, upsert.language_id, symbol);
							logs.log(`2/${last_phase} Extructed symbol: ${upsert.relative_path}`);
							updateProgress(progressed++, progress_total);
						} catch (error) {
							logs.error(`2/${last_phase} Failed to open document ${upsert.relative_path}: `, error);
						}
					}
					progress_total += Object.keys(upsert_dic).length;
					logs.log(`Extructed symbols: ${Object.keys(upsert_dic).length} files`);

					// 変更のないファイルのシンボルを読み込む
					for (const nochange of nochanges) {
						try {
							const symbols = await db.symbol_load(nochange.relative_path);
							for (const symbol of symbols) {
								symbol_dic[symbol.path] = new codeSymbols.Dictionary(nochange.updated, nochange.language_id, symbol);
								logs.log(`3/${last_phase} Not changed: ${symbol.path}`);
								updateProgress(progressed++, progress_total);
							}
						} catch (error) {
							logs.error(`3/${last_phase} Failed to load symbols for ${nochange.relative_path}: `, error);
						}
					}										
					logs.log(`Not changed symbols ${nochanges.length} files`);

					const save_promises: Promise<void>[] = [];

					// ファイル削除を追加する
					for (const remove of removes) {
						save_promises.push(new Promise<void>((resolve, reject) => {
							db.symbol_delete(remove).then(() => {
								db.codeFile_delete(remove).then(() => {
									logs.log(`4/${last_phase} Removed file: ${remove}`);
									updateProgress(progressed++, progress_total);
									resolve();
								}).catch(error => {
									reject(`4/${last_phase} db.codeFile_delete(${remove}): ${error instanceof Error ? error.message : error}`);
								});
							}).catch(error => {
								reject(`4/${last_phase} db.symbol_delete(${remove}): ${error instanceof Error ? error.message : error}`);
							});
						}));
					}

					/* 言語サーバーを再構築する
					if (config.rescanCommand) {
						await vscode.commands.executeCommand(config.rescanCommand);
					}
					*/

					// ファイル更新を追加する
					Object.values(upsert_dic).forEach(({updated, languageId, symbol: root, document: doc}) => {
						let ls_wait: ls.LanguageCompleteWaiter | null = null;
						save_promises.push(new Promise<void>((resolve, reject) => {

							// 言語サーバーの補完が完了するまで待つ
							const config = lc.getConfig(languageId);
							if (config) {
								updateProgress(progressed, progress_total, `Waiting language server: ${root.path}`);
								ls_wait = new ls.LanguageCompleteWaiter();
								ls_wait.waitComplete(doc, config).then((uri) => {

									// 定義を検索
									db.relationship_definePath(root.path).then(define_rels => {

										// シンボルを削除する
										db.symbol_delete(root.path).then(() => {

											// シンボルをDBに保存する
											db.symbol_save(root, null).then(() => {
												logs.log(`5/${last_phase} Saved symbol: ${root.path}`);

												// 関係を抽出
												updateProgress(progressed, progress_total, `Extracting relationships: ${root.path}`);
												codeRelationships.extract(workspace_folder, config, doc.uri, root, symbol_dic, 60).then(reference_rels => {
													const inserts: Promise<void>[] = [];
													logs.log(`6/${last_phase} Extract relationship: ${root.path} ${reference_rels.length} counts`);

													// 関係を追加する
													for (const reference_rel of reference_rels) {
														inserts.push( db.relationship_insert(reference_rel) );
													}
													// 関係の定義を更新する
													for (const define_rel of define_rels) {

														// シンボルが見つかったら、定義を更新する
														codeSymbols.each(root, (symbol) => {
															if (symbol.id === define_rel.define.id) {
																define_rel.define.update(symbol.path, symbol.startLine);
															}
														});

														// 関係を追加する
														inserts.push( db.relationship_insert(define_rel) );
													}
													Promise.all(inserts).then(() => {

														// コードファイルを更新または挿入する
														db.codeFile_upsert(root.path, updated).then(() => {
															logs.log(`7/${last_phase} Upserted file: ${root.path}`);
															updateProgress(progressed++, progress_total);
															resolve();
														}).catch(error => {
															reject(`7/${last_phase} db.codeFile_upsert(${root.path}): ${error instanceof Error ? error.message : error}`);
														});
													}).catch(error => {
														reject(`7/${last_phase} Failed to insert relationships for ${root.path}: ${error instanceof Error ? error.message : error}`);
													});
												}).catch(error => {
													reject(`6/${last_phase} Failed to extract relationships from ${root.path}: ${error instanceof Error ? error.message : error}`);
												});
											}).catch(error => {
												reject(`5/${last_phase} db.symbol_save(${root.path}): ${error instanceof Error ? error.message : error}`);
											});											
										}).catch(error => {
											reject(`5/${last_phase} db.symbol_delete(${root.path}): ${error instanceof Error ? error.message : error}`);
										});
									}).catch(error => {
										reject(`5/${last_phase} Failed to query relationships for ${root.path}: ${error instanceof Error ? error.message : error}`);
									});
								}).catch((error) => {
									reject(`5/${last_phase} Language server wait failed for ${root.path}: ${error instanceof Error ? error.message : error}`);
								});
							} else {
								reject(`5/${last_phase} Extract relationship: ${root.path} No language server configuration for ${languageId}`);
							}
						}).finally(() => {
							// リソースのクリーンアップを保証
							if (ls_wait) {
								ls_wait.dispose();
							}
						}));
					});

					// 保存処理を実行する
					for (const save_promise of save_promises) {
						try {
							await save_promise;
						} catch (error) {
							logs.error('', error);
						}
					}
					/*
					try {
						await Promise.all(save_promises);
					} catch (error) {
						logs.error('', error);
					}
					*/
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
					setTimeout(() => statusBarItem.dispose(), 3000);
					logs.error(`codeFile.list(${workspace_folder}): `, error);
				}
			} catch (error) {
				setTimeout(() => statusBarItem.dispose(), 3000);
				logs.error(`db.table_create(${db_file}): `, error);
			}
		} else {
			setTimeout(() => statusBarItem.dispose(), 3000);
			logs.error(locale('error-no-associations'));
		}
	});

	// グラフ表示コマンドの登録
	const showDiagramDisposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.showDiagram', async () => {
		logs.log('=== SHOWDIAGRAM COMMAND STARTED ===');
		
		const workspace_file = vscode.workspace.workspaceFile;
		if (workspace_file) {
			const workspace_folder = path.dirname(workspace_file.fsPath);
			const workspace_basename = path.basename(workspace_file.fsPath, path.extname(workspace_file.fsPath));
			const db_file = path.join(workspace_folder, '.vscode', 'crd.duckdb');
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
					
					// 全てのシンボルを読み込み
					for (const fileRow of files) {
						const roots = await db.symbol_load(fileRow.relative_path);
						for (const root of roots) {
							codeSymbols.each(root, (symbol) => {
								allSymbols.push(symbol);
							}, true);
						}
						logs.log(`Loaded ${roots.length} symbols from ${fileRow.relative_path}`);
					}
					logs.log(`Total symbols loaded: ${allSymbols.length}`);
					
					// シンボル関係を読み込み
					logs.log('Loading symbol relationships...');
					
					const relationships = await Promise.race([
						db.relationship_quaryAll(),
						new Promise((_, reject) => 
							setTimeout(() => reject(new Error('Relationships load timeout (10s)')), 10000)
						)
					]) as any[];
					
					logs.log(`Loaded ${relationships.length} symbol relationships`);
					
					// グラフを表示
					const graphViz = new GraphVisualization(context, workspace_folder, workspace_basename + '.crd.html', logs);
					logs.log('GraphVisualization instance created');
					
					await graphViz.showDiagram(allSymbols, relationships);
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

function readConfiguration(config: object | undefined): object {
	return config ? config : {};
}
