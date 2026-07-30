import * as codeFiles from '../../extruct/codeFiles';

/**
 * @description キュー項目の操作（望ましい最終状態）
 * - upsert: DBをこのファイルの現状に一致させる（追加・更新を統合）
 * - delete: DBからこのファイルを消す（冪等）
 */
export type Operation = 'upsert' | 'delete';

/** @description ファイル差分キュー項目（1ファイル1エントリ） */
export class Item {
    public readonly op: Operation;
    public readonly relative_path: string;
    /** upsert の対象ファイル（delete では null） */
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
}

/** @description 全走査（ファイルテーブルと実ファイルの比較）の分配結果 */
export class Difference {
    public readonly lists: codeFiles.File[];
    public readonly additions: codeFiles.File[];
    public readonly updates: codeFiles.File[];
    public readonly notchanges: codeFiles.File[];
    public readonly removes: string[];
    public constructor(lists: codeFiles.File[], additions: codeFiles.File[], updates: codeFiles.File[], notchanges: codeFiles.File[], removes: string[]) {
        this.lists = lists;
        this.additions = additions;
        this.updates = updates;
        this.notchanges = notchanges;
        this.removes = removes;
    }

    /** @description キュー項目へ変換する（不変ファイルは含めない） */
    public toItems(): Item[] {
        return [
            ...this.additions.map(file => Item.upsert(file)),
            ...this.updates.map(file => Item.upsert(file)),
            ...this.removes.map(relative_path => Item.remove(relative_path)),
        ];
    }
}
