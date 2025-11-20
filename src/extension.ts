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
	private _queue = new Queue<Promise<void>>();
	private _results: PromiseSettledResult<void>[] = [];
	private _timer: NodeJS.Timeout;
	constructor() {
		this._timer = setInterval(async () => {
			if (this._queue.size > 0) {
				const processes: Promise<void>[] = this._queue.isEmpty ? [] : this._queue.toArray();
				this._queue.clear();
				this._results.splice(0, this._results.length);

				// コード関係調査を実行する
				this._results = await Promise.allSettled(processes);
			}
		}, 500);
	}
	public request(processes: Promise<void>[]): Promise<PromiseSettledResult<void>[]> {
		return new Promise<PromiseSettledResult<void>[]>((resolve) => {
			processes.map(process => this._queue.enqueue(process));
			const process_count = this._queue.size;
			if (process_count > 0) {
				let phase = 0;
				const interval_id = setInterval(() => {
					switch (phase) {
						case 0:
							if (this._queue.isEmpty) {
								phase = 1;
							}
							break;
						case 1:
							if (this._results.length >= process_count) {
								resolve([...this._results]);
							}
							break;
					}
					if (this._queue.size === 0) {
						clearInterval(interval_id);
						Promise.allSettled(processes).then(results => resolve(results));
					}
				}, 100);
			} else {
				resolve([]);
			}
		});
	}
}

let _logs: Logs | null = null;
const _interval_processe = new IntervalProcess();


/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {

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
					// 開始時間
					const start = performance.now();

					// 進捗表示の初期化
					let progress_total = 0;
					let progressed = 0;
					updateProgress(status_bar, start, progressed, progress_total);

					const examine = new Relationship.Examine(workspace_folder, db, message => logs.log(message), (message, error) => logs.error(message, error));

					// ファイルの差分を求める
					const file_diff = await examine.fileDifference(workspace_folder, associations, () => {
						updateProgress(status_bar, start, (progressed++ / 3) * 1, progress_total++);
					});
					progress_total += file_diff.additions.length + file_diff.updates.length + file_diff.notchanges.length + file_diff.removes.length;

					// 追加ファイルは、シンボルをコードから抽出する
					let upsert_count = await examine.fileAdditions(file_diff.additions, (code, doc, symbols) => {
						updateProgress(status_bar, start, (progressed++ / 3) * 2, progress_total);
					});

					// 変更ファイルは、シンボルのテーブルと抽出から変更を分配する
					upsert_count += await examine.fileUpdates(file_diff.lists, file_diff.updates);
					progress_total += upsert_count;
					logs.log(`Extructed symbols: ${upsert_count} files`);

					// 変更のないファイルは、シンボルテーブルを読み込む
					await examine.fileNotchanges(file_diff.notchanges, () => {
						updateProgress(status_bar, start, (progressed++ / 3) * 3, progress_total);
					});
					logs.log(`Not changed symbols ${file_diff.notchanges.length} files`);

					// 削除ファイルは、ファイル削除に追加する
					examine.fileRemoves(file_diff.removes, () => {
						updateProgress(status_bar, start, (progressed++ / 3) * 2, progress_total);
					});
					
					// ファイル更新を追加する
					examine.updateRelationships(() => {
						updateProgress(status_bar, start, progressed++, progress_total);
					});

					// インデックス作成待ち
					updateProgress(status_bar, start, progressed, progress_total, 'Waiting for indexing to complete...');
					const attempt = await codeRelationships.indexingCompleteWait(10);
					logs.log(`Waitied for indexing to complete... attempt ${attempt}`);

					// コード関係調査を登録する
					const results = await _interval_processe.request(examine.processes);
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

	// コード関係図表示コマンドの登録
	context.subscriptions.push(vscode.commands.registerCommand('vscode-code-relationship-diagram.showDiagram', async () => {
		logs.log('=== SHOWDIAGRAM COMMAND STARTED ===');
		
		if (workspace_folder) {
			const db_file = path.join(workspace_folder, '.vscode', 'crd.duckdb');
			logs.log(`Attempting to open database: ${db_file}`);
			
			// DBファイルの存在確認
			logs.log('Checking database file existence:', db_file);
			if (!fs.existsSync(db_file)) {
				logs.error(locale('error-no-database'));
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
}

// This method is called when your extension is deactivated
export function deactivate() {
	_logs?.info('extension is now deactivate!');
}
