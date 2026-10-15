/**
 * @file 主経路の切替の検証 (docs/ast-plan.md Stage 4 の受け入れ基準)
 * @description
 * 自リポジトリを、拡張機能と同じ差分キューで AST の経路 (設定 ast.enabled = true) と LSP の経路 (false) の両方で調べ、
 * examineRelationships に当たる処理の時間を比べる。続けて AST の経路で調べた DB を LSP の経路へ戻し (ロールバック)、
 * もう一度 AST の経路へ戻して、図に表示する関係が経路に従って入れ替わる事を確かめる。
 * 結果は verification/ast-switch/report.md に書き出す (yarn verify:switch で再生成できる)。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as codeDb from '../codeDb';
import { Examined, Workbench, examineWorkspace, filePairsOf, openWorkbench, ratioOf, seconds, warmUpLanguageServer } from './examineWorkspace';

/** Stage 4 の受け入れ基準: AST の経路の時間が LSP の経路の時間に対してこの割合以下 */
const TIME_RATIO = 0.5;

/** ロールバック・再切り替えの後の図のファイル間の線が、初回と一致する割合の下限 (LSP の参照検索は実行ごとに揺れる) */
const PAIR_AGREEMENT = 0.95;

const OUTPUT = path.join('out', 'verify-switch');

suite('AST Switch', function () {

	test('主経路の切替: 実行時間・ロールバック', async () => {
		const bench = await openWorkbench(OUTPUT);
		// 経過を DB の隣に書く (失敗した時に、どこまで進んだかを後から調べるため)
		const progress = (message: string): void =>
			fs.appendFileSync(path.join(bench.root, OUTPUT, 'progress.log'), `${new Date().toISOString()} ${message}\n`);
		const astDb = new codeDb.Db(path.join(bench.root, OUTPUT, 'ast.duckdb'));
		const lspDb = new codeDb.Db(path.join(bench.root, OUTPUT, 'lsp.duckdb'));
		try {
			await astDb.table_create();
			await lspDb.table_create();

			// 言語サーバの起動を待ってから測る (どちらの経路もシンボルの抽出に言語サーバを使うため、起動の時間を含めない)
			await warmUpLanguageServer(bench.root);

			// 1. 初回の全走査 (DB が空) を両方の経路で行う
			progress('start');
			const ast = await examineWorkspace(bench, astDb, true);
			progress(`AST ${seconds(ast.elapsedMs)}`);
			const lsp = await examineWorkspace(bench, lspDb, false);
			progress(`LSP ${seconds(lsp.elapsedMs)}`);

			// 2. AST の経路で調べた DB をロールバックし、もう一度 AST の経路へ戻す
			const rollback = await examineWorkspace(bench, astDb, false);
			progress(`rollback ${seconds(rollback.elapsedMs)}`);
			const forward = await examineWorkspace(bench, astDb, true);
			progress(`forward ${seconds(forward.elapsedMs)}`);

			const files = ast.completed.processed;
			const report = formatReport({ bench, ast, lsp, rollback, forward, files });
			const reportFile = path.join(bench.root, 'verification', 'ast-switch', 'report.md');
			fs.mkdirSync(path.dirname(reportFile), { recursive: true });
			fs.writeFileSync(reportFile, report);
			console.log(`[AST switch] AST ${seconds(ast.elapsedMs)} / LSP ${seconds(lsp.elapsedMs)} = ${(ast.elapsedMs / lsp.elapsedMs * 100).toFixed(1)}% -> ${path.relative(bench.root, reportFile)}`);

			// 時間
			assert.ok(ast.elapsedMs <= lsp.elapsedMs * TIME_RATIO,
				`AST ${seconds(ast.elapsedMs)} should be <= ${TIME_RATIO * 100}% of LSP ${seconds(lsp.elapsedMs)}`);
			// 経路ごとに、図の関係の出所が入れ替わる (自リポジトリは TS/JS だけなので、片方は空)
			assert.ok(ast.ast.length > 0 && ast.lsp.length === 0, 'AST path should show only AST relationships');
			assert.ok(lsp.lsp.length > 0 && lsp.ast.length === 0, 'LSP path should show only LSP relationships');
			// ロールバック: 内容は変わっていないが、全ファイルを LSP の経路で調べ直す
			assert.strictEqual(rollback.examinedFiles, files, 'rollback should re-examine every file');
			assert.ok(rollback.lsp.length > 0 && rollback.ast.length === 0, 'rollback should show only LSP relationships');
			assert.ok(agreement(filePairsOf(rollback.lsp), filePairsOf(lsp.lsp)) >= PAIR_AGREEMENT, 'rollback should match the LSP path');
			// 再び AST の経路へ
			assert.strictEqual(forward.examinedFiles, files, 'switching back should re-examine every file');
			assert.ok(forward.ast.length > 0 && forward.lsp.length === 0, 'switching back should show only AST relationships');
			assert.ok(agreement(filePairsOf(forward.ast), filePairsOf(ast.ast)) >= PAIR_AGREEMENT, 'switching back should match the AST path');
		} catch (error) {
			progress(`failed: ${error instanceof Error ? error.stack : String(error)}`);
			throw error;
		} finally {
			astDb.dispose();
			lspDb.dispose();
			bench.parser.dispose();
		}
	});
});

