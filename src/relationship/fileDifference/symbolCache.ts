/** @file シンボルキャッシュ: 参照解決に必要なファイルのシンボル表だけを遅延ロードする */
import * as SYMBOL from '../../extruct/symbol';

/** @description シンボル表のロード関数 */
export type SymbolLoader = (relativePath: string) => Promise<SYMBOL.SymbolModel[]>;

/**
 * @description シンボルキャッシュ
 * - 変更ファイルに関係しているファイル（参照検索で見つかった ref_path）だけを対象に、
 *   必要になった時点でシンボル表をロードしてキャッシュする（全ファイルの事前ロードはしない）
 * - キューまたは実行中タスクにあるファイル（DBが古い可能性がある）は現物から抽出し、
 *   それ以外はDBから読み込む
 * - enqueue時に該当ファイルを無効化し、キューが空になったら全体をクリアする
 */
export class SymbolCache {
    private readonly _cache = new Map<string, Promise<SYMBOL.SymbolModel[]>>();
    private readonly _load_db: SymbolLoader;
    private readonly _extract_fresh: SymbolLoader;
    private readonly _is_dirty: (relativePath: string) => boolean;

    public constructor(loadDb: SymbolLoader, extractFresh: SymbolLoader, isDirty: (relativePath: string) => boolean) {
        this._load_db = loadDb;
        this._extract_fresh = extractFresh;
        this._is_dirty = isDirty;
    }

    /** @description シンボル表を取得する（未キャッシュならロード元を選択して読み込む） */
    public get(relativePath: string): Promise<SYMBOL.SymbolModel[]> {
        let found = this._cache.get(relativePath);
        if (!found) {
            found = (this._is_dirty(relativePath) ? this._extract_fresh(relativePath) : this._load_db(relativePath))
                .catch(() => []);
            this._cache.set(relativePath, found);
        }
        return found;
    }

    /** @description 抽出済みのシンボル表を登録する（自ファイルの新鮮な抽出結果を共有する） */
    public set(relativePath: string, symbols: SYMBOL.SymbolModel[]): void {
        this._cache.set(relativePath, Promise.resolve(symbols));
    }

    /** @description 該当ファイルのキャッシュを無効化する */
    public invalidate(relativePath: string): void {
        this._cache.delete(relativePath);
    }

    /** @description キャッシュ全体をクリアする */
    public clear(): void {
        this._cache.clear();
    }
}
