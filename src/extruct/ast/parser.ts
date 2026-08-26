/** @file tree-sitter パーササービス */
import * as fs from 'fs';
import * as path from 'path';
import { AstResources, RUNTIME_WASM_NAME } from './resources';

// web-tree-sitter は ESM 版と CJS 版の両方を公開している。
// ESM 版は `createRequire(import.meta.url)` で WASM を読むため、CJS へバンドルすると
// `import.meta.url` が undefined になり初期化に失敗する。
// `import = require` で読み込むと esbuild が CJS 版を選ぶ（verification/ast-parser/ で確認する）。
import treeSitter = require('web-tree-sitter');
type Language = treeSitter.Language;
type Node = treeSitter.Node;
type Query = treeSitter.Query;
type QueryMatch = treeSitter.QueryMatch;
type Tree = treeSitter.Tree;

/** 対応言語の定義 */
export interface AstLanguageSpec {

    /** VSCode の language id */
    readonly languageId: string;

    /** 文法の名前 (`tree-sitter-<grammar>.wasm` として遅延ロードする) */
    readonly grammar: string;

    /** クエリファイルの名前 (`dist/queries/<queryFile>`) */
    readonly queryFile: string;
}

/** 対応言語の一覧 (言語追加は原則ここと .scm の追加だけで済む) */
export const AST_LANGUAGES: readonly AstLanguageSpec[] = [
    { languageId: 'typescript', grammar: 'typescript', queryFile: 'typescript.scm' },
    { languageId: 'typescriptreact', grammar: 'tsx', queryFile: 'typescript.scm' },
    { languageId: 'javascript', grammar: 'javascript', queryFile: 'javascript.scm' },
    { languageId: 'javascriptreact', grammar: 'javascript', queryFile: 'javascript.scm' },
];

/**
 * language id から対応言語の定義を引く
 * @param languageId VSCode の language id
 * @returns 対応していれば定義、未対応なら null
 */
export function astLanguageOf(languageId: string): AstLanguageSpec | null {
    return AST_LANGUAGES.find(language => language.languageId === languageId) ?? null;
}

/** クエリのキャプチャ1件 (構文木を保持せずに済むよう素のデータへ写し取る) */
export interface AstCapture {

    /** キャプチャ名 (`def.class` / `ref.call` など。そのまま種類の判定に使う) */
    readonly name: string;

    /** キャプチャされたノードの文字列 */
    readonly text: string;

    /** 同じマッチに属するキャプチャを束ねる番号 */
    readonly matchIndex: number;

    /** 開始行 (0起点) */
    readonly startLine: number;

    /** 開始桁 (0起点) */
    readonly startCharacter: number;

    /** 終了行 (0起点) */
    readonly endLine: number;

    /** 終了桁 (0起点) */
    readonly endCharacter: number;
}

/** web-tree-sitter の初期化は拡張機能で1回だけ行う */
let _initialized: Promise<void> | null = null;
const initializeRuntime = (resources: AstResources): Promise<void> => {
    if (!_initialized) {
        const runtime = path.join(resources.wasmDirectory, RUNTIME_WASM_NAME);
        if (!fs.existsSync(runtime)) {
            return Promise.reject(new Error(`web-tree-sitter runtime not found: ${runtime}`));
        }
        // 失敗を握り込むと以後ずっと生成できなくなるため、失敗時は初期化からやり直せるようにする
        _initialized = treeSitter.Parser.init({ locateFile: () => runtime }).catch(error => {
            _initialized = null;
            throw error;
        });
    }
    return _initialized;
};

/**
 * tree-sitter パーササービス
 * @description
 * - 本体の初期化は拡張機能の起動時に1回だけ行う
 * - 言語 WASM は language id が初めて出現した時に遅延ロードし、文法名でキャッシュする
 * - 構文木は保持せず、1ファイル1パースで事実を抽出したら破棄する
 * - 未対応の language id では null を返し、呼び出し側は LSP 経路へフォールバックする
 */
export class AstParser {

    /** 資産の在り処 */
    private readonly _resources: AstResources;

    /** 文法名 -> 言語 (遅延ロードのキャッシュ) */
    private readonly _languages = new Map<string, Language>();

    /** 文法名 -> ロード中の言語 (同時要求の二重ロードを防ぐ) */
    private readonly _loadings = new Map<string, Promise<Language>>();

    /** クエリファイル名 + 文法名 -> コンパイル済みクエリ */
    private readonly _queries = new Map<string, Query>();

    /** 破棄済みか */
    private _disposed = false;

    private constructor(resources: AstResources) {
        this._resources = resources;
    }

