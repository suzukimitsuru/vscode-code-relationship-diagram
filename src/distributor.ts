/**
 * 新旧から変更を分配する
 * @param olds      旧配列
 * @param news      新配列
 * @param oldKey    旧キー取得
 * @param newKey    新キー取得
 * @param exists    存在判定
 * @param changed   変更判定
 * @returns 追加配列, 変更配列, 変更なし配列, 削除キー配列
 */
export function distribute<OLD, NEW>(olds: OLD[], news: NEW[],
    oldKey: (oldItem: OLD) => string,
    newKey: (newItem: NEW) => string,
    exists: (oldItem: OLD, newItem: NEW) => boolean,
    changed: (oldItem: OLD, newItem: NEW) => boolean
): [add: NEW[], updates: NEW[], notchanges: NEW[], removes: string[]] {
    const additions: NEW[] = [];
    const updates: NEW[] = [];
    const notchanges: NEW[] = [];
    const removes: string[] = olds.map((oldItem) => oldKey(oldItem));
    for (const newItem of news) {

        // テーブルに登録済みなら
        const row_index = olds.findIndex((oldItem) => exists(oldItem, newItem));
        if (row_index >= 0) {

            // 削除しない
            const remove_index = removes.indexOf(newKey(newItem));
            if (remove_index >= 0) {
                removes.splice(remove_index, 1);
            }

            // 更新が在れば、変更する。無ければ、変更なし
            if (changed(olds[row_index], newItem)) {
                updates.push(newItem);
            } else {
                notchanges.push(newItem);
            }
        } else {
            // 追加する
            additions.push(newItem);
        }
    }
    return [additions, updates, notchanges, removes];
}
