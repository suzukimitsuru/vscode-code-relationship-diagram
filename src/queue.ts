/**
 * Map-based Queue implementation
 * Uses a Map with numeric indices to implement FIFO queue operations
 */
export class Queue<T> {
    private map: Map<number, T>;
    private head: number;
    private tail: number;

    constructor() {
        this.map = new Map<number, T>();
        this.head = 0;
        this.tail = 0;
    }

    /**
     * Add an item to the end of the queue
     */
    enqueue(item: T): void {
        this.map.set(this.tail, item);
        this.tail++;
    }

    /**
     * Remove and return the item at the front of the queue
     * Returns undefined if the queue is empty
     */
    dequeue(): T | undefined {
        if (this.isEmpty) {
            return undefined;
        }
        const item = this.map.get(this.head);
        this.map.delete(this.head);
        this.head++;
        return item;
    }

    /**
     * Return the item at the front of the queue without removing it
     * Returns undefined if the queue is empty
     */
    get peek(): T | undefined {
        return this.map.get(this.head);
    }

    /**
     * Get the number of items in the queue
     */
    get size(): number {
        return this.tail - this.head;
    }

    /**
     * Check if the queue is empty
     */
    get isEmpty(): boolean {
        return this.size === 0;
    }

    /**
     * Remove all items from the queue
     */
    clear(): void {
        this.map.clear();
        this.head = 0;
        this.tail = 0;
    }

    /**
     * Convert the queue to an array (without modifying the queue)
     */
    toArray(): T[] {
        const result: T[] = [];
        for (let i = this.head; i < this.tail; i++) {
            const item = this.map.get(i);
            if (item !== undefined) {
                result.push(item);
            }
        }
        return result;
    }
}
