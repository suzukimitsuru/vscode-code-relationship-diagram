import { alpha, beta, gamma } from './defs';

export function combine1(x: number): number {
    return alpha(x) + beta(x) + gamma(x);
}

export class Runner1 {
    public run(value: number): number {
        return alpha(value) * beta(value);
    }
    public extra(value: number): number {
        return gamma(value) + combine1(value);
    }
}
