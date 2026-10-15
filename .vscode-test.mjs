import { defineConfig } from '@vscode/test-cli';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// VS Code はユーザーデータのフォルダに IPC ソケットを作る。macOS のソケットのパスは 103 文字までで、
// VS Code 1.141 は超えると listen EINVAL で起動できない（1.105 は警告だけで動いていた）。
// 既定の .vscode-test/user-data ではリポジトリの置き場所次第で超えるため、一時フォルダの下に置く
const userDataDir = path.join(os.tmpdir(), 'crd-vscode-test');

// 前回の実行で残った設定や状態を持ち越さないよう、テストの前に消す
fs.rmSync(userDataDir, { recursive: true, force: true });

export default defineConfig([
	{
		// 統合テスト (yarn test)
		label: 'integration',
		files: 'out/test/**/*.test.js',
		launchArgs: [`--user-data-dir=${userDataDir}`],
	},
	{
		// 名前解決の精度検証 (yarn verify:accuracy)。自リポジトリ全体を LSP と AST の両方で調査するため時間が掛かる
		label: 'accuracy',
		files: 'out/test/astAccuracy.verify.js',
		launchArgs: [`--user-data-dir=${userDataDir}`],
		mocha: { timeout: 60 * 60 * 1000 },
	},
	{
		// 主経路の切替の検証 (yarn verify:switch)。自リポジトリを AST の経路と LSP の経路で調べて時間を比べ、ロールバックを確かめる
		label: 'switch',
		files: 'out/test/astSwitch.verify.js',
		launchArgs: [`--user-data-dir=${userDataDir}`],
		mocha: { timeout: 60 * 60 * 1000 },
	},
	{
		// 言語サーバ未導入の状態の検証 (yarn verify:switch)。TypeScript の言語機能 (tsserver) を無効にして起動する
		label: 'nolsp',
		files: 'out/test/astNoLsp.verify.js',
		launchArgs: [`--user-data-dir=${userDataDir}`, '--disable-extension=vscode.typescript-language-features'],
		mocha: { timeout: 60 * 60 * 1000 },
	},
]);
