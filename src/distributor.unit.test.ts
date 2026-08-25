import { describe, it, expect } from 'vitest';
import { distribute } from './distributor';

interface Item {
    key: string;
    value: number;
}

describe('distribute', () => {
    it('新規項目をadditionsに分類する', () => {
        const olds: Item[] = [];
        const news: Item[] = [{ key: 'a', value: 1 }];
        const [additions, updates, notchanges, removes] = distribute(
            olds, news,
            (o) => o.key, (n) => n.key,
            (o, n) => o.key === n.key,
            (o, n) => o.value !== n.value,
        );
        expect(additions).toEqual([{ key: 'a', value: 1 }]);
        expect(updates).toEqual([]);
        expect(notchanges).toEqual([]);
        expect(removes).toEqual([]);
    });

    it('値が変化した既存項目をupdatesに分類する', () => {
        const olds: Item[] = [{ key: 'a', value: 1 }];
        const news: Item[] = [{ key: 'a', value: 2 }];
        const [additions, updates, notchanges, removes] = distribute(
            olds, news,
            (o) => o.key, (n) => n.key,
            (o, n) => o.key === n.key,
            (o, n) => o.value !== n.value,
        );
        expect(additions).toEqual([]);
        expect(updates).toEqual([{ key: 'a', value: 2 }]);
        expect(notchanges).toEqual([]);
        expect(removes).toEqual([]);
    });

    it('値が変化していない既存項目をnotchangesに分類する', () => {
        const olds: Item[] = [{ key: 'a', value: 1 }];
        const news: Item[] = [{ key: 'a', value: 1 }];
        const [additions, updates, notchanges, removes] = distribute(
            olds, news,
            (o) => o.key, (n) => n.key,
            (o, n) => o.key === n.key,
            (o, n) => o.value !== n.value,
        );
        expect(additions).toEqual([]);
        expect(updates).toEqual([]);
        expect(notchanges).toEqual([{ key: 'a', value: 1 }]);
        expect(removes).toEqual([]);
    });

    it('新側に存在しない旧項目をremovesに分類する', () => {
        const olds: Item[] = [{ key: 'a', value: 1 }, { key: 'b', value: 2 }];
        const news: Item[] = [{ key: 'a', value: 1 }];
        const [additions, updates, notchanges, removes] = distribute(
            olds, news,
            (o) => o.key, (n) => n.key,
            (o, n) => o.key === n.key,
            (o, n) => o.value !== n.value,
        );
        expect(additions).toEqual([]);
        expect(updates).toEqual([]);
        expect(notchanges).toEqual([{ key: 'a', value: 1 }]);
        expect(removes).toEqual(['b']);
    });

    it('追加・更新・変更なし・削除が混在するケースを正しく分類する', () => {
        const olds: Item[] = [
            { key: 'a', value: 1 },
            { key: 'b', value: 2 },
            { key: 'c', value: 3 },
        ];
        const news: Item[] = [
            { key: 'a', value: 1 },  // 変更なし
            { key: 'b', value: 99 }, // 更新
            { key: 'd', value: 4 },  // 追加
        ];
        const [additions, updates, notchanges, removes] = distribute(
            olds, news,
            (o) => o.key, (n) => n.key,
            (o, n) => o.key === n.key,
            (o, n) => o.value !== n.value,
        );
        expect(additions).toEqual([{ key: 'd', value: 4 }]);
        expect(updates).toEqual([{ key: 'b', value: 99 }]);
        expect(notchanges).toEqual([{ key: 'a', value: 1 }]);
        expect(removes).toEqual(['c']);
    });

    it('空配列同士では全て空を返す', () => {
        const [additions, updates, notchanges, removes] = distribute<Item, Item>(
            [], [],
            (o) => o.key, (n) => n.key,
            (o, n) => o.key === n.key,
            (o, n) => o.value !== n.value,
        );
        expect(additions).toEqual([]);
        expect(updates).toEqual([]);
        expect(notchanges).toEqual([]);
        expect(removes).toEqual([]);
    });
});
