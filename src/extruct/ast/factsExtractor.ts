/** @file Phase A: 1ファイルの事実抽出 (ローカル事実 + import の解決) */
import { AstParser } from './parser';
import { AstDefinition, AstImport, AstOccurrence, collectLocalFacts } from './localFacts';
import { ModuleResolution, ModuleResolver } from './moduleResolver';

/** 解決済みの import 束縛 */
export interface ResolvedImport extends AstImport, ModuleResolution {}

/** 1ファイルの事実 (DuckDB の table_imports / table_occurrences と、シンボルの解決キーの元) */
export interface FileFacts {
    readonly relativePath: string;
    readonly definitions: AstDefinition[];
    readonly imports: ResolvedImport[];
    readonly occurrences: AstOccurrence[];

    /** 構文エラーを含むか (含んでも抽出はする) */
    readonly hasError: boolean;

    /** パース・抽出・import 解決に掛かった時間 (ミリ秒) */
    readonly elapsedMs: number;
}

/**
 * 事実抽出器
 * @description 1ファイル1パースで定義・import・参照出現を抽出し、import をワークスペース内のファイルへ解決する。
 *              VSCode API に依存しないため、単体テストと検証スクリプトからも同じ経路で使える
 */
export class FactsExtractor {
    private readonly _parser: AstParser;
    private readonly _resolver: ModuleResolver;

    public constructor(parser: AstParser, resolver: ModuleResolver) {
        this._parser = parser;
        this._resolver = resolver;
    }

    /**
     * その language id の事実を抽出できるか
     * @param languageId VSCode の language id
     * @returns 抽出できれば true
     */
    public isSupported(languageId: string): boolean {
        return this._parser.isSupported(languageId);
    }

    /**
     * 1ファイルの事実を抽出する
     * @param relativePath ワークスペース相対パス
     * @param languageId VSCode の language id
     * @param source ソースコード (シンボル抽出と同じ内容を渡す事。名前の位置で突き合わせるため)
     * @returns 事実。未対応の language id なら null
     */
    public async extract(relativePath: string, languageId: string, source: string): Promise<FileFacts | null> {
        const started = performance.now();
        const local = await collectLocalFacts(this._parser, languageId, relativePath, source);
        if (!local) {
            return null;
        }
        const imports = local.imports.map(entry => ({ ...entry, ...this._resolver.resolve(relativePath, entry.moduleSpec) }));
        return {
            relativePath: relativePath,
            definitions: local.definitions,
            imports: imports,
            occurrences: local.occurrences,
            hasError: local.hasError,
            elapsedMs: performance.now() - started,
        };
    }
}
