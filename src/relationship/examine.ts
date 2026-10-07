/** @file 関係調査タスク: 1ファイル単位の計算フェーズ（並列・中断可能）とコミットフェーズ（直列）を提供する */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as codeDb from '../codeDb';
import * as codeFiles from '../extruct/codeFiles';
import * as SYMBOL from '../extruct/symbol';
import * as codeSymbols from '../extruct/codeSymbols';
import { FACTS_VERSION, FactsExtractor, FileFacts, astLanguageOf } from '../extruct/ast';
import * as codeRelationships from './codeRelationships';
import { Difference } from './fileDifference/item';
import { SymbolCache } from './fileDifference/symbolCache';
import { distribute } from '../distributor';

/** @description タスク中断例外 */
export class Cancelled extends Error {
    public constructor(relativePath: string) {
        super(`Examine task cancelled: ${relativePath}`);
    }
}

/** @description タスク中断トークン（await境界ごとの協調チェック用） */
export class CancelToken {
    private _cancelled = false;
    public constructor(public readonly relative_path: string) {}
    public get isCancelled(): boolean {
        return this._cancelled;
    }
    public cancel(): void {
        this._cancelled = true;
    }
    /** @description 中断されていたら Cancelled を投げる */
    public check(): void {
        if (this._cancelled) { throw new Cancelled(this.relative_path); }
    }
}

/** @description upsert 計算フェーズの結果（コミットフェーズへの入力） */
export class UpsertPlan {
    public constructor(
        public readonly file: codeFiles.File,
        /** DBへ挿入するシンボル（追加＋変更） */
        public readonly symbol_inserts: SYMBOL.SymbolModel[],
        /** 内容は同じで、位置か解決キー（fqn / export 名）が変わったシンボル（table_symbols のみ更新） */
        public readonly symbol_in_place_updates: SYMBOL.SymbolModel[],
        /** DBから削除するシンボルID */
        public readonly symbol_removes: string[],
        /** 挿入する関係（既存の定義側関係＋調査結果） */
        public readonly relationships: codeRelationships.Relationship[],
        /** 変更シンボルを参照していたファイル（fan-out 再調査対象） */
        public readonly fanout_paths: string[],
        /** 行数（統計用） */
        public readonly lineCount: number,
        /** AST の事実（未対応言語・抽出失敗なら null。null でも古い事実は削除する） */
        public readonly facts: FileFacts | null = null,
    ) {}
}

/** @description facts 計算フェーズの結果（コミットフェーズへの入力） */
export class FactsPlan {
    public constructor(
        public readonly file: codeFiles.File,
        /** 解決キー（fqn / export 名）が変わったシンボル */
        public readonly symbol_key_updates: SYMBOL.SymbolModel[],
        /** AST の事実 */
        public readonly facts: FileFacts,
    ) {}
}

/**
 * @description ファイルテーブルと実ファイルの差分を全走査で求める
 * @param wsFolder      ワークスペースフォルダ
 * @param associations  ファイル関連定義
 * @param db            データベース
 * @param log           ログ関数
 * @param progress      進捗コールバック（列挙1ファイルごと）
 * @returns 分配結果
 */
export async function scanDifference(wsFolder: string, associations: object, db: codeDb.Db,
    log: (message: string) => void, progress: () => void): Promise<Difference>
{
    // ファイルを列挙する
    const lists: codeFiles.File[] = [];
    const ignores = codeFiles.loadGitignorePatterns(wsFolder);
    codeFiles.list(wsFolder, associations, ignores, (file: codeFiles.File) => {
        lists.push(file);
        log(`Listed file: ${file.relative_path}`);
        progress();
    });
    log(`Listed file: ${lists.length} files`);

    // ファイルテーブルの全件を読み込む
    const file_loads = await db.codeFile_queryAll();

    // ファイルの変更を分配する
    const file_sorted = lists.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
    const [additions, updates, notchanges, removes] = distribute<codeFiles.File, codeFiles.File>(file_loads, file_sorted,
        (oldItem) => oldItem?.relative_path ?? '',
        (newItem) => newItem.relative_path,
        (oldItem, newItem) => newItem.relative_path === oldItem.relative_path,
        (oldItem, newItem) => newItem.updated.getTime() !== oldItem.updated.getTime()
    );

    // 内容は変わっていないが、AST の事実が未抽出（スキーマ移行直後）か古い版数のファイル
    const facts_versions = await db.codeFile_queryFactsVersions();
    const facts_stale = notchanges.filter(file =>
        (astLanguageOf(file.language_id) !== null) && (facts_versions.get(file.relative_path) !== FACTS_VERSION));
    return new Difference(lists, additions, updates, notchanges, removes, facts_stale);
}

