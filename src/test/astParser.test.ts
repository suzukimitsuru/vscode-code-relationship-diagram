/** @file 拡張機能ホスト上で AST パーサが動く事の統合テスト */
import * as assert from 'assert';
import * as vscode from 'vscode';
import * as Ast from '../extruct/ast';

suite('AST Parser Test Suite', () => {

	/** 実機と同じく拡張機能のルートから資産を解決する */
	const extensionRoot = (): string => {
		const extension = vscode.extensions.getExtension('suzukimitsuru.vscode-code-relationship-diagram');
		assert.ok(extension, 'extension should be found');
		return extension.extensionPath;
	};

	test('配布物から WASM がロードされる', async () => {
		const resources = Ast.resolveAstResources(extensionRoot());
		assert.deepStrictEqual(Ast.missingAstResources(resources), [], 'AST assets should be packaged');

		const parser = await Ast.AstParser.create(resources);
		try {
			assert.deepStrictEqual(parser.loadedGrammars, [], 'no grammar should be loaded yet');

			const source = 'import { Base } from "./base";\nexport class Sample extends Base { run(x: Target): void { new Helper(); } }';
			const hasError = await parser.withTree('typescript', source, root => root.hasError);
			assert.strictEqual(hasError, false, 'typescript should be parsed without error');
			assert.deepStrictEqual(parser.loadedGrammars, ['typescript'], 'typescript grammar should be loaded on demand');

			const captures = await parser.captures('typescript', source);
			assert.ok(captures && captures.length > 0, 'captures should be extracted');
			const names = captures.map(capture => `${capture.name}:${capture.text}`);
			assert.ok(names.includes('def.class:Sample'), `def.class should be captured: ${names.join(', ')}`);
			assert.ok(names.includes('ref.inheritance:Base'), `ref.inheritance should be captured: ${names.join(', ')}`);
			assert.ok(names.includes('ref.instantiation:Helper'), `ref.instantiation should be captured: ${names.join(', ')}`);
		} finally {
			parser.dispose();
		}
	});

	test('未対応の言語はフォールバックのため null を返す', async () => {
		const parser = await Ast.AstParser.create(Ast.resolveAstResources(extensionRoot()));
		try {
			assert.strictEqual(parser.isSupported('rust'), false, 'rust should not be supported');
			assert.strictEqual(await parser.captures('rust', 'fn main() {}'), null, 'unsupported language should return null');
		} finally {
			parser.dispose();
		}
	});
});
