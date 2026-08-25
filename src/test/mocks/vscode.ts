/**
 * Vitest単体テスト用の最小`vscode`モジュールスタブ。
 * 実VSCode拡張ホスト無しに、pure/near-pureロジックがコンパイル・実行できる
 * 最低限の型・列挙値のみを提供する（統合テスト`src/test/*.test.ts`は対象外、
 * 引き続き@vscode/test-electron経由で実vscodeに対して実行される）。
 */

/** 本家vscode.SymbolKindと同じ並び・値 */
export enum SymbolKind {
    File = 0,
    Module = 1,
    Namespace = 2,
    Package = 3,
    Class = 4,
    Method = 5,
    Property = 6,
    Field = 7,
    Constructor = 8,
    Enum = 9,
    Interface = 10,
    Function = 11,
    Variable = 12,
    Constant = 13,
    String = 14,
    Number = 15,
    Boolean = 16,
    Array = 17,
    Object = 18,
    Key = 19,
    Null = 20,
    EnumMember = 21,
    Struct = 22,
    Event = 23,
    Operator = 24,
    TypeParameter = 25,
}

export class Position {
    constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
    constructor(public readonly start: Position, public readonly end: Position) {}

    contains(position: Position): boolean {
        if (position.line < this.start.line || position.line > this.end.line) {
            return false;
        }
        if (position.line === this.start.line && position.character < this.start.character) {
            return false;
        }
        if (position.line === this.end.line && position.character > this.end.character) {
            return false;
        }
        return true;
    }
}

export class Uri {
    private constructor(public readonly fsPath: string) {}
    static file(path: string): Uri {
        return new Uri(path);
    }
}

export class Location {
    constructor(public readonly uri: Uri, public readonly range: Range) {}
}

export class Disposable {
    constructor(private readonly callOnDispose?: () => void) {}
    dispose(): void {
        this.callOnDispose?.();
    }
}

export const commands = {
    executeCommand: async () => undefined,
};

export const window = {};
export const workspace = {};
export const env = { language: 'en' };
