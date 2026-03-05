/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFiles from './extruct/codeFiles';
import * as codeRelationships from './relationship/codeRelationships';
import * as Relationship from './relationship';
import ignore from 'ignore';
import { Queue } from './queue';

// 定期処理
class IntervalProcess {
	private _progress_total: number;
	private _progressed: number;
	private _queue = new Queue<Relationship.FileDifference>();
	private _results: PromiseSettledResult<void>[] = [];
	public constructor() {
		this._progress_total = 0;
		this._progressed = 0;
	}
	public set progress_total(value: number) {
		this._progress_total = value;
	}
	public set progressed(value: number) {
		this._progressed = value;
	}
	public get progress_total(): number {
		return this._progress_total;
	}
	public get progressed(): number {
		return this._progressed;
	}
	public request(fileDifference: Relationship.FileDifference, examine: Relationship.Examine,
		progress: (progressed: number, total: number) => void,
		log: (message: string, ...args: any[]) => void,
		err: (message: string, ...args: any[]) => void):
		Promise<PromiseSettledResult<void>[]> 
	{
		return new Promise<PromiseSettledResult<void>[]>( async (resolve, reject) => {
			const results: PromiseSettledResult<void>[] = [];
			this._queue.enqueue(fileDifference);
			while (this._queue.size > 0) {
				const file_diff = this._queue.dequeue();
				if (file_diff) {

					// 追加ファイルは、シンボルをコードから抽出する
					let upsert_count = await examine.fileAdditions(file_diff.additions, (code, doc, symbols) => {
						progress((this._progressed++ / 3) * 2, this._progress_total);
					});

					// 変更ファイルは、シンボルのテーブルと抽出から変更を分配する
					upsert_count += await examine.fileUpdates(file_diff.lists, file_diff.updates);
					this._progress_total += upsert_count;
					log(`Extructed symbols: ${upsert_count} files`);

					// 変更のないファイルは、シンボルテーブルを読み込む
					await examine.fileNotchanges(file_diff.notchanges, () => {
						progress((this._progressed++ / 3) * 3, this._progress_total);
					});
					log(`Not changed symbols ${file_diff.notchanges.length} files`);

					// 削除ファイルは、ファイル削除に追加する
					examine.fileRemoves(file_diff.removes, () => {
						progress((this._progressed++ / 3) * 2, this._progress_total);
					});
					
					// ファイル更新を追加する
					examine.updateRelationships(() => {
						progress(this._progressed++, this._progress_total);
					});
				}
			}
			resolve(results);
		}).catch((error) => {
			err('IntervalProcess request error:', error);
			return [];
		});
	}
}

let _logs: Logs | null = null;
const _interval_processe = new IntervalProcess();

// Phase 4: アクティブなグラフビジュアライゼーションの参照
let _activeGraphViz: Relationship.Visualization | null = null;

/**
 * デバウンス関数
 */
