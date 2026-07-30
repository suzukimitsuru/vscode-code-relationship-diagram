/** @file ファイル差分キュープロセッサ: ファイル単位の関係調査タスクを並列実行する */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as codeDb from '../../codeDb';
import * as codeRelationships from '../codeRelationships';
import { Item, Difference } from './item';
import { SymbolCache } from './symbolCache';
import { ExamineTask, CancelToken, Cancelled } from '../examine';

/** @description 進捗通知イベント */
export interface Progress {
    processed: number;
    total: number;
    message?: string;
}

/** @description 全件完了通知イベント（キューが空になった時） */
export interface Completed {
    processed: number;
    elapsedMs: number;
    lineCount: number;
    relationshipCount: number;
}

/** @description プロセッサ生成オプション */
export interface QueueProcessorOptions {
    workspaceFolder: string;
    db: codeDb.Db;
    /** タスク同時実行数の上限（既定: 4） */
    concurrency?: number;
    log: (message: string, ...args: any[]) => void;
    error: (message: string, error: unknown) => void;
    progress: (processed: number, total: number, message?: string) => void;
}

/**
 * @description ファイル差分キュープロセッサ
 * - キューは1ファイル1エントリ（last-write-wins）。enqueue で実行中タスクは中断される
 * - 計算フェーズは並列（上限あり）、コミットフェーズは直列
 * - 変更シンボルの参照元ファイルは fan-out として再調査する
 */
export class QueueProcessor {
    private readonly _options: QueueProcessorOptions;
    private readonly _concurrency: number;
    private readonly _queue = new Map<string, Item>();
    private readonly _running = new Map<string, CancelToken>();
    private readonly _active = new Set<Promise<void>>();
    private readonly _symbols: SymbolCache;
    private readonly _task: ExamineTask;
    private _commit_chain: Promise<void> = Promise.resolve();
    private _indexing: Promise<void> | null = null;
    private _disposed = false;

    // 進捗集計（キューが空→非空になる度にリセット）
    private _busy_start = 0;
    private _processed = 0;
    private _total = 0;
    private _line_count = 0;
    private _relationship_count = 0;

    private readonly _onProgress = new vscode.EventEmitter<Progress>();
    private readonly _onCompleted = new vscode.EventEmitter<Completed>();
    private readonly _onError = new vscode.EventEmitter<unknown>();

    public readonly onProgress: vscode.Event<Progress> = this._onProgress.event;
    public readonly onCompleted: vscode.Event<Completed> = this._onCompleted.event;
    public readonly onError: vscode.Event<unknown> = this._onError.event;

    public constructor(options: QueueProcessorOptions) {
        this._options = options;
        this._concurrency = options.concurrency ?? 4;
        this._symbols = new SymbolCache(
            (relativePath) => this._options.db.symbol_query(relativePath),
            (relativePath) => this._task.extructSymbols(relativePath).then(result => result.symbols),
            (relativePath) => this._queue.has(relativePath) || this._running.has(relativePath),
        );
        this._task = new ExamineTask(options.workspaceFolder, options.db, this._symbols,
            (message) => this._options.log(message));
    }

    /**
     * @description ファイル差分をキューに追加する（last-write-wins）
     * 同一ファイルの実行中タスクは中断し、キュー処理が停止中なら自動的に開始する
     */
    public enqueue(item: Item): void {
        if (this._disposed) { return; }

        // 実行中タスクを中断する（計算結果は破棄され、この新しい項目で再実行される）
        this._running.get(item.relative_path)?.cancel();

        // upsert 同士の上書きは fan-out 再調査フラグを引き継ぐ
        const existing = this._queue.get(item.relative_path);
        if (existing && existing.op === 'upsert' && item.op === 'upsert') {
            item.reexamine = item.reexamine || existing.reexamine;
        }

        this._registerItem(item);
    }

    /** @description 全走査の分配結果をキューに追加する（不変ファイルは含めない） */
    public enqueueDifference(difference: Difference): void {
        for (const item of difference.toItems()) {
            this.enqueue(item);
        }
    }

    public get isProcessing(): boolean {
        return (this._queue.size > 0) || (this._running.size > 0);
    }

    public get queueSize(): number {
        return this._queue.size;
    }

    /** @description 実行中タスクを全て中断し、完了を待ってからキューとイベントを破棄する */
    public async dispose(): Promise<void> {
        this._disposed = true;
        this._queue.clear();
        for (const token of this._running.values()) { token.cancel(); }
        await Promise.allSettled([...this._active]);
        await this._commit_chain.catch(() => {});
        this._onProgress.dispose();
        this._onCompleted.dispose();
        this._onError.dispose();
    }

    /** @description キュー項目を登録し、進捗集計を更新してスケジューラを起動する */
    private _registerItem(item: Item): void {
        // キューが空→非空になる時、進捗集計をリセットする
        if (!this.isProcessing) {
            this._busy_start = performance.now();
            this._processed = 0;
            this._total = 0;
            this._line_count = 0;
            this._relationship_count = 0;
        }
        if (!this._queue.has(item.relative_path)) {
            this._total++;
        }
        this._queue.set(item.relative_path, item);
        this._symbols.invalidate(item.relative_path);
        this._report();
        this._pump();
    }

