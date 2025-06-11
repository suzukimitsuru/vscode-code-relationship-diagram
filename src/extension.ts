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
	const disposable = vscode.commands.registerCommand('vscode-code-relationship-diagram.initialize', () => {

		// ワークスペースが在り、ファイルの関連付けのパターンが在ったら
		const workspace_folders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders : [];
		const root_folder = selectRootFolder(workspace_folders);
		const associations = readConfiguration(vscode.workspace.getConfiguration("files").get<object>("associations"));
		if (root_folder && (Object.keys(associations).length > 0)) {

			// コード関係図DBを作成する
			const db = new codeDb.Db(path.join(root_folder.uri.path, '.vscode', 'crd.duckdb'));
			////context.subscriptions.push(db);
			db.table_create().then(async () => {

				// コードファイルを列挙する
				const patterns = codeFile.list(root_folder.uri.path, associations);
				try {
					// コードファイルを収集する
					let files: codeFile.Resolve[] = [];
					for (const pattern of patterns) { 
						const paths = await pattern;
						for (const path of paths) {
							files.push(await path);
						}
					}

					// コードファイルをパスでソートする
					const sorted = files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

					// コードファイルを更新する
					for (const file of files) {
						db.codeFile_upsert(file.relative_path, file.updated).then(() => {
							logs.debug(`upsert ${file.updated.toLocaleString()} ${file.language_id} ${file.relative_path}`);	
						}).catch((error: Error) => {
							logs.trace(`db.codeFile_insert(${file.relative_path}): ${error.message}`);
						});
					}

					// 初期化メッセージを表示する
					logs.info(locale('initialize-message'));
				} catch (error) {
					const reject = error as codeFile.Reject;
					logs.trace(`codeFile.list(${reject.context}): ${reject.error.message}`);
				}
			}).catch((error: Error) => {
				logs.trace(`db.table_create(): ${error.message}`);
			});
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
