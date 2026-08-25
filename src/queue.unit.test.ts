import { describe, it, expect } from 'vitest';
import { Queue } from './queue';

describe('Queue', () => {
    it('初期状態は空である', () => {
        const q = new Queue<number>();
        expect(q.isEmpty).toBe(true);
        expect(q.size).toBe(0);
        expect(q.peek).toBeUndefined();
    });

    it('enqueue/dequeueがFIFO順で動作する', () => {
        const q = new Queue<string>();
        q.enqueue('a');
        q.enqueue('b');
        q.enqueue('c');
        expect(q.size).toBe(3);
        expect(q.dequeue()).toBe('a');
        expect(q.dequeue()).toBe('b');
        expect(q.size).toBe(1);
        expect(q.dequeue()).toBe('c');
        expect(q.isEmpty).toBe(true);
    });

    it('空のキューからdequeueするとundefinedを返す', () => {
        const q = new Queue<number>();
        expect(q.dequeue()).toBeUndefined();
    });

    it('peekは要素を取り除かずに先頭を返す', () => {
        const q = new Queue<number>();
        q.enqueue(1);
        q.enqueue(2);
        expect(q.peek).toBe(1);
        expect(q.size).toBe(2);
    });

    it('clearで全要素を削除する', () => {
        const q = new Queue<number>();
        q.enqueue(1);
        q.enqueue(2);
        q.clear();
        expect(q.isEmpty).toBe(true);
        expect(q.size).toBe(0);
        expect(q.dequeue()).toBeUndefined();
    });

    it('toArrayはキューの内容を順序通り配列で返し、キューを変更しない', () => {
        const q = new Queue<number>();
        q.enqueue(10);
        q.enqueue(20);
        expect(q.toArray()).toEqual([10, 20]);
        expect(q.size).toBe(2);
    });

    it('dequeueとenqueueを繰り返しても内部インデックスがずれても正しく動作する', () => {
        const q = new Queue<number>();
        q.enqueue(1);
        q.enqueue(2);
        q.dequeue();
        q.enqueue(3);
        expect(q.toArray()).toEqual([2, 3]);
        expect(q.dequeue()).toBe(2);
        expect(q.dequeue()).toBe(3);
        expect(q.isEmpty).toBe(true);
    });
});
