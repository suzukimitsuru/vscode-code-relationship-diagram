/**
 * @file 名前解決の精度検証 (docs/ast-plan.md §11 / Stage 2 の受け入れ基準)
 * @description
 * 自リポジトリを、拡張機能と同じ差分キュー (LSP による従来の関係調査 + AST の事実抽出 + 名前解決) で調べ、
 * LSP 由来の関係を正解として AST 由来の関係の再現率・適合率を測る。結果は
 * verification/ast-accuracy/report.md に書き出す (yarn verify:accuracy で再生成できる)。
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Ast from '../extruct/ast';
import * as codeDb from '../codeDb';
import { scanDifference } from '../relationship/examine';
import { Completed, QueueProcessor } from '../relationship/fileDifference/queue';
import { AccuracyMetric, AccuracyReport, compareRelationships } from '../relationship/accuracy';
import { RelationshipV2 } from '../relationship/resolve';

/** 拡張機能の files.associations 相当 (自リポジトリの TS/JS。verification/ast-facts と同じ) */
const ASSOCIATIONS = {
	'**/*.ts': 'typescript',
	'**/*.tsx': 'typescriptreact',
	'**/*.js': 'javascript',
	'**/*.mjs': 'javascript',
	'**/*.cjs': 'javascript',
};

/** Stage 2 の受け入れ基準: import 由来の関係の再現率 */
const IMPORT_DERIVED_RECALL = 0.95;

/** Stage 3 の受け入れ基準: 確信度 0.7 以上の関係で、シンボル単位の再現率・適合率 */
const STAGE3_THRESHOLD = 0.7;
const STAGE3_RECALL = 0.9;
const STAGE3_PRECISION = 0.9;

/** 取りこぼしの一覧に載せる件数 */
const MISSED_LIMIT = 50;

const percent = (metric: AccuracyMetric): string => `${(metric.ratio * 100).toFixed(1)}%（${metric.matched.toLocaleString()} / ${metric.total.toLocaleString()}）`;

