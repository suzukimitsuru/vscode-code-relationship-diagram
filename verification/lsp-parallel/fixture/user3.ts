import { gamma } from './defs';
import { combine2 } from './user2';

export function combine3(x: number): number {
    return gamma(x) * combine2(x);
}

export class Runner3 {
    public run(value: number): number {
        return gamma(value) - combine3(value);
    }
}
