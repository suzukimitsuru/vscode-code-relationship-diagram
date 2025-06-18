/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';
import * as path from 'path';
import locale from './locale';
import { Logs } from './logs';
import * as codeDb from './codeDb';
import * as codeFile from './codeFiles';

let _logs: Logs | null = null;

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	const logs = _logs = new Logs(context.extension.packageJSON?.displayName);
	logs.info('extension is now active!');

	// 初期化するコマンドの登録
	const disposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.initialize', async () => {

		// ワークスペースが在り、ファイルの関連付けのパターンが在ったら
		const workspace_folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders : [];
		const root_folder = selectRootFolder(workspace_folders);
		const associations = readConfiguration(vscode.workspace.getConfiguration("files").get<object>("associations"));
		if (root_folder && (Object.keys(associations).length > 0)) {
			try {
				// コード関係図DBを作成する
				const db = new codeDb.Db(path.join(root_folder.uri.path, '.vscode', 'crd.duckdb'));
				await db.table_create();
				try {
					const start = performance.now();

					// コードファイルを列挙する
					const files: codeFile.File[] = [];
					const patterns = codeFile.list(root_folder.uri.path, associations, (file: codeFile.File) => {
						files.push(file);
						logs.info(`${(performance.now() - start).toFixed(2)} ms: list ${file.relative_path}`);
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
							logs.info(`${(performance.now() - start).toFixed(2)} ms: upsert ${upsert.relative_path}`);
						} catch (error) {
							logs.trace(`db.codeFile_upsert(${upsert.relative_path}): ${error instanceof Error ? error.message : error}`);
						}
					}

					// コードファイルを削除する
					for (const remove of removes) {
						try {
							await db.codeFile_remove(remove);
							logs.info(`${(performance.now() - start).toFixed(2)} ms: remove ${remove}`);
						} catch (error) {
							logs.trace(`db.codeFile_remove(${remove}): ${error instanceof Error ? error.message : error}`);
						}
					}

					logs.info(`${(performance.now() - start).toFixed(2)} ms`);

					// 初期化メッセージを表示する
					logs.info(locale('initialize-message'));
				} catch (error) {
					logs.trace(`codeFile.list(${root_folder.uri.path}): ${error instanceof Error ? error.message : error}`);
				}
			} catch (error) {
				logs.trace(`db.table_create(): ${error instanceof Error ? error.message : error}`);
			}
		} else {
			logs.error(locale('error-no-associations'));
		}
	});
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	_logs?.info('extension is now deactivate!');
}

function selectRootFolder(folders: readonly vscode.WorkspaceFolder[]): vscode.WorkspaceFolder | null {
	// フォルダが1つ以上在って
	return (folders.length > 0)
		// パスの長さが最小のフォルダのパス名を返す
		? folders.reduce((min, current) => current.uri.path.length < min.uri.path.length ? current : min)
		: null;
}

function readConfiguration(config: object | undefined): object {
	return config ? config : {};
}
