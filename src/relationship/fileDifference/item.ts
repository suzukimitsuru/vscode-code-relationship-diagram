import * as codeFiles from '../../extruct/codeFiles';

/**
 * @description キュー項目の操作（望ましい最終状態）
 * - upsert: DBをこのファイルの現状に一致させる（追加・更新を統合）
 * - delete: DBからこのファイルを消す（冪等）
 * - facts:  内容の変わっていないファイルの AST の事実だけを抽出し直す（LSP を使わない。
 *           スキーマ移行直後の埋め戻しや、抽出規則の版数が上がった時に使う）
 */
export type Operation = 'upsert' | 'delete' | 'facts';

/** @description ファイル差分キュー項目（1ファイル1エントリ） */
export class Item {
    public readonly op: Operation;
    public readonly relative_path: string;
    /** upsert / facts の対象ファイル（delete では null） */
    public readonly file: codeFiles.File | null;
    /** fan-out 由来: 全シンボルの関係を再調査する */
    public reexamine: boolean;

    private constructor(op: Operation, relative_path: string, file: codeFiles.File | null, reexamine: boolean) {
        this.op = op;
        this.relative_path = relative_path;
        this.file = file;
        this.reexamine = reexamine;
    }

    /** @description upsert 項目を生成する */
    public static upsert(file: codeFiles.File, reexamine: boolean = false): Item {
        return new Item('upsert', file.relative_path, file, reexamine);
    }

    /** @description delete 項目を生成する */
    public static remove(relative_path: string): Item {
        return new Item('delete', relative_path, null, false);
    }

    /** @description facts 項目を生成する */
    public static facts(file: codeFiles.File): Item {
        return new Item('facts', file.relative_path, file, false);
    }
}

/** @description 全走査（ファイルテーブルと実ファイルの比較）の分配結果 */
export class Difference {
    public readonly lists: codeFiles.File[];
    public readonly additions: codeFiles.File[];
    public readonly updates: codeFiles.File[];
    public readonly notchanges: codeFiles.File[];
    public readonly removes: string[];
    /** 不変ファイルのうち、AST の事実が未抽出か古い版数のもの */
    public readonly factsStale: codeFiles.File[];
    public constructor(lists: codeFiles.File[], additions: codeFiles.File[], updates: codeFiles.File[], notchanges: codeFiles.File[], removes: string[],
        factsStale: codeFiles.File[] = []) {
        this.lists = lists;
        this.additions = additions;
        this.updates = updates;
        this.notchanges = notchanges;
        this.removes = removes;
        this.factsStale = factsStale;
    }

    /** @description キュー項目へ変換する（不変ファイルは含めない。事実の埋め戻しは factItems で別に扱う） */
    public toItems(): Item[] {
        return [
            ...this.additions.map(file => Item.upsert(file)),
            ...this.updates.map(file => Item.upsert(file)),
            ...this.removes.map(relative_path => Item.remove(relative_path)),
        ];
    }

    /** @description 事実の埋め戻しのキュー項目へ変換する */
    public factItems(): Item[] {
        return this.factsStale.map(file => Item.facts(file));
    }
}
