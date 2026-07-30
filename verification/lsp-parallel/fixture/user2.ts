import { alpha, beta } from './defs';
import { combine1 } from './user1';

export function combine2(x: number): number {
    return alpha(x) - beta(x) + combine1(x);
}

export class Runner2 {
    public run(value: number): number {
        return beta(value) + combine2(value);
    }
}
