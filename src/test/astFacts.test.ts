/** @file 拡張機能ホスト上で AST の事実が言語サーバのシンボルと結び付く事の統合テスト (docs/ast-plan.md Stage 1) */
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Ast from '../extruct/ast';
import * as codeDb from '../codeDb';
import * as codeFiles from '../extruct/codeFiles';
import { attachAstKeys } from '../extruct/codeSymbols';
import { CancelToken, ExamineTask } from '../relationship/examine';
import { SymbolCache } from '../relationship/fileDifference/symbolCache';

suite('AST Facts Test Suite', function () {
	// 言語サーバの起動とシンボル抽出を待つため、既定の2秒では足りない
	this.timeout(10 * 60 * 1000);

	/** 実機と同じく拡張機能のルートから資産を解決する (自リポジトリを解析対象のワークスペースとして使う) */
	const extensionRoot = (): string => {
		const extension = vscode.extensions.getExtension('suzukimitsuru.vscode-code-relationship-diagram');
		assert.ok(extension, 'extension should be found');
		return extension.extensionPath;
	};
	const sourcesOf = (root: string): string[] => {
		const found: string[] = [];
		const collect = (directory: string): void => {
			for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
				const full = path.join(directory, entry.name);
				if (entry.isDirectory()) { collect(full); }
				else if (entry.name.endsWith('.ts')) { found.push(path.relative(root, full)); }
			}
		};
		collect(path.join(root, 'src'));
		return found.sort();
	};

	test('AST の定義が言語サーバのシンボルに付く', async () => {
		const root = extensionRoot();
		const parser = await Ast.AstParser.create(Ast.resolveAstResources(root));
		const extractor = new Ast.FactsExtractor(parser, new Ast.ModuleResolver(root));
		const db = new codeDb.Db(':memory:');
		const task = new ExamineTask(root, db, new SymbolCache(async () => [], async () => [], () => false), () => {});
		try {
			let symbols = 0;
			let attached = 0;
			let exported = 0;
			let exportedAttached = 0;
			const unmatched = new Map<string, number>();
			const missingExports: string[] = [];
			for (const relativePath of sourcesOf(root)) {
				const { doc, symbols: found } = await task.extructSymbols(relativePath);
				const facts = await extractor.extract(relativePath, 'typescript', doc.getText());
				assert.ok(facts, `${relativePath}: facts should be extracted`);
				attached += attachAstKeys(relativePath, found, facts.definitions);
				symbols += found.length - 1;
				for (const symbol of found.filter(symbol => symbol.parentId && !symbol.fqn)) {
					const key = vscode.SymbolKind[symbol.kind];
					unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
				}
				// export された定義は Stage 2 の import 解決の結合先になるため、シンボルに付いていなければならない
				const attachedFqns = new Set(found.map(symbol => symbol.fqn));
				for (const definition of facts.definitions.filter(definition => definition.exportName !== null)) {
					exported++;
					if (attachedFqns.has(definition.fqn)) {
						exportedAttached++;
					} else {
						missingExports.push(definition.fqn);
					}
				}
			}
			const ratio = (numerator: number, denominator: number): string => `${numerator}/${denominator} (${(numerator * 100 / Math.max(denominator, 1)).toFixed(1)}%)`;
			console.log(`[AST facts] symbols attached ${ratio(attached, symbols)}`);
			console.log(`[AST facts] exported definitions attached ${ratio(exportedAttached, exported)}`);
			console.log(`[AST facts] unmatched symbols by kind: ${[...unmatched.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind} ${count}`).join(', ')}`);
			assert.deepStrictEqual(missingExports, [], 'every exported definition should be attached to a symbol');
			assert.ok(symbols > 0 && attached > 0, 'symbols should be extracted and attached');
		} finally {
			db.dispose();
			parser.dispose();
		}
	});

	test('upsert で事実とシンボルの解決キーが保存される', async () => {
		const root = extensionRoot();
		const parser = await Ast.AstParser.create(Ast.resolveAstResources(root));
		const extractor = new Ast.FactsExtractor(parser, new Ast.ModuleResolver(root));
		const db = new codeDb.Db(':memory:');
		const relativePath = path.join('src', 'distributor.ts');
		try {
			await db.table_create();
			const task = new ExamineTask(root, db, new SymbolCache(async () => [], async () => [], () => false), () => {}, extractor);
			const file = new codeFiles.File(relativePath, 'typescript', fs.statSync(path.join(root, relativePath)).mtime);
			const plan = await task.computeUpsert(file, false, new CancelToken(relativePath));
			await task.commitUpsert(plan);

			const saved = await db.symbol_query(relativePath);
			const distribute = saved.find(symbol => symbol.name === 'distribute');
			assert.strictEqual(distribute?.fqn, `${relativePath}#distribute`);
			assert.strictEqual(distribute?.exportName, 'distribute');
			const facts = await db.facts_query(relativePath);
			assert.ok(facts.occurrences.length > 0, 'occurrences should be saved');
			assert.strictEqual((await db.codeFile_queryFactsVersions()).get(relativePath), Ast.FACTS_VERSION);
		} finally {
			db.dispose();
			parser.dispose();
		}
	});
});