    /**
     * @description fan-out: 変更シンボルの参照元ファイルを再調査対象として登録する
     * 通常の enqueue より弱い合流規則（delete 登録済みなら破棄、実行中タスクは中断しない）
     */
    private async _enqueueFanout(relativePath: string): Promise<void> {
        if (this._disposed) { return; }

        // キューに登録済みなら、upsert は再調査フラグを立てるだけ、delete は破棄する
        const existing = this._queue.get(relativePath);
        if (existing) {
            if (existing.op === 'upsert') { existing.reexamine = true; }
            return;
        }

        // 実ファイルが無ければ破棄する（delete イベント側で処理される）
        if (!fs.existsSync(path.join(this._options.workspaceFolder, relativePath))) { return; }

        // ファイルテーブルの行から upsert 項目を作る（未登録なら次の全走査に任せる）
        const rows = await this._options.db.codeFile_query(relativePath).catch(() => []);
        if ((rows.length > 0) && !this._disposed) {
            // 実行中タスクは中断せず、完了後に再調査する
            this._registerItem(Item.upsert(rows[0], true));
        }
    }

    /** @description 実行中でないファイルのキュー項目を、同時実行数の上限までタスクとして起動する */
    private _pump(): void {
        if (this._disposed) { return; }
        while (this._running.size < this._concurrency) {

            // 実行中でないファイルの項目を取り出す
            let picked: Item | null = null;
            for (const item of this._queue.values()) {
                if (!this._running.has(item.relative_path)) { picked = item; break; }
            }
            if (!picked) { break; }
            this._queue.delete(picked.relative_path);

            // タスクを起動する
            const token = new CancelToken(picked.relative_path);
            this._running.set(picked.relative_path, token);
            const run = this._runTask(picked, token).finally(() => {
                this._running.delete(token.relative_path);
                this._active.delete(run);
                this._pump();
                this._checkDrained();
            });
            this._active.add(run);
        }
    }

    /** @description 1件のキュー項目を処理する（計算フェーズ → 直列コミット → fan-out） */
    private async _runTask(item: Item, token: CancelToken): Promise<void> {
        try {
            // インデックス作成待ち（アイドル→稼働の遷移ごとに1回）
            await this._indexingReady();
            token.check();

            if (item.op === 'delete') {
                await this._commit(() => this._task.commitDelete(item.relative_path));
            } else {
                // 計算フェーズ（並列・中断可能）
                const plan = await this._task.computeUpsert(item.file!, item.reexamine, token);
                token.check();

                // コミットフェーズ（直列・中断不可）
                await this._commit(() => this._task.commitUpsert(plan));
                this._line_count += plan.lineCount;
                this._relationship_count += plan.relationships.length;

                // fan-out: 変更シンボルの参照元ファイルを再調査する
                for (const fanout_path of plan.fanout_paths) {
                    void this._enqueueFanout(fanout_path).catch(error =>
                        this._options.error(`FileDifference.QueueProcessor fan-out(${fanout_path}): `, error));
                }
            }
            this._processed++;
            this._report();
        } catch (error) {
            if (error instanceof Cancelled) {
                // 中断＝計算結果の破棄。新しいキュー項目が再実行する
                this._options.log(`Examine task cancelled: ${item.relative_path}`);
            } else {
                this._processed++;
                this._options.error(`FileDifference.QueueProcessor(${item.relative_path}): `, error);
                this._onError.fire(error);
            }
        }
    }

    /** @description コミットを直列化する */
    private _commit<T>(fn: () => Promise<T>): Promise<T> {
        const run = this._commit_chain.then(fn);
        this._commit_chain = run.then(() => {}, () => {});
        return run;
    }

    /** @description インデックス作成完了を待つ（アイドル→稼働の遷移ごとに1回） */
    private _indexingReady(): Promise<void> {
        if (!this._indexing) {
            this._report(undefined, 'Waiting for indexing to complete...');
            this._indexing = codeRelationships.indexingCompleteWait(10).then(attempt => {
                this._options.log(`Waited for indexing to complete... attempt ${attempt}`);
            });
        }
        return this._indexing;
    }

    /** @description 進捗を通知する */
    private _report(processed?: number, message?: string): void {
        const done = processed ?? this._processed;
        this._options.progress(done, this._total, message);
        this._onProgress.fire({ processed: done, total: this._total, message });
    }

    /** @description キューが空になったら完了を通知し、キャッシュをクリアする */
    private _checkDrained(): void {
        if (this._disposed || this.isProcessing) { return; }
        this._symbols.clear();
        this._indexing = null;
        const elapsed = performance.now() - this._busy_start;
        this._options.log(`${this._secondsToTime(elapsed)} ` +
            `processed ${this._processed.toLocaleString()}/${this._total.toLocaleString()} files, ` +
            `${this._line_count.toLocaleString()} lines, ` +
            `${this._relationship_count.toLocaleString()} relationships`);
        this._onCompleted.fire({
            processed: this._processed,
            elapsedMs: elapsed,
            lineCount: this._line_count,
            relationshipCount: this._relationship_count,
        });
    }

    /** @description ミリ秒を時間表示文字列に変換する */
    private _secondsToTime(milliSeconds: number): string {
        const hours = Math.floor(milliSeconds / 3600000);
        const minutes = Math.floor((milliSeconds % 3600000) / 60000);
        const secs = Math.floor((milliSeconds % 60000) / 1000);
        let time = milliSeconds >= 3600000 ? String(hours).padStart(2, '0') + ':' : '';
        time += milliSeconds >= 60000 ? String(minutes).padStart(2, '0') + ':' : '';
        time += milliSeconds >= 10000 ? String(secs).padStart(2, '0') : milliSeconds >= 1000 ? String(secs) : '0';
        return time;
    }
}
