/** @file Code Relationship Diagram extension for Visual Studio Code */
import * as vscode from 'vscode';

/** 各国語サポート nls: National Language Support */
import localeEn from '../package.nls.json';
import localeJa from '../package.nls.ja.json';
export type LocaleKeyType = keyof typeof localeEn;
interface LocaleEntry { [key : string] : string; }
const localeTableKey = vscode.env.language;
const localeTable = Object.assign(localeEn, ((<{[key : string] : LocaleEntry}>{
    ja : localeJa
})[localeTableKey] || { }));
const localeString = (key : string) : string => localeTable[key] || key;
const localeMap = (key : LocaleKeyType) : string => localeString(key);

/**
 * @function 拡張機能の有効化イベント
 * @param context extention contexest
 */
export function activate(context: vscode.ExtensionContext) {
	console.log('extension "vscode-code-dependency-diagram" is now active!');

	// 挨拶を表示するコマンドの登録
	const disposable = vscode.commands.registerCommand('vscode-code-dependency-diagram.helloWorld', () => {
		// 右下にメッセージを表示する
		vscode.window.showInformationMessage(localeMap('hello-message'));
	});
	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {
	console.log('extension "vscode-code-dependency-diagram" is now deactivate!');
}
