/**
 * @file 検証用: 拡張機能と同じ差分キューで自リポジトリを調べ、図に表示する関係を読む (yarn verify:switch)
 * @description 統合テスト・検証のファイル (*.test.ts / *.verify.ts) ではないため、単独では実行されない
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import * as Ast from '../extruct/ast';
import * as codeDb from '../codeDb';
import * as SYMBOL from '../extruct/symbol';
import { scanDifference } from '../relationship/examine';
import { Completed, QueueProcessor } from '../relationship/fileDifference/queue';
import { queryDiagramRelationships } from '../relationship/astRelationships';
import { Relationship, indexingCompleteWait } from '../relationship/codeRelationships';

/** 拡張機能の files.associations 相当 (自リポジトリの TS/JS。verification/ast-accuracy と同じ) */
export const ASSOCIATIONS = {
	'**/*.ts': 'typescript',
	'**/*.tsx': 'typescriptreact',
	'**/*.js': 'javascript',
	'**/*.mjs': 'javascript',
	'**/*.cjs': 'javascript',
};

/** 図に表示する関係の確信度の下限 (設定 ast.confidenceThreshold の既定) */
export const DIAGRAM_THRESHOLD = 0.7;

/** 1回の調査の結果 */
export interface Examined {
	/** キューに積んでから完了 (名前解決・LSP による確定を含む) までの時間 (ミリ秒) */
	readonly elapsedMs: number;
	readonly completed: Completed;
	/** 全走査で調べ直しになったファイルの数 (内容の変更・追加・調査経路の切り替え) */
	readonly examinedFiles: number;
	/** シンボル (ファイルのルートシンボルを含む) */
	readonly symbols: SYMBOL.SymbolModel[];
	/** 図に表示する関係 */
	readonly lsp: Relationship[];
	readonly ast: Relationship[];
	/** キューのログ */
	readonly logs: string[];
}

/** 検証の環境 (拡張機能のフォルダ・パーサ) */
export interface Workbench {
	readonly root: string;
	readonly parser: Ast.AstParser;
}

/**
 * 検証の環境を用意する
 * @param output 出力先のフォルダ (out/ の下。前回の結果は消す)
 */
export async function openWorkbench(output: string): Promise<Workbench> {
	const extension = vscode.extensions.getExtension('suzukimitsuru.vscode-code-relationship-diagram');
	if (!extension) {
		throw new Error('extension should be found');
	}
	const root = extension.extensionPath;
	fs.rmSync(path.join(root, output), { recursive: true, force: true });
	fs.mkdirSync(path.join(root, output), { recursive: true });
	return { root, parser: await Ast.AstParser.create(Ast.resolveAstResources(root)) };
}

/**
 * 拡張機能と同じ差分キューで自リポジトリを全走査し、キューが空になるまで待つ
 * @param bench 検証の環境
 * @param db DB (同じ DB で続けて呼べば、2回目は差分だけを調べる)
 * @param astEnabled 設定 ast.enabled
 * @returns 時間と、図に表示する関係
 */
export async function examineWorkspace(bench: Workbench, db: codeDb.Db, astEnabled: boolean): Promise<Examined> {
	const logs: string[] = [];
	const errors: string[] = [];
	const processor = new QueueProcessor({
		workspaceFolder: bench.root, db: db,
		facts: new Ast.FactsExtractor(bench.parser, new Ast.ModuleResolver(bench.root)),
		astEnabled: () => astEnabled,
		confidenceThreshold: () => DIAGRAM_THRESHOLD,
		log: (message) => logs.push(message),
		error: (message, error) => errors.push(`${message}${error instanceof Error ? error.message : String(error)}`),
		progress: () => {},
	});
	try {
		const started = performance.now();
		const completion = new Promise<Completed>(resolve => processor.onCompleted(resolve));
		const difference = await scanDifference(bench.root, ASSOCIATIONS, db, () => {}, () => {},
			languageId => processor.relationshipModeOf(languageId));
		processor.enqueueDifference(difference);
		const completed = await completion;
		const elapsedMs = performance.now() - started;
		if (errors.length > 0) {
			throw new Error(`the queue should process every file without errors: ${errors.join(' / ')}`);
		}
		const symbols = await db.symbol_quaryAll();
		const { lsp, ast } = await queryDiagramRelationships(db, symbols, DIAGRAM_THRESHOLD);
		return { elapsedMs, completed, examinedFiles: difference.toItems().length, symbols, lsp, ast, logs };
	} finally {
		await processor.dispose();
	}
}

/** 図のファイル間の線 (参照元ファイル → 定義ファイル) */
export function filePairsOf(relationships: readonly Relationship[]): Set<string> {
	return new Set(relationships
		.filter(relationship => relationship.reference.path !== relationship.define.path)
		.map(relationship => JSON.stringify([relationship.reference.path, relationship.define.path])));
}

/** 秒 (小数1桁) */
export const seconds = (milliSeconds: number): string => `${(milliSeconds / 1000).toFixed(1)} 秒`;

/** 割合 */
export const ratioOf = (matched: number, total: number): string =>
	`${total > 0 ? ((matched / total) * 100).toFixed(1) : '-'}%（${matched.toLocaleString()} / ${total.toLocaleString()}）`;

/**
 * 言語サーバ (tsserver) がプロジェクトを読み終えるまで待つ
 * @param root 拡張機能のフォルダ (自リポジトリ)
 * @description 起動の直後は参照検索が空を返す。キューの再試行 (3 回) では間に合わず、最初に調べるファイルの関係が抜ける
 */
export async function warmUpLanguageServer(root: string): Promise<void> {
	const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, 'src', 'extension.ts')));
	for (let attempt = 0; attempt < 60; attempt++) {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri);
		const references = await vscode.commands.executeCommand<vscode.Location[]>('vscode.executeReferenceProvider', document.uri,
			symbols?.[0]?.selectionRange.start ?? new vscode.Position(0, 0));
		if (symbols && symbols.length > 0 && references && references.length > 0) {
			break;
		}
		await new Promise(resolve => setTimeout(resolve, 1000));
	}
	await indexingCompleteWait(10);
}