/** 2つの集合の一致の割合 (共通部分 / 和集合) */
function agreement(a: Set<string>, b: Set<string>): number {
	const union = new Set([...a, ...b]);
	return union.size > 0 ? [...a].filter(pair => b.has(pair)).length / union.size : 1;
}

/** キューのログから、名前解決と LSP による確定の統計を取り出す */
function statsOf(examined: Examined, prefix: string): Record<string, number> {
	const found = examined.logs.find(message => message.startsWith(prefix)) ?? '';
	return found.includes('{') ? JSON.parse(found.slice(found.indexOf('{'))) as Record<string, number> : {};
}

/** レポート (Markdown) を組み立てる */
function formatReport(input: { bench: Workbench, ast: Examined, lsp: Examined, rollback: Examined, forward: Examined, files: number }): string {
	const { ast, lsp, rollback, forward } = input;
	const astPairs = filePairsOf(ast.ast);
	const lspPairs = filePairsOf(lsp.lsp);
	const common = [...astPairs].filter(pair => lspPairs.has(pair)).length;
	// 定義側が名前付きの宣言 (解決キーのあるシンボル) の LSP の関係だけの線。構造的な参照 (インターフェースのプロパティへの参照が
	// それを満たすオブジェクトリテラルのメンバへの参照として記録されたもの。verification/ast-accuracy) を除く
	const fqnOf = new Map(lsp.symbols.map(symbol => [symbol.id, symbol.fqn]));
	const namedPairs = filePairsOf(lsp.lsp.filter(relationship => (fqnOf.get(relationship.define.id) ?? null) !== null));
	const namedCommon = [...namedPairs].filter(pair => astPairs.has(pair)).length;
	const structuralOnly = [...lspPairs].filter(pair => !namedPairs.has(pair)).length;
	const verification = statsOf(ast, 'Verified relationships:');
	const row = (label: string, examined: Examined, note: string): string =>
		`| ${label} | ${seconds(examined.elapsedMs)} | ${examined.examinedFiles.toLocaleString()} | ` +
		`${examined.lsp.length.toLocaleString()} | ${examined.ast.length.toLocaleString()} | ` +
		`${filePairsOf([...examined.lsp, ...examined.ast]).size.toLocaleString()} | ${note} |`;
	return [
		'# 主経路の切替の検証レポート',
		'',
		'`yarn verify:switch` が生成する（手で編集しない）。自リポジトリを拡張機能と同じ差分キューで、AST の経路（設定 `ast.enabled = true`）と',
		'LSP の経路（`false`）の両方で調べた結果。比較の方法は `verification/ast-switch/README.md` を参照。',
		'',
		`- 生成日時: ${new Date().toISOString()}`,
		`- VS Code: ${vscode.version}`,
		`- 対象: ${input.files.toLocaleString()} ファイル（TS/JS）、シンボル ${ast.symbols.length.toLocaleString()}`,
		`- 図の関係: 確信度 0.7 以上の AST 由来の関係と、LSP 由来の関係（ファイル間のみ。シンボルの組で一意）`,
		'',
		'## 結果',
		'',
		'| 指標 | 値 | 基準 |',
		'| ---- | -- | ---- |',
		`| **examineRelationships の時間（AST / LSP）** | **${(ast.elapsedMs / lsp.elapsedMs * 100).toFixed(1)}%**（${seconds(ast.elapsedMs)} / ${seconds(lsp.elapsedMs)}） | ≤ ${TIME_RATIO * 100}% |`,
		`| ロールバック後の図のファイル間の線（LSP の経路との一致） | ${(agreement(filePairsOf(rollback.lsp), lspPairs) * 100).toFixed(1)}% | ≥ ${PAIR_AGREEMENT * 100}% |`,
		`| 再切り替え後の図のファイル間の線（AST の経路との一致） | ${(agreement(filePairsOf(forward.ast), astPairs) * 100).toFixed(1)}% | ≥ ${PAIR_AGREEMENT * 100}% |`,
		'',
		'時間は、全走査でキューに積んでから、キューが空になって名前解決（と AST の経路では LSP による確定）を終えるまで。',
		'言語サーバの起動を待ってから測る（どちらの経路もシンボルの抽出に言語サーバを使う）。',
		'',
		'## 調査ごとの内訳',
		'',
		'| 調査 | 時間 | 調べたファイル | 図の関係（LSP 由来） | 図の関係（AST 由来） | 図のファイル間の線 | 備考 |',
		'| ---- | ---- | -------------- | -------------------- | -------------------- | ------------------ | ---- |',
		row('AST の経路（初回）', ast, '空の DB'),
		row('LSP の経路（初回）', lsp, '空の DB（Stage 3 までの動作）'),
		row('ロールバック', rollback, 'AST の経路の DB を `ast.enabled = false` で全走査'),
		row('再切り替え', forward, 'ロールバックした DB を `ast.enabled = true` で全走査'),
		'',
		'## 図のファイル間の線の比較（初回の AST の経路 と LSP の経路）',
		'',
		'| 指標 | 値 | 読み方 |',
		'| ---- | -- | ---- |',
		`| LSP の経路の線のうち AST の経路にもある | ${ratioOf(common, lspPairs.size)} | 切り替えで消える線 |`,
		`| うち構造的な参照だけの線 | ${structuralOnly.toLocaleString()} 本 | 定義側が名前付きの宣言でない LSP の関係（オブジェクトリテラルのメンバ・無名コールバック）だけから成る線。依存ではないため AST の経路では出さない（Stage 2 で決定） |`,
		`| 構造的な参照を除いた LSP の経路の線のうち AST の経路にもある | ${ratioOf(namedCommon, namedPairs.size)} | 残りは文脈による参照（オブジェクトリテラルのキー）と、型を引けない値のメンバ参照（verification/ast-accuracy の取りこぼし） |`,
		`| AST の経路の線のうち LSP の経路にもある | ${ratioOf(common, astPairs.size)} | AST のみの線は、import 文・再エクスポート・言語サーバが扱わないファイルなど LSP の経路が記録しない依存を含む |`,
		'',
		'## LSP による確定（AST の経路の初回）',
		'',
		'| 結果 | 件数 |',
		'| ---- | ---- |',
		...['queried', 'confirmed', 'replaced', 'dropped', 'unanswered', 'unlocated'].map(key => `| ${key} | ${(verification[key] ?? 0).toLocaleString()} |`),
		'',
	].join('\n');
}
