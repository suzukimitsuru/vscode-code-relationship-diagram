/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFiles from './extruct/codeFiles';
import * as Relationship from './relationship';
import ignore from 'ignore';

let _logs: Logs | null = null;

// アクティブなグラフビジュアライゼーションの参照
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
export async function activate(context: vscode.ExtensionContext) {
	try {
		// 拡張機能情報
		const package_json = context.extension.packageJSON;
		const short_name = package_json?.shortName || '';
		const version = package_json?.version || '';

		// ワークスペース情報
		const workspace_file = vscode.workspace.workspaceFile ? vscode.workspace.workspaceFile.fsPath : undefined;
		const workspace_folder = workspace_file ? path.dirname(workspace_file) : undefined;
		const workspace_basename = workspace_file ? path.basename(workspace_file, path.extname(workspace_file)) : undefined;

		// ファイルの関連付け設定（*.code-workspace / settings.json の変更を検知して再読込する）
		const readSetting = (setting: object | undefined): object => setting ? setting : {};
		let associations = readSetting(vscode.workspace.getConfiguration("files").get<object>("associations"));

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

		// 時間表示ユーティリティ
		const secondsToTime = (milliSeconds: number): string => {
			const hours = Math.floor(milliSeconds / 3600000);
			const minutes = Math.floor((milliSeconds % 3600000) / 60000);
			const secs = Math.floor((milliSeconds % 60000) / 1000);
			let time = milliSeconds >= 3600000 ? String(hours).padStart(2, '0') + ':' : '';
			time += milliSeconds >= 60000 ? String(minutes).padStart(2, '0') + ':' : '';
			time += milliSeconds >= 10000 ? String(secs).padStart(2, '0') : milliSeconds >= 1000 ? String(secs) : '0';
			return time;
		};

		// 進捗表示更新
		const updateProgress = (bar: vscode.StatusBarItem, start: number, processed: number, total: number, message: string = '') => {
			const percentage = total > 0 ? (processed / total) * 100 : 0.00;
			const processed_msec = performance.now() - start;
			const rest_sec = percentage > 0 ? (processed_msec / percentage) * (total - processed) : 0;
			bar.text = `$(sync~spin) ${short_name}: ${processed.toLocaleString()}/${total.toLocaleString()} ${percentage.toFixed(2)}% ...${secondsToTime(rest_sec)} ${message}`;
		};

		// 進捗表示の起点時刻（キュー処理開始時に更新）
		let progress_start = performance.now();

		// データベースの事前生成とキュープロセッサの生成
		let db: codeDb.Db | undefined;
		let queueProcessor: Relationship.FileDifference.QueueProcessor | undefined;
		let db_file = '';
		if (workspace_folder) {
			db_file = path.join(workspace_folder, '.vscode', 'crd.duckdb');
			fs.mkdirSync(path.dirname(db_file), { recursive: true });
			db = new codeDb.Db(db_file);
			await db.table_create();

			queueProcessor = new Relationship.FileDifference.QueueProcessor({
				workspaceFolder: workspace_folder,
				db,
				log: (message) => logs.log(message),
				error: (message, error) => logs.error(message, error),
				progress: (processed, total, message) => updateProgress(status_bar, progress_start, processed, total, message),
			});
			queueProcessor.onCompleted(() => {
				// コード関係図表示に切替える
				updateCommand(status_bar, short_name, 'vscode-code-relationship-diagram.showDiagram', locale('show-diagram-tooltip'));
				logs.closeLogFile();
			});
			queueProcessor.onError((error) => {
				logs.error('Queue processing error:', error);
			});
			const created_db = db;
			const created_processor = queueProcessor;
			context.subscriptions.push({ dispose: () => { void created_processor.dispose().then(() => created_db.dispose()); } });
		}

		// コード関係調査の共通処理: 全走査でファイルの差分を求めてキューに追加する
		const enqueueFullScan = async (): Promise<void> => {
			if (!workspace_folder || !db || !queueProcessor) { return; }
			try {
				if (!queueProcessor.isProcessing) {
					progress_start = performance.now();
				}
				let scanned = 0;
				const difference = await Relationship.scanDifference(workspace_folder, associations, db,
					message => logs.log(message), () => {
						updateProgress(status_bar, progress_start, 0, ++scanned, 'Scanning files...');
					});
				queueProcessor.enqueueDifference(difference);
			} catch (error) {
				logs.error('enqueueFullScan: ', error);
			}
		};

		// watcherイベントの共通処理: 該当1ファイルだけをキューに追加する（全走査はしない）
		const enqueueUpsert = (uri: vscode.Uri, language_id: string): void => {
			if (!workspace_folder || !queueProcessor) { return; }
			try {
				if (!queueProcessor.isProcessing) {
					progress_start = performance.now();
				}
				const relative_path = path.relative(workspace_folder, uri.fsPath);
				const stats = fs.statSync(uri.fsPath);
				queueProcessor.enqueue(Relationship.FileDifference.Item.upsert(
					new codeFiles.File(relative_path, language_id, stats.mtime)));
			} catch (error) {
				logs.error('enqueueUpsert: ', error);
			}
		};
		const enqueueRemove = (uri: vscode.Uri): void => {
			if (!workspace_folder || !queueProcessor) { return; }
			if (!queueProcessor.isProcessing) {
				progress_start = performance.now();
			}
			const relative_path = path.relative(workspace_folder, uri.fsPath);
			queueProcessor.enqueue(Relationship.FileDifference.Item.remove(relative_path));
		};

		// ファイル監視: files.associationsのパターンごとにFileSystemWatcherを生成する
		const setupAssociationWatchers = (assoc: object): vscode.Disposable[] => {
			if (!workspace_folder || Object.keys(assoc).length === 0) { return []; }
			const watchers: vscode.Disposable[] = [];
			for (const [pattern, language_id] of Object.entries(assoc)) {
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
						enqueueUpsert(uri, typeof language_id === 'string' ? language_id : '');
					} else {
						logs.error(`on create (ignored) ${language_id}: ${relative_path}`);
					}
				});
				// ファイル削除
				watcher.onDidDelete((uri) => {
					const relative_path = path.relative(workspace_folder, uri.fsPath);
					logs.log(`on delete ${language_id}: ${relative_path}`);
					enqueueRemove(uri);
				});
				// ファイル変更
				watcher.onDidChange((uri) => {
					const relative_path = path.relative(workspace_folder, uri.fsPath);
					// コードにエラーが無い事を確認
					const diagnostics = vscode.languages.getDiagnostics(uri);
					const errors = diagnostics.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
					if (errors.length === 0) {
						logs.log(`on change ${language_id}: ${relative_path}`);
						enqueueUpsert(uri, typeof language_id === 'string' ? language_id : '');
					} else {
						logs.error(`on change ${errors.length} errors.`);
					}
				});
				watchers.push(watcher);
			}
			return watchers;
		};
		let associationWatchers = setupAssociationWatchers(associations);
		// 拡張機能停止時に、その時点で有効なwatcherを破棄する
		context.subscriptions.push({ dispose: () => { for (const watcher of associationWatchers) { watcher.dispose(); } } });

		// *.code-workspace / settings.json の files.associations 変更を検知し、watcherと関連付けを再読込する
		context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(debounce((e: vscode.ConfigurationChangeEvent) => {
			if (!workspace_folder || !e.affectsConfiguration('files.associations')) { return; }
			logs.log('files.associations changed, reloading watchers...');
			for (const watcher of associationWatchers) { watcher.dispose(); }
			associations = readSetting(vscode.workspace.getConfiguration("files").get<object>("associations"));
			associationWatchers = setupAssociationWatchers(associations);
			void enqueueFullScan();
		}, 300)));

		// コード関係調査コマンドの登録
		context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.examineRelationships', async () => {

			// ログファイルの設定（.vscode/crd-examine.log）
			if (workspace_folder) {
				const logFile = path.join(workspace_folder, '.vscode', 'crd-examine.log');
				logs.setLogFile(logFile);
			}

			await enqueueFullScan();
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

						// アクティブなグラフビジュアライゼーションを保存
						_activeGraphViz = graphViz;

						// パネル破棄時に参照をクリア
						graphViz.onDidDispose(() => {
							if (_activeGraphViz === graphViz) {
								_activeGraphViz = null;
								logs.log('[Phase4] Graph panel disposed');
							}
						});

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

		// 現在のファイルへのズームコマンドの登録
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

		// コード関係図を開いていて、アクティブエディタ変更時、ファイルオープンを送信する
		context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
			if (editor && _activeGraphViz && _activeGraphViz.isActive()) {
				_activeGraphViz.sendEditorFileOpen(editor.document.uri.fsPath);
			}
		}));

		// コード関係図を開いていて、カーソル位置変更時、カーソル位置を送信する
		context.subscriptions.push(vscode.window.onDidChangeTextEditorSelection(
			debounce((event: vscode.TextEditorSelectionChangeEvent) => {
				if (_activeGraphViz && _activeGraphViz.isActive()) {
					_activeGraphViz.sendEditorCursorChange(
						event.textEditor.document.uri.fsPath,
						event.selections[0].start.line
					);
				}
			}, 300)
		));

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