/** @description 1ファイルの関係調査タスク */
export class ExamineTask {
    private readonly _ws_folder: string;
    private readonly _db: codeDb.Db;
    private readonly _symbols: SymbolCache;
    private readonly _log: (message: string) => void;
    private readonly _facts: FactsExtractor | null;

    public constructor(wsFolder: string, db: codeDb.Db, symbols: SymbolCache, log: (message: string) => void,
        facts: FactsExtractor | null = null) {
        this._ws_folder = wsFolder;
        this._db = db;
        this._symbols = symbols;
        this._log = log;
        this._facts = facts;
    }

    /** @description AST の事実を抽出できるか（パーサが使えない環境では LSP の経路だけで動く） */
    public get hasFacts(): boolean {
        return this._facts !== null;
    }

    /**
     * @description AST の事実を抽出し、シンボルへ解決キーを付ける
     * 失敗しても LSP の経路は続行できるよう、例外は投げずに null を返す
     * @param file      対象ファイル
     * @param source    ソースコード（シンボル抽出と同じ内容）
     * @param symbols   解決キーを付けるシンボル
     * @returns 事実。未対応言語・抽出失敗なら null（シンボルの解決キーは null になる）
     */
    private async _extractFacts(file: codeFiles.File, source: string, symbols: SYMBOL.SymbolModel[]): Promise<FileFacts | null> {
        let facts: FileFacts | null = null;
        if (this._facts && this._facts.isSupported(file.language_id)) {
            try {
                facts = await this._facts.extract(file.relative_path, file.language_id, source);
            } catch (error) {
                this._log(`Failed to extract facts: ${file.relative_path} ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        const attached = codeSymbols.attachAstKeys(file.relative_path, symbols, facts?.definitions ?? []);
        if (facts) {
            this._log(`Extracted facts: ${file.relative_path} ${facts.elapsedMs.toFixed(1)}ms ` +
                `(definitions ${facts.definitions.length}, attached ${attached}/${Math.max(symbols.length - 1, 0)} symbols, ` +
                `imports ${facts.imports.length}, occurrences ${facts.occurrences.length}${facts.hasError ? ', has syntax error' : ''})`);
        }
        return facts;
    }

    /**
     * @description コードからシンボルを抽出する
     * 言語サーバーの起動直後は DocumentSymbolProvider が空を返す事があるため、
     * ルートシンボルのみ（実質空）の場合はリトライする（コールドスタート対策）
     */
    public async extructSymbols(relativePath: string, retries: number = 5): Promise<{ doc: vscode.TextDocument, symbols: SYMBOL.SymbolModel[] }> {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this._ws_folder, relativePath)));
        let symbols: SYMBOL.SymbolModel[] = [];
        for (let attempt = 0; attempt < retries; attempt++) {
            symbols = await codeSymbols.extract(relativePath, doc).catch(() => [] as SYMBOL.SymbolModel[]);
            // ルートシンボルのみ（実質空）で、かつファイルに内容が在るなら、言語サーバー起動待ちの可能性が高い
            if ((symbols.length > 1) || (doc.lineCount <= 1) || (attempt === retries - 1)) { break; }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        return { doc, symbols };
    }

    /**
     * @description upsert の計算フェーズ（並列実行・中断可能、DBへは書き込まない）
     * @param file      対象ファイル
     * @param reexamine fan-out 由来: 全シンボルの関係を再調査する
     * @param token     中断トークン
     * @returns コミットフェーズへの入力
     */
    public async computeUpsert(file: codeFiles.File, reexamine: boolean, token: CancelToken): Promise<UpsertPlan> {
        const relative_path = file.relative_path;

        // シンボルのテーブルからの読み込みと、コードからシンボルの抽出を行う
        token.check();
        const olds = await this._db.symbol_query(relative_path).catch(() => [] as SYMBOL.SymbolModel[]);
        token.check();
        const { doc, symbols: news } = await this.extructSymbols(relative_path);
        token.check();

        // AST の事実を抽出し、シンボルへ解決キー（fqn / export 名）を付ける（ID・ハッシュは変わらない）
        const facts = await this._extractFacts(file, doc.getText(), news);
        token.check();

        // 自ファイルの新鮮なシンボル表を他タスクへ共有する
        this._symbols.set(relative_path, news);

        // シンボルの変更を分配する（DBに行が無ければ全て追加＝新規ファイル相当）
        const [symbol_additions, symbol_updates, symbol_notchanges, symbol_removes] =
            distribute<SYMBOL.SymbolModel, SYMBOL.SymbolModel>(olds, news,
            (oldItem) => oldItem.id,
            (newItem) => newItem.id,
            (oldItem, newItem) => newItem.id === oldItem.id,
            (oldItem, newItem) => !newItem.hash.equals(oldItem.hash)
        );

        // 変更のないシンボルは、位置か解決キーが変わっている場合のみ table_symbols を更新する
        // （兄弟の追加で ~N がずれる、export 句の追加で export 名が変わる等は本文を変えない）
        const in_place_updates = symbol_notchanges.filter(newSymbol => {
            const oldSymbol = olds.find(old => old.id === newSymbol.id);
            return oldSymbol !== undefined && (newSymbol.isPositionChanged(oldSymbol) || newSymbol.isKeyChanged(oldSymbol));
        });

        // 関係を調査する定義側シンボル（fan-out 再調査なら全シンボル）
        const define_symbols = reexamine ? news : [...symbol_additions, ...symbol_updates];

        // 既存の定義側関係を読み込む（削除シンボルに掛かる関係は除く）
        token.check();
        const removed_ids = new Set(symbol_removes);
        const define_rels = (await this._db.relationship_queryDefinePath(relative_path))
            .filter(rel => !removed_ids.has(rel.define.id) && !removed_ids.has(rel.reference.id));

        // LSPで参照を検索し、参照位置のシンボル表を遅延ロードして突合する
        token.check();
        const uri = vscode.Uri.file(path.join(this._ws_folder, relative_path));
        const reference_rels = await codeRelationships.examine(this._ws_folder, uri, define_symbols,
            (refPath) => this._symbols.get(refPath), 3, () => token.check());
        this._log(`Examined relationship: ${relative_path} ${reference_rels.length} references`);

        // 関係を一意化する（reference.id と define.id の組をキーにする）
        // JSON.stringify は要素の区切りが曖昧にならないため、id にどんな文字が含まれても衝突しない
        const relationships = new Map<string, codeRelationships.Relationship>();
        for (const rel of [...define_rels, ...reference_rels]) {
            relationships.set(JSON.stringify([rel.reference.id, rel.define.id]), rel);
        }

        // 変更・削除されたシンボルを参照していたファイルは、fan-out 再調査の対象にする
        // （シンボルIDには内容ハッシュが含まれるため、本文が変わったシンボルは
        //   symbol_updates ではなく symbol_removes 側に現れる。コミットで関係が削除される前に読む）
        token.check();
        const fanout_paths: string[] = [];
        const fanout_source_ids = [...symbol_updates.map(symbol => symbol.id), ...symbol_removes];
        if (fanout_source_ids.length > 0) {
            const refs = await this._db.relationship_queryReferencesTo(fanout_source_ids);
            for (const ref of refs) {
                if ((ref.reference.path !== relative_path) && !fanout_paths.includes(ref.reference.path)) {
                    fanout_paths.push(ref.reference.path);
                }
            }
        }
        token.check();

        // 行数を集計する（統計用）
        const sum_line = news.reduce((sum, symbol) => sum + symbol.lineCount, 0);
        const file_line = news.reduce((sum, symbol) => sum + ((symbol.kind === vscode.SymbolKind.File) ? symbol.lineCount : 0), 0);
        const line_count = file_line > 0 ? file_line : sum_line;

        this._log(`symbols ${relative_path}: (added ${symbol_additions.length}, updated ${symbol_updates.length}, ` +
            `no changed ${symbol_notchanges.length}, removed ${symbol_removes.length}, updated in place ${in_place_updates.length})`);

        return new UpsertPlan(file, [...symbol_additions, ...symbol_updates], in_place_updates, symbol_removes,
            [...relationships.values()], fanout_paths, line_count, facts);
    }

    /**
     * @description upsert のコミットフェーズ（直列実行・中断不可・短時間）
     * 削除 → 関係 → シンボル → codeFile の順に書き込む（codeFile が最後＝完了の印）
     */
    public async commitUpsert(plan: UpsertPlan): Promise<void> {
        const relative_path = plan.file.relative_path;

        // 削除シンボルと、それに掛かる関係を削除する
        if (plan.symbol_removes.length > 0) {
            await this._db.symbol_delete(plan.symbol_removes);
            await this._db.relationship_deleteSymbols(plan.symbol_removes);
        }

        // 位置か解決キーだけが変わったシンボルを更新する
        for (const symbol of plan.symbol_in_place_updates) {
            await this._db.symbol_update(symbol);
        }

        // 追加する関係を予め削除してから追加する（存在しない場合もある）
        await this._db.relationship_delete(plan.relationships).catch(() => {});
        if (plan.relationships.length > 0) {
            await this._db.relationship_inserts(plan.relationships);
        }

        // シンボルをDBに保存する
        if (plan.symbol_inserts.length > 0) {
            await this._db.symbol_inserts(plan.symbol_inserts);
        }
        this._log(`Saved symbol: ${relative_path}`);

        // AST の事実を置き換える（抽出できなかった場合も、内容が変わったので古い事実は消す）
        await this._db.facts_replace(relative_path, plan.facts);

        // ファイルを更新または挿入する（タスク完全成功の印として最後に書く）
        await this._db.codeFile_upsert(plan.file, plan.facts ? FACTS_VERSION : null);
        this._log(`Upserted file: ${relative_path}`);
    }

    /**
     * @description facts の計算フェーズ（並列実行・中断可能、DBへは書き込まない）
     * 内容の変わっていないファイルの AST の事実だけを抽出し直す。LSP は使わず、シンボルはDBから読む
     * @param file      対象ファイル
     * @param token     中断トークン
     * @returns コミットフェーズへの入力。抽出できなければ null（版数が更新されないため次の全走査で再試行される）
     */
    public async computeFacts(file: codeFiles.File, token: CancelToken): Promise<FactsPlan | null> {
        token.check();
        const symbols = await this._db.symbol_query(file.relative_path).catch(() => [] as SYMBOL.SymbolModel[]);
        const previous = symbols.map(symbol => JSON.stringify([symbol.fqn, symbol.exportName]));
        token.check();

        // VSCode の TextDocument と同じく BOM は内容に含めない（1行目の桁がずれるため）
        const source = (await fs.promises.readFile(path.join(this._ws_folder, file.relative_path), 'utf8')).replace(/^\uFEFF/, '');
        token.check();
        const facts = await this._extractFacts(file, source, symbols);
        token.check();
        if (!facts) {
            return null;
        }
        const key_updates = symbols.filter((symbol, index) => JSON.stringify([symbol.fqn, symbol.exportName]) !== previous[index]);
        return new FactsPlan(file, key_updates, facts);
    }

    /**
     * @description facts のコミットフェーズ（直列実行・中断不可・短時間）
     * 解決キー → 事実と版数 の順に書き込む（版数が最後＝完了の印）
     */
    public async commitFacts(plan: FactsPlan): Promise<void> {
        for (const symbol of plan.symbol_key_updates) {
            await this._db.symbol_update(symbol);
        }
        await this._db.facts_replace(plan.file.relative_path, plan.facts, FACTS_VERSION);
        this._log(`Saved facts: ${plan.file.relative_path}`);
    }

    /**
     * @description delete のコミットフェーズ（直列実行）
     * 関係 → 事実 → シンボル → codeFile の順に削除する（関係の削除がシンボル表を参照するため）
     */
    public async commitDelete(relativePath: string): Promise<void> {
        await this._db.relationship_deleteFile(relativePath);
        await this._db.facts_deleteFile(relativePath);
        await this._db.symbol_deleteFile(relativePath);
        await this._db.codeFile_delete(relativePath);
        this._symbols.invalidate(relativePath);
        this._log(`Removed file: ${relativePath}`);
    }
}
