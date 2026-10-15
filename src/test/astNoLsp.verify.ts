/**
 * @file 言語サーバ未導入の状態の検証 (docs/ast-plan.md Stage 4 の受け入れ基準)
 * @description
 * TypeScript の言語機能 (vscode.typescript-language-features。tsserver を起動する組込みの拡張機能) を無効にした VS Code で
 * 自リポジトリを調べ、AST の経路なら TS/JS の関係が図に出る事を確かめる (LSP の経路では出ない)。
 * 言語サーバのシンボルが無いため、関係はファイル (ルートシンボル) 同士の線になる。
 * 結果は verification/ast-switch/no-lsp.md に書き出す (yarn verify:switch で再生成できる)。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as codeDb from '../codeDb';
import { examineWorkspace, filePairsOf, openWorkbench, seconds } from './examineWorkspace';

const OUTPUT = path.join('out', 'verify-no-lsp');

suite('AST without language server', function () {

	test('言語サーバ未導入でも TS/JS の関係が出る', async () => {
		// 起動引数 --disable-extension で TypeScript の言語機能を無効にしている事を確かめる
		assert.strictEqual(vscode.extensions.getExtension('vscode.typescript-language-features'), undefined,
			'vscode.typescript-language-features should be disabled (run with the nolsp label)');

		const bench = await openWorkbench(OUTPUT);
		const astDb = new codeDb.Db(path.join(bench.root, OUTPUT, 'ast.duckdb'));
		const lspDb = new codeDb.Db(path.join(bench.root, OUTPUT, 'lsp.duckdb'));
		try {
			await astDb.table_create();
			await lspDb.table_create();
			const ast = await examineWorkspace(bench, astDb, true);
			const lsp = await examineWorkspace(bench, lspDb, false);

			const files = ast.completed.processed;
			const roots = ast.symbols.filter(symbol => symbol.parentId === null).length;
			const astPairs = filePairsOf(ast.ast);
			const report = [
				'# 言語サーバ未導入の状態の検証レポート',
				'',
				'`yarn verify:switch` が生成する（手で編集しない）。TypeScript の言語機能（`vscode.typescript-language-features`）を',
				'無効にした VS Code で自リポジトリを調べた結果。',
				'',
				`- 生成日時: ${new Date().toISOString()}`,
				`- VS Code: ${vscode.version}`,
				`- 対象: ${files.toLocaleString()} ファイル（TS/JS）、シンボル ${ast.symbols.length.toLocaleString()}（うちファイルのルートシンボル ${roots.toLocaleString()}）`,
				'',
				'| 経路 | 時間 | 図の関係（LSP 由来） | 図の関係（AST 由来） | 図のファイル間の線 |',
				'| ---- | ---- | -------------------- | -------------------- | ------------------ |',
				`| AST の経路（\`ast.enabled = true\`） | ${seconds(ast.elapsedMs)} | ${ast.lsp.length.toLocaleString()} | ${ast.ast.length.toLocaleString()} | ${astPairs.size.toLocaleString()} |`,
				`| LSP の経路（\`ast.enabled = false\`） | ${seconds(lsp.elapsedMs)} | ${lsp.lsp.length.toLocaleString()} | ${lsp.ast.length.toLocaleString()} | ${filePairsOf(lsp.lsp).size.toLocaleString()} |`,
				'',
				'言語サーバのシンボルが無いため、AST 由来の関係はファイル（ルートシンボル）同士の線になる。',
				'シンボルの抽出は言語サーバの起動を待って1ファイルあたり最大 5 回試すため、時間の大半はその待ちである。',
				'',
			].join('\n');
			const reportFile = path.join(bench.root, 'verification', 'ast-switch', 'no-lsp.md');
			fs.mkdirSync(path.dirname(reportFile), { recursive: true });
			fs.writeFileSync(reportFile, report);
			console.log(`[AST without LSP] AST ${ast.ast.length} relationships (${astPairs.size} file pairs), LSP ${lsp.lsp.length} -> ${path.relative(bench.root, reportFile)}`);

			assert.strictEqual(roots, ast.symbols.length, 'without the language server, only the root symbols should be extracted');
			assert.ok(astPairs.size > 0, 'the AST path should show relationships between TS/JS files');
			assert.strictEqual(lsp.lsp.length, 0, 'the LSP path should show no relationships without the language server');
		} finally {
			astDb.dispose();
			lspDb.dispose();
			bench.parser.dispose();
		}
	});
});