function debounce<T extends (...args: any[]) => void>(fn: T, delay: number): T {
	let timeoutId: NodeJS.Timeout | undefined;
	return ((...args: any[]) => {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		timeoutId = setTimeout(() => fn(...args), delay);
	}) as T;
}

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	try {
		// 拡張機能情報
		const package_json = context.extension.packageJSON;
		const short_name = package_json?.shortName || '';
		const version = package_json?.version || '';

		// ワークスペース情報
		const workspace_file = vscode.workspace.workspaceFile ? vscode.workspace.workspaceFile.fsPath : undefined;
		const workspace_folder = workspace_file ? path.dirname(workspace_file) : undefined;
		const workspace_basename = workspace_file ? path.basename(workspace_file, path.extname(workspace_file)) : undefined;

		// ファイルの関連付け設定
		const readSetting = (setting: object | undefined): object => setting ? setting : {};
		const associations = readSetting(vscode.workspace.getConfiguration("files").get<object>("associations"));

		// 動作環境ログ
		const logs = _logs = new Logs(package_json?.displayName);
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

		// ファイル監視
		if (workspace_folder && (Object.keys(associations).length > 0)) {
			for (const [pattern, language_id] of Object.entries(associations)) {
				const watcher = vscode.workspace.createFileSystemWatcher(
					new vscode.RelativePattern(workspace_folder, pattern)
				);
				// ファイル追加
				watcher.onDidCreate((uri) => {
					// .gitignoreを除外
					const ig = ignore().add(codeFiles.loadGitignorePatterns(workspace_folder));
					const relative_path = path.relative(workspace_folder, uri.fsPath);
					if (!ig.ignores(relative_path)) {
						logs.log(`on create ${language_id}: ${relative_path}`);
					} else {
						logs.error(`on create (ignored) ${language_id}: ${relative_path}`);
					}
				});
				// ファイル削除
				watcher.onDidDelete((uri) => {
					const relative_path = path.relative(workspace_folder, uri.fsPath);
					logs.log(`on delete ${language_id}: ${relative_path}`);
				});
				// ファイル変更
				watcher.onDidChange((uri) => {
					const relative_path = path.relative(workspace_folder, uri.fsPath);

					// コードにエラーが無い事を確認
					const diagnostics = vscode.languages.getDiagnostics(uri);
					const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
					if (errors.length === 0) {
						logs.log(`on change ${language_id}: ${relative_path}`);
					} else {
						logs.error(`on change ${errors.length} errors.`);
					}
				});
				context.subscriptions.push(watcher);
			}
		}

		// コード関係調査コマンドの登録
		context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.examineRelationships', async () => {

			// ログファイルの設定（.vscode/crd-examine.log）
			if (workspace_folder) {
				const logFile = path.join(workspace_folder, '.vscode', 'crd-examine.log');
				logs.setLogFile(logFile);
			}

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
				bar.text = `$(sync~spin) ${short_name}: ${processed.toLocaleString()}/${total.toLocaleString()} ${percentage.toFixed(2)}% ...${secondsToTime(rest_sec)} ${message}`;
			};
			updateCommand(status_bar, short_name, undefined, locale('examing-tooltip'));

			// ワークスペースが在り、ファイルの関連付けのパターンが在ったら
			if (workspace_folder && (Object.keys(associations).length > 0)) {
				const db_file = path.join(workspace_folder, '.vscode', 'crd.duckdb');
				try {
					// コード関係図DBを作成する
					const db = new codeDb.Db(db_file);
					await db.table_create();
					try {
						const interval = _interval_processe;
						const start = performance.now();

						// 進捗表示の初期化
						updateProgress(status_bar, start, interval.progressed, interval.progress_total);

						const examine = new Relationship.Examine(workspace_folder, db, message => logs.log(message), (message, error) => logs.error(message, error));

						// ファイルの差分を求める
						const file_diff = await examine.fileDifference(workspace_folder, associations, () => {
							updateProgress(status_bar, start, (interval.progressed++ / 3) * 1, interval.progress_total++);
						});
						await interval.request(file_diff, examine,
							(progressed, total) => updateProgress(status_bar, start, progressed, total),
							(message, params) => logs.log(message, params),
							(message, error) => logs.error(message, error));
						interval.progress_total += file_diff.additions.length + file_diff.updates.length + file_diff.notchanges.length + file_diff.removes.length;

						// インデックス作成待ち
						updateProgress(status_bar, start, interval.progressed, interval.progress_total, 'Waiting for indexing to complete...');
						const attempt = await codeRelationships.indexingCompleteWait(10);
						logs.log(`Waitied for indexing to complete... attempt ${attempt}`);

						// コード関係調査を登録する
						const results = await Promise.allSettled(examine.processes);
						const failures = results.filter(result => result.status === 'rejected');
						failures.map(result => logs.error(result.reason));
						if (failures.length > 0) {
							logs.error(`${failures.length}/${results.length} processes failed.`);
						}

						// DBを破棄する
						db.dispose();

						logs.log(`${secondsToTime(performance.now() - start)} ` +
							`processed ${file_diff.lists.length.toLocaleString()} files(` +
								`added ${file_diff.additions.length.toLocaleString()}, ` +
								`updated ${file_diff.updates.length.toLocaleString()}, ` +
								`no changed ${file_diff.notchanges.length.toLocaleString()}, ` +
								`removed ${file_diff.removes.length.toLocaleString()}) ` +
							`${examine.lineCount.toLocaleString()} lines, ` +
							`${examine.relationshipCount.toLocaleString()} relationships`);

						// コード関係図表示に切替える
						updateCommand(status_bar, short_name, 'vscode-code-relationship-diagram.showDiagram', locale('show-diagram-tooltip'));
					} catch (error) {
						setTimeout(() => status_bar.dispose(), 3000);
						logs.error(`codeFile.list(${workspace_folder}): `, error);
					} finally {
						// ログファイルを閉じる
						logs.closeLogFile();
					}
				} catch (error) {
					setTimeout(() => status_bar.dispose(), 3000);
					logs.error(`db.table_create(${db_file}): `, error);
					// ログファイルを閉じる
					logs.closeLogFile();
				}
			} else {
				setTimeout(() => status_bar.dispose(), 3000);
				logs.error(locale('error-no-associations'));
				// ログファイルを閉じる
				logs.closeLogFile();
			}
		}));

		// コード関係図表示コマンドの登録
		context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.showDiagram', async () => {

			// ログファイルの設定（.vscode/crd-show.log）
			if (workspace_folder) {
				const logFile = path.join(workspace_folder, '.vscode', 'crd-show.log');
				logs.setLogFile(logFile);
			}

			logs.log('=== SHOWDIAGRAM COMMAND STARTED ===');

			if (workspace_folder) {
				const db_file = path.join(workspace_folder, '.vscode', 'crd.duckdb');
				logs.log(`Attempting to open database: ${db_file}`);

				// DBファイルの存在確認
				logs.log('Checking database file existence:', db_file);
				if (!fs.existsSync(db_file)) {
					logs.error(locale('error-no-database'));
					// ログファイルを閉じる
					logs.closeLogFile();
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
					const graphViz = new Relationship.Visualization(context, workspace_folder, workspace_basename + '.crd.html', logs);

					// Phase 4: アクティブなグラフビジュアライゼーションを保存
					_activeGraphViz = graphViz;

					// パネル破棄時に参照をクリア
					graphViz.onDidDispose(() => {
						if (_activeGraphViz === graphViz) {
							_activeGraphViz = null;
							logs.log('[Phase4] Graph panel disposed');
						}
					});

					logs.log('Using Cosmos.gl view');
					await graphViz.showDiagram(all_symbols, all_rels);
					logs.log('Show Diagram completed');

					db.dispose();
					logs.info('Code relationship diagram displayed');
					// WebViewが閉じられたときにログファイルを閉じる
					graphViz.onDispose(() => {
						logs.closeLogFile();
					});
					} catch (error) {
						logs.error('Failed to show graph: ', error);
						logs.closeLogFile();
					}
				}
			} else {
				logs.error('No workspace folder found');
				// ログファイルを閉じる
				logs.closeLogFile();
			}
		}));

		// ========================================
		// Phase 4: VSCode統合 - 新しいコマンドとエディタイベント
		// ========================================

		// 現在のファイルにズームするコマンド
		context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.zoomToCurrentFile', () => {
			if (!_activeGraphViz || !_activeGraphViz.isActive()) {
				vscode.window.showWarningMessage('Code Relationship Diagram is not open. Please run "Show Code Relationship Diagram" first.');
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (editor) {
				_activeGraphViz.zoomToFile(editor.document.uri.fsPath);
				logs.log(`[Phase4] Zoom to current file: ${editor.document.uri.fsPath}`);
			} else {
				vscode.window.showWarningMessage('No active editor.');
			}
		}));

		// 選択範囲の関連コードを表示するコマンド
		context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.showRelatedInGraph', () => {
			if (!_activeGraphViz || !_activeGraphViz.isActive()) {
				vscode.window.showWarningMessage('Code Relationship Diagram is not open. Please run "Show Code Relationship Diagram" first.');
				return;
			}

			const editor = vscode.window.activeTextEditor;
			if (editor) {
				const selection = editor.selection;
				_activeGraphViz.showRelatedCode(
					editor.document.uri.fsPath,
					selection.start.line,
					selection.end.line
				);
				logs.log(`[Phase4] Show related code: ${editor.document.uri.fsPath}:${selection.start.line}-${selection.end.line}`);
			} else {
				vscode.window.showWarningMessage('No active editor.');
			}
		}));

		// エディタイベントリスナー（デバウンス付き）
		const debouncedCursorChange = debounce((event: vscode.TextEditorSelectionChangeEvent) => {
			if (_activeGraphViz && _activeGraphViz.isActive()) {
				_activeGraphViz.sendEditorCursorChange(
					event.textEditor.document.uri.fsPath,
					event.selections[0].start.line
				);
			}
		}, 300);

		// アクティブエディタ変更時
		context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && _activeGraphViz && _activeGraphViz.isActive()) {
				_activeGraphViz.sendEditorFileOpen(editor.document.uri.fsPath);
			}
		}));

		// カーソル位置変更時（デバウンス付き）
		context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(debouncedCursorChange));

		logs.log('[Phase4] Editor event listeners registered');

	} catch (activationError) {
		console.error('CRITICAL: Extension activation failed:', activationError);
		if (activationError instanceof Error) {
			console.error('Error stack:', activationError.stack);
		}
		vscode.window.showErrorMessage(`Failed to activate Code Relationship Diagram extension: ${activationError}`);
		throw activationError;
	}
}

// This method is called when your extension is deactivated
export function deactivate() {
	_logs?.info('extension is now deactivate!');
}