    /**
     * パーササービスを生成する (本体 WASM の初期化を含む)
     * @param resources 資産の在り処
     * @returns パーササービス
     */
    public static async create(resources: AstResources): Promise<AstParser> {
        await initializeRuntime(resources);
        return new AstParser(resources);
    }

    /**
     * その language id を AST で扱えるか
     * @param languageId VSCode の language id
     * @returns 扱えれば true
     */
    public isSupported(languageId: string): boolean {
        return astLanguageOf(languageId) !== null;
    }

    /** ロード済みの文法名 */
    public get loadedGrammars(): string[] {
        return [...this._languages.keys()].sort();
    }

    /**
     * 言語を取得する (初回のみ WASM をロードする)
     * @param spec 対応言語の定義
     * @returns 言語
     */
    private async language(spec: AstLanguageSpec): Promise<Language> {
        const loaded = this._languages.get(spec.grammar);
        if (loaded) {
            return loaded;
        }
        let loading = this._loadings.get(spec.grammar);
        if (!loading) {
            const wasm = path.join(this._resources.wasmDirectory, `tree-sitter-${spec.grammar}.wasm`);
            loading = treeSitter.Language.load(wasm).then(language => {
                this._languages.set(spec.grammar, language);
                this._loadings.delete(spec.grammar);
                return language;
            }).catch(error => {
                this._loadings.delete(spec.grammar);
                throw new Error(`failed to load grammar '${spec.grammar}' from ${wasm}: ${error instanceof Error ? error.message : String(error)}`);
            });
            this._loadings.set(spec.grammar, loading);
        }
        return loading;
    }

    /**
     * クエリを取得する (初回のみ .scm を読んでコンパイルする)
     * @param spec 対応言語の定義
     * @param language 言語
     * @returns コンパイル済みクエリ
     */
    private query(spec: AstLanguageSpec, language: Language): Query {
        const key = `${spec.grammar}/${spec.queryFile}`;
        const cached = this._queries.get(key);
        if (cached) {
            return cached;
        }
        const source = path.join(this._resources.queryDirectory, spec.queryFile);
        const compiled = new treeSitter.Query(language, fs.readFileSync(source, 'utf8'));
        this._queries.set(key, compiled);
        return compiled;
    }

    /**
     * 1ファイルをパースし、構文木を使う処理を実行する
     * @param languageId VSCode の language id
     * @param source ソースコード
     * @param body 構文木を使う処理 (戻り値を返した時点で構文木は破棄される)
     * @returns 処理の戻り値。未対応の language id なら null
     * @description 構文木を外へ持ち出さない事でメモリを節約する
     */
    public async withTree<T>(languageId: string, source: string, body: (root: Node, language: Language) => T): Promise<T | null> {
        if (this._disposed) {
            throw new Error('AstParser is already disposed');
        }
        const spec = astLanguageOf(languageId);
        if (!spec) {
            return null;
        }
        const language = await this.language(spec);
        const parser = new treeSitter.Parser();
        let tree: Tree | null = null;
        try {
            parser.setLanguage(language);
            tree = parser.parse(source);
            if (!tree) {
                return null;
            }
            return body(tree.rootNode, language);
        } finally {
            tree?.delete();
            parser.delete();
        }
    }

    /**
     * 1ファイルをパースしてクエリのキャプチャを取り出す
     * @param languageId VSCode の language id
     * @param source ソースコード
     * @returns キャプチャの一覧。未対応の language id なら null
     */
    public async captures(languageId: string, source: string): Promise<AstCapture[] | null> {
        const spec = astLanguageOf(languageId);
        if (!spec) {
            return null;
        }
        return this.withTree(languageId, source, (root, language) => {
            const matches: QueryMatch[] = this.query(spec, language).matches(root);
            const captures: AstCapture[] = [];
            matches.forEach((match, matchIndex) => {
                for (const capture of match.captures) {
                    captures.push({
                        name: capture.name,
                        text: capture.node.text,
                        matchIndex: matchIndex,
                        startLine: capture.node.startPosition.row,
                        startCharacter: capture.node.startPosition.column,
                        endLine: capture.node.endPosition.row,
                        endCharacter: capture.node.endPosition.column,
                    });
                }
            });
            return captures;
        });
    }

    /** 保持している言語とクエリを解放する */
    public dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        for (const query of this._queries.values()) {
            query.delete();
        }
        this._queries.clear();
        // Language は web-tree-sitter が解放を提供していないため参照を落とすだけにする
        this._languages.clear();
        this._loadings.clear();
    }
}