suite('AST Accuracy', function () {

	test('名前解決の再現率 (対 LSP)', async () => {
		const extension = vscode.extensions.getExtension('suzukimitsuru.vscode-code-relationship-diagram');
		assert.ok(extension, 'extension should be found');
		const root = extension.extensionPath;
		// DB は調べやすいよう out/ (gitignore 済み) に残す。前回の結果は消してから始める
		const output = path.join(root, 'out', 'verify-accuracy');
		fs.rmSync(output, { recursive: true, force: true });
		fs.mkdirSync(output, { recursive: true });
		const parser = await Ast.AstParser.create(Ast.resolveAstResources(root));
		const db = new codeDb.Db(path.join(output, 'crd.duckdb'));
		const logs: string[] = [];
		const errors: unknown[] = [];
		let processor: QueueProcessor | null = null;
		try {
			await db.table_create();

			// 1. 拡張機能と同じ差分キューで自リポジトリ全体を調べる (LSP + AST + 名前解決)
			const started = performance.now();
			processor = new QueueProcessor({
				workspaceFolder: root, db: db,
				facts: new Ast.FactsExtractor(parser, new Ast.ModuleResolver(root)),
				log: (message) => logs.push(message),
				error: (message, error) => errors.push(`${message}${error instanceof Error ? error.message : String(error)}`),
				progress: () => {},
			});
			const completed = new Promise<Completed>(resolve => processor!.onCompleted(resolve));
			const difference = await scanDifference(root, ASSOCIATIONS, db, () => {}, () => {});
			processor.enqueueDifference(difference);
			const result = await completed;
			const elapsed = performance.now() - started;
			assert.deepStrictEqual(errors, [], 'the queue should process every file without errors');

			// 2. LSP 由来の関係と AST 由来の関係を突き合わせる
			const symbols = (await db.executeQuery('SELECT id, parent_id, path, fqn FROM table_symbols'))
				.map(row => ({ id: row.id as string, parentId: row.parent_id as string | null, path: row.path as string, fqn: row.fqn as string | null }));
			const lsp = (await db.executeQuery('SELECT reference_id, define_id FROM table_relationships'))
				.map(row => ({ referenceId: row.reference_id as string, defineId: row.define_id as string }));
			const ast = await db.relationships_v2_query();
			const occurrences = (await db.executeQuery('SELECT enclosing_fqn, kind, root_name, member_path FROM table_occurrences'))
				.map(row => ({ enclosingFqn: row.enclosing_fqn as string, kind: row.kind as Ast.RelationshipKind, rootName: row.root_name as string, memberPath: row.member_path as string | null }));
			const report = compareRelationships(symbols, lsp, ast, occurrences);

			// 3. レポートを書き出す
			const resolved = logs.find(message => message.startsWith('Resolved relationships:')) ?? '';
			const stats = resolved.includes('{') ? JSON.parse(resolved.slice(resolved.indexOf('{'))) as Record<string, number> : {};
			const markdown = formatReport({
				report, ast, stats, files: difference.lists.length, processed: result.processed,
				symbols: symbols.length, attached: symbols.filter(symbol => symbol.fqn !== null).length,
				lsp: lsp.length, elapsed,
			});
			const reportFile = path.join(root, 'verification', 'ast-accuracy', 'report.md');
			fs.mkdirSync(path.dirname(reportFile), { recursive: true });
			fs.writeFileSync(reportFile, markdown);
			console.log(`[AST accuracy] import-derived recall ${percent(report.importDerived)}, file recall ${percent(report.fileRecall)} -> ${path.relative(root, reportFile)}`);

			const stage3 = report.byThreshold.find(entry => entry.threshold === STAGE3_THRESHOLD);
			console.log(`[AST accuracy] confidence >= ${STAGE3_THRESHOLD}: recall ${stage3 ? percent(stage3.recall) : '-'}, precision ${stage3 ? percent(stage3.precision) : '-'}`);
			assert.ok(report.importDerived.ratio >= IMPORT_DERIVED_RECALL,
				`import-derived recall ${percent(report.importDerived)} should be >= ${IMPORT_DERIVED_RECALL * 100}%`);
			assert.ok(stage3 && stage3.recall.ratio >= STAGE3_RECALL && stage3.precision.ratio >= STAGE3_PRECISION,
				`at confidence >= ${STAGE3_THRESHOLD}, recall and precision should be >= 90%`);
		} finally {
			await processor?.dispose();
			db.dispose();
			parser.dispose();
		}
	});
});

