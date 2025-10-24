/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFiles from './codeFiles';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';
import { RowData } from 'duckdb';
import { distribute } from './distributor';
import * as codeRelationships from './codeRelationships';
import { GraphVisualization } from './graphVisualization';
import { log } from 'console';

export class DocumentDictionary {
	constructor(public file: codeFiles.File, public symbol: SYMBOL.SymbolModel[], public document: vscode.TextDocument) {}
}	


let _logs: Logs | null = null;

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	const package_json = context.extension.packageJSON;
	const short_name = package_json?.shortName || '';
	const version = package_json?.version || '';
	const logs = _logs = new Logs(package_json?.displayName);

	// 動作環境ログ
	const platform = process.platform;  // 'darwin' / 'win32' / 'linux'
	const arch = process.arch;          // 'x64' / 'arm64'
	logs.log(`extension is now active! ${version} Node.js:${process.version}, VSCode:${vscode.version}, Platform:${platform}-${arch}`);

	// ステータスバーを生成
	const status_bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
	const updateCommand = (bar: vscode.StatusBarItem, text: string, command: string | undefined, tooltip: string) => {
		bar.text = text;
		bar.command = command;
		bar.tooltip = tooltip;
	};
	updateCommand(status_bar, short_name, 'vscode-code-relationship-diagram.showDiagram', locale('show-diagram-tooltip'));
	status_bar.show();

	// 初期化するコマンドの登録
	context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.initialize', async () => {
		let reference_count = 0;
		let line_count = 0;

		// 経過の初期表示
		status_bar.show();
		const secondsToTime = (milliSeconds: number): string => {
			const hours = Math.floor(milliSeconds / 3600000);
			const minutes = Math.floor((milliSeconds % 3600000) / 60000);
			const secs = Math.floor((milliSeconds % 60000) / 1000);
			let time = milliSeconds >= 3600000 ? String(hours).padStart(2, '0') + ':' : '';
			time += milliSeconds >= 60000 ? String(minutes).padStart(2, '0') + ':' : '';
			time += milliSeconds >= 10000 ? String(secs).padStart(2, '0') : milliSeconds >= 1000 ? String(secs) : '0';
			return time;
		};
		const updateProgress = (bar: vscode.StatusBarItem, start: number, processed: number, total: number, message: string = '') => {
			const percentage = total > 0 ? (processed / total) * 100 : 0.00;
			const processed_msec = performance.now() - start;
			const rest_sec = percentage > 0 ? (processed_msec / percentage) * (total - processed) : 0;
			bar.text = `$(sync~spin) ${short_name}: ${processed}/${total} ${percentage.toFixed(2)}% ...${secondsToTime(rest_sec)} ${message}`;
		};
		updateCommand(status_bar, short_name, undefined, locale('initialize-tooltip'));

		// ワークスペースが在り、ファイルの関連付けのパターンが在ったら
		const workspace_file = vscode.workspace.workspaceFile;
		const associations = readSetting(vscode.workspace.getConfiguration("files").get<object>("associations"));
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
					updateProgress(status_bar, start, progressed, progress_total);
					const last_phase = 7;

					// ファイルを列挙する
					const file_lists: codeFiles.File[] = [];
					const ignores = codeFiles.loadGitignorePatterns(workspace_folder);
					const patterns = codeFiles.list(workspace_folder, associations, ignores, (file: codeFiles.File) => {
						file_lists.push(file);
						logs.log(`1/${last_phase} Listed file: ${file.relative_path}`);
						updateProgress(status_bar, start, (progressed++ / 3) * 1, progress_total++);
					});
					logs.log(`Listed file: ${file_lists.length} files`);

					// ファイルテーブルの変更を分配する
					const file_loads = await db.codeFile_loadAll();
					const file_sorted = file_lists.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
					const [file_additions, file_updates, file_notchanges, file_removes] = distribute<RowData, codeFiles.File>(file_loads, file_sorted,
						(oldItem) => oldItem?.relative_path ?? '',
						(newItem) => newItem.relative_path,
						(oldItem, newItem) => newItem.relative_path === oldItem.relative_path,
						(oldItem, newItem) => newItem.updated.getTime() !== oldItem?.updated_at?.getTime()  
					);
					progress_total += file_additions.length + file_updates.length + file_notchanges.length + file_removes.length;

					const symbol_all: SYMBOL.SymbolModel[] = [];

					// 変更ファイルは、シンボルのテーブルと抽出から変更を分配する
					const relationship_simbols: SYMBOL.SymbolModel[] = []; 
					for (const code of file_updates) {
						const [olds, news] = await Promise.all([
							db.symbol_load(code.relative_path),
							new Promise<SYMBOL.SymbolModel[]>(resolve => {
								vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace_folder, code.relative_path))).then(doc => {
									codeSymbols.extract(code.relative_path, doc).then((symbols) => resolve(symbols)).catch(() => resolve([]));
								});
							})
						]);
						const [symbol_additions, symbol_updates, symbol_notchanges, symbol_removes] = distribute<SYMBOL.SymbolModel, SYMBOL.SymbolModel>(olds, news,
							(oldItem) => oldItem.id,
							(newItem) => newItem.id,
							(oldItem, newItem) => newItem.id === oldItem.id,
							(oldItem, newItem) => !newItem.hash.equals(oldItem.hash)  
						);
						logs.log(`symbols ${code.relative_path}: (added ${symbol_additions.length}, updated ${symbol_updates.length}, no changed ${symbol_notchanges.length}, removed ${symbol_removes.length})`);
						relationship_simbols.push(...symbol_additions, ...symbol_updates);
					}
					// 追加ファイルは、シンボルをコードから抽出する
					for (const code of file_additions) {
						const symbols = await new Promise<SYMBOL.SymbolModel[]>(resolve => {
							vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace_folder, code.relative_path))).then(doc => {
								codeSymbols.extract(code.relative_path, doc).then((symbols) => resolve(symbols)).catch(() => resolve([]));
							});
						});
						symbol_all.push(...symbols);
					}
					// 変更のないファイルは、シンボルテーブルを読み込む
					for (const code of file_notchanges) {
						const symbols = await db.symbol_load(code.relative_path);
						symbol_all.push(...symbols);
					}



					// ファイルのシンボルを抽出する
					const hierarchy_all: Record<string, SYMBOL.SymbolModel[]> = {};
					const hierarchy_upserts: DocumentDictionary[] = [];
					for (const upsert of [...file_additions, ...file_updates]) {
						try {
							const [doc, symbols] = await new Promise<[vscode.TextDocument, SYMBOL.SymbolModel[]]>(resolve => {
								vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace_folder, upsert.relative_path))).then(doc => {
									codeSymbols.extract(upsert.relative_path, doc).then((symbols) => resolve([doc, symbols])).catch(() => resolve([doc, []]));
								});
							});
							hierarchy_upserts.push(new DocumentDictionary(upsert, symbols, doc));
							hierarchy_all[upsert.relative_path] = symbols;
							logs.log(`2/${last_phase} Extructed symbol: ${upsert.relative_path}`);
							updateProgress(status_bar, start, (progressed++ / 3) * 2, progress_total);
							/*
							const diags = vscode.languages.getDiagnostics(doc.uri);
							for (const diag of diags) {
								logs.warn(`  Diagnostic: ${upsert.relative_path}(${diag.range.start.line + 1},${diag.range.start.character + 1}-${diag.range.end.line + 1},${diag.range.end.character + 1}) ${diag.code}:${diag.message}`);
							}*/
						} catch (error) {
							logs.error(`2/${last_phase} Failed to open document ${upsert.relative_path}: `, error);
						}
					}
					progress_total += hierarchy_upserts.length;
					logs.log(`Extructed symbols: ${hierarchy_upserts.length} files`);

					// 変更のないファイルのシンボルを読み込む
					for (const nochange of file_notchanges) {
						try {
							const symbols = await db.symbol_load(nochange.relative_path);
							hierarchy_all[nochange.relative_path] = symbols;
							line_count += symbols[0].lineCount;
							logs.log(`3/${last_phase} Not changed: ${nochange.relative_path}`);
							updateProgress(status_bar, start, (progressed++ / 3) * 2, progress_total);
						} catch (error) {
							logs.error(`3/${last_phase} Failed to load symbols for ${nochange.relative_path}: `, error);
						}
					}										
					logs.log(`Not changed symbols ${file_notchanges.length} files`);

					// インデックス作成待ち
					let attempt = 0;
					updateProgress(status_bar, start, progressed, progress_total, 'Waiting for indexing to complete...');
					for (attempt = 0; attempt < 10; attempt++) {
						// インデックス作成が完了するまで待つ
						if (await codeRelationships.indexingIsComplete()) {
							break;
						}
						// まだ完了していなかったら、もう少し待つ
						await new Promise(resolve => setTimeout(resolve, 1000));
					}
					logs.log(`Waitied for indexing to complete... attempt ${attempt + 1}`);

					const save_promises: Promise<void>[] = [];

					// ファイル削除を追加する
					for (const remove of file_removes) {
						save_promises.push(new Promise<void>((resolve, reject) => {
							Promise.all([
								db.relationship_deletePath(remove),
								db.symbol_deletePath(remove)
							]).then(() => {
								db.codeFile_delete(remove).then(() => {
									logs.log(`4/${last_phase} Removed file: ${remove}`);
									updateProgress(status_bar, start, (progressed++ / 3) * 2, progress_total);
									resolve();
								}).catch(error => {
									reject(`4/${last_phase} db.codeFile_delete(${remove}): ${error instanceof Error ? error.message : error}`);
								});
							}).catch(error => {
								reject(`4/${last_phase} db.symbol_delete(${remove}): ${error instanceof Error ? error.message : error}`);
							});
						}));
					}

					// ファイル更新を追加する
					for (const hierarchy_upsert of	hierarchy_upserts) {
						line_count += hierarchy_upsert.symbol[0].lineCount;
						save_promises.push(new Promise<void>((resolve, reject) => {

							// 定義を検索
							db.relationship_queryDefinePath(hierarchy_upsert.file.relative_path).then(define_rels => {

								// シンボルを削除する
								Promise.all([
									db.relationship_deletePath(hierarchy_upsert.file.relative_path),
									db.symbol_deletePath(hierarchy_upsert.file.relative_path)
								]).then(() => {


									// シンボルをDBに保存する
									db.symbol_save(hierarchy_upsert.symbol).then(() => {
										logs.log(`5/${last_phase} Saved symbol: ${hierarchy_upsert.file.relative_path}`);

										// 関係を抽出
										updateProgress(status_bar, start, progressed, progress_total, `Extracting relationships: ${hierarchy_upsert.file.relative_path}`);
										codeRelationships.extract(workspace_folder, hierarchy_upsert.document.uri, hierarchy_upsert.symbol, hierarchy_all, 3).then(reference_rels => {
											reference_count += reference_rels.length;
											const inserts: Promise<void>[] = [];
											logs.log(`6/${last_phase} Extracted relationship: ${hierarchy_upsert.file.relative_path}:${hierarchy_upsert.symbol[0].lineCount} ${reference_rels.length} counts`);

											// 関係の参照を追加する
											for (const reference_rel of reference_rels) {
												inserts.push( db.relationship_insert(reference_rel) );
											}
											// 関係の定義を追加する
											for (const define_rel of define_rels) {
												inserts.push( db.relationship_insert(define_rel) );
											}
											Promise.all(inserts).then(() => {

												// ファイルを更新または挿入する
												db.codeFile_upsert(new codeFiles.File(hierarchy_upsert.file.relative_path, hierarchy_upsert.document.languageId, hierarchy_upsert.file.updated)).then(() => {
													logs.log(`7/${last_phase} Upserted file: ${hierarchy_upsert.file.relative_path}`);
													updateProgress(status_bar, start, progressed++, progress_total);
													resolve();
												}).catch(error => {
													reject(`7/${last_phase} db.codeFile_upsert(${hierarchy_upsert.file.relative_path}): ${error instanceof Error ? error.message : error}`);
												});
											}).catch(error => {
												reject(`7/${last_phase} Failed to insert relationships for ${hierarchy_upsert.file.relative_path}: ${error instanceof Error ? error.message : error}`);
											});
										}).catch(error => {
											reject(`6/${last_phase} Failed to extract relationships from ${hierarchy_upsert.file.relative_path}: ${error instanceof Error ? error.message : error}`);
										});
									}).catch(error => {
										reject(`5/${last_phase} db.symbol_save(${hierarchy_upsert.file.relative_path}): ${error instanceof Error ? error.message : error}`);
									});
								}).catch(error => {
									reject(`5/${last_phase} db.symbol_delete(${hierarchy_upsert.file.relative_path}): ${error instanceof Error ? error.message : error}`);
								});
							}).catch(error => {
								reject(`5/${last_phase} Failed to query relationships for ${hierarchy_upsert.file.relative_path}: ${error instanceof Error ? error.message : error}`);
							});
						}));
					}

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

					// DBを破棄する
					db.dispose();

					logs.log(`${secondsToTime(performance.now() - start)} processed ${file_lists.length} files(` +
						`added ${file_additions.length}, updated ${file_updates.length}, no changed ${file_notchanges.length}, removed ${file_removes.length}) ` +
						`${line_count} lines, ${reference_count} relationships`);

					// 初期化メッセージを表示する
					updateCommand(status_bar, short_name, 'vscode-code-relationship-diagram.showDiagram', locale('show-diagram-tooltip'));
					logs.info(locale('initialize-message'));
				} catch (error) {
					setTimeout(() => status_bar.dispose(), 3000);
					logs.error(`codeFile.list(${workspace_folder}): `, error);
				}
			} catch (error) {
				setTimeout(() => status_bar.dispose(), 3000);
				logs.error(`db.table_create(${db_file}): `, error);
			}
		} else {
			setTimeout(() => status_bar.dispose(), 3000);
			logs.error(locale('error-no-associations'));
		}
	}));

	// グラフ表示コマンドの登録
	context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.showDiagram', async () => {
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
					
					// 全てのシンボルを読み込み
					const all_symbols = await db.symbol_quaryAll();
					logs.log(`Loaded symbol: ${all_symbols.length} counts`);
					
					// シンボル関係を読み込み
					const all_rels = await db.relationship_quaryAll();
					logs.log(`Loaded relationships: ${all_rels.length} counts`);
					
					// グラフを表示
					const graphViz = new GraphVisualization(context, workspace_folder, workspace_basename + '.crd.html', logs);
					await graphViz.showDiagram(all_symbols, all_rels);
					logs.log('Show Diagram completed');
					
					db.dispose();
					logs.info('Code relationship diagram displayed');
				} catch (error) {
					logs.error('Failed to show graph: ', error);
				}
			}
		} else {
			logs.error('No workspace folder found');
		}
	}));

	// ドキュメント変更イベント
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
    	const doc = event.document;
	}));
}

// This method is called when your extension is deactivated
export function deactivate() {
	_logs?.info('extension is now deactivate!');
}

function readSetting(setting: object | undefined): object {
	return setting ? setting : {};
}