/** レポート (Markdown) を組み立てる */
function formatReport(input: {
	report: AccuracyReport, ast: RelationshipV2[], stats: Record<string, number>,
	files: number, processed: number, symbols: number, attached: number, lsp: number, elapsed: number,
}): string {
	const { report, ast, stats } = input;
	const byKind = new Map<string, number>();
	for (const relationship of ast) {
		const kind = Ast.RelationshipKind[relationship.kind];
		byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
	}
	const intraFile = ast.filter(relationship => relationship.isIntraFile).length;
	const lines = [
		'# 名前解決の精度検証レポート',
		'',
		'`yarn verify:accuracy` が生成する（手で編集しない）。自リポジトリを拡張機能と同じ差分キューで調べ、',
		'LSP 由来の関係（`table_relationships`）を正解として AST 由来の関係（`table_relationships_v2`）を突き合わせた結果。',
		'比較の方法は `verification/ast-accuracy/README.md` を参照。',
		'',
		`- 生成日時: ${new Date().toISOString()}`,
		`- VS Code: ${vscode.version}`,
		`- 名前解決: 段1 ファイル内の定義・段2 import・段3 型推論・段4 一意名・段4' 曖昧候補`,
		`- 対象: ${input.files.toLocaleString()} ファイル（処理 ${input.processed.toLocaleString()}）、シンボル ${input.symbols.toLocaleString()}（解決キー付き ${input.attached.toLocaleString()}）`,
		`- 所要時間: ${(input.elapsed / 1000).toFixed(0)} 秒（LSP の参照検索を含む）`,
		'',
		'## 結果',
		'',
		'| 指標 | 値 | 備考 |',
		'| ---- | -- | ---- |',
		`| **import 由来の関係の再現率** | **${percent(report.importDerived)}** | Stage 2 の受け入れ基準（≥ ${IMPORT_DERIVED_RECALL * 100}%）。LSP の関係のうち定義がトップレベルのもの |`,
		...report.byThreshold.filter(entry => entry.threshold === STAGE3_THRESHOLD).flatMap(entry => [
			`| **シンボル単位の再現率（確信度 ≥ ${entry.threshold}）** | **${percent(entry.recall)}** | Stage 3 の受け入れ基準（≥ ${STAGE3_RECALL * 100}%） |`,
			`| **シンボル単位の適合率（確信度 ≥ ${entry.threshold}）** | **${percent(entry.precision)}** | Stage 3 の受け入れ基準（≥ ${STAGE3_PRECISION * 100}%） |`,
		]),
		`| ファイル単位の再現率 | ${percent(report.fileRecall)} | 参照元ファイル → 定義ファイル |`,
		`| ファイル単位の適合率 | ${percent(report.filePrecision)} | |`,
		'',
		'### 確信度の閾値ごと（シンボル単位）',
		'',
		'| 確信度 | 再現率 | 適合率 |',
		'| ------ | ------ | ------ |',
		...report.byThreshold.map(entry => `| ≥ ${entry.threshold} | ${percent(entry.recall)} | ${percent(entry.precision)} |`),
		'',
		'### 解決の段ごとの適合率（関係の組の最大の確信度で分類）',
		'',
		'| 段 | 適合率 |',
		'| -- | ------ |',
		// 段1 はファイル内の関係だけを出すため、ファイル間の比較には現れない
		...report.byBand.map(band => `| ${band.label} | ${band.precision.total > 0 ? percent(band.precision) : '－（ファイル間の関係なし）'} |`),
		'',
		`LSP 由来の関係 ${input.lsp.toLocaleString()} 件のうち、比較から除いたもの:`,
		'',
		`- 定義側が名前付きの宣言でない（構造的な参照）: ${report.structuralLsp.toLocaleString()} 件。オブジェクトリテラルのメンバ・無名コールバックなど。`,
		'  TypeScript の構造的な型付けにより、インターフェースのプロパティへの参照が、それを満たすオブジェクトリテラルのメンバへの参照として記録される',
		`- オブジェクトリテラルのキーによる参照（文脈による型付け）: ${report.contextualLsp.toLocaleString()} 件。`,
		'  `const f: FileFacts = { definitions: … }` や `push({ id })` のキーが、代入先・引数・戻り値の型のプロパティへの参照として記録される。',
		'  参照元にその名前がキーとしてだけ現れるものを数える（Stage 3 で構造的な参照として扱うと決めた）',
		`- シンボルが解決キーに辿り着けない: ${report.unmappedLsp.toLocaleString()} 件`,
		'',
		'## AST 由来の関係の内訳',
		'',
		'| 種類 | 件数 |',
		'| ---- | ---- |',
		...[...byKind.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `| ${kind} | ${count.toLocaleString()} |`),
		`| （合計） | ${ast.length.toLocaleString()}（うちファイル内 ${intraFile.toLocaleString()}） |`,
		'',
		'## 解決の内訳（参照出現）',
		'',
		'| 区分 | 件数 | 意味 |',
		'| ---- | ---- | ---- |',
		`| 段1 ファイル内の定義 | ${(stats.local ?? 0).toLocaleString()} | |`,
		`| 段2 import | ${(stats.imported ?? 0).toLocaleString()} | うちモジュール単位 ${(stats.module ?? 0).toLocaleString()}（export 名の定義が見つからない） |`,
		`| 段3 型推論 | ${(stats.inferred ?? 0).toLocaleString()} | this・型注釈・new・戻り値・要素（反復・添字）・分割代入の取り出し元の型からメンバを引いた |`,
		`| 段4 一意名 | ${(stats.unique ?? 0).toLocaleString()} | 型の分からない値のメンバ・束縛の無い名前を、プロジェクトで1つだけの同名の定義へ |`,
		`| 段4' 曖昧候補 | ${(stats.ambiguous ?? 0).toLocaleString()} | 同名の定義が2〜4個。各候補へ弱い関係（破棄 ${(stats.ambiguousDropped ?? 0).toLocaleString()}） |`,
		`| import 文 | ${(stats.importEdges ?? 0).toLocaleString()} | ファイル → 取り込んだ定義・モジュール |`,
		`| 自分自身・内側への参照 | ${(stats.self ?? 0).toLocaleString()} | 関係にしない |`,
		`| 型の分からないローカルな値のメンバ | ${(stats.localBinding ?? 0).toLocaleString()} | 型注釈の無い引数・型の手掛かりの無い変数など。関係にしない |`,
		`| this / super | ${(stats.thisOrSuper ?? 0).toLocaleString()} | 囲むクラスかメンバが見つからない |`,
		`| ファイル内に束縛が無い | ${(stats.unbound ?? 0).toLocaleString()} | グローバル・組込み（段5 未解決） |`,
		`| オブジェクトリテラルのキー | ${(stats.objectKey ?? 0).toLocaleString()} | 文脈の型のプロパティへの参照。名前では解決しない |`,
		`| プロジェクト外への import | ${(stats.external ?? 0).toLocaleString()} | |`,
		`| 解決できない import | ${(stats.unresolvedImport ?? 0).toLocaleString()} | |`,
		'',
		`## LSP のみが見つけた import 由来の関係（${report.missedImportDerived.length.toLocaleString()} 件${report.missedImportDerived.length > MISSED_LIMIT ? `、先頭 ${MISSED_LIMIT} 件` : ''}）`,
		'',
		...(report.missedImportDerived.length === 0 ? ['なし'] : [
			'| 参照元 | 定義 |',
			'| ------ | ---- |',
			...report.missedImportDerived.slice(0, MISSED_LIMIT).map(([reference, define]) => `| \`${reference}\` | \`${define}\` |`),
		]),
		'',
		`## LSP のみが見つけたファイルの組（${report.lspOnlyFiles.length.toLocaleString()} 件）`,
		'',
		'型の手掛かりの無い値のメンバ参照、インターフェースを満たすオブジェクトリテラル（文脈による型付け）による依存、言語サーバがスクリプトのトップレベルの変数を別ファイルの同名の変数と結び付けたものなど。',
		'',
		...(report.lspOnlyFiles.length === 0 ? ['なし'] : [
			'| 参照元ファイル | 定義ファイル |',
			'| -------------- | ------------ |',
			...report.lspOnlyFiles.slice(0, MISSED_LIMIT).map(([reference, define]) => `| \`${reference}\` | \`${define}\` |`),
		]),
		'',
		`## AST のみが見つけたファイルの組（${report.astOnlyFiles.length.toLocaleString()} 件）`,
		'',
		'LSP の経路が記録しない依存を含む: 再エクスポート（`export * from`）と、まとめ役の index への名前空間 import（LSP は元の定義のファイルへ帰属させる）、',
		'言語サーバが扱わないファイル（JSON・tsconfig の対象外・`.mjs`）、LSP の参照検索の取りこぼし。',
		'',
		...(report.astOnlyFiles.length === 0 ? ['なし'] : [
			'| 参照元ファイル | 定義ファイル | 関係の種類 |',
			'| -------------- | ------------ | ---------- |',
			...report.astOnlyFiles.slice(0, MISSED_LIMIT).map(([reference, define, kinds]) =>
				`| \`${reference}\` | \`${define}\` | ${kinds.map(kind => Ast.RelationshipKind[kind]).join(', ')} |`),
		]),
		'',
	];
	return lines.join('\n');
}
