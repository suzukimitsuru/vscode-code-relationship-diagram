/** @file Code Attractor Editor: Symbol */
import * as vscode from 'vscode';

/** @class Symbol model */
export class SymbolModel {
    public readonly id: string;
    public readonly parentId: string | null;
    public readonly name: string;
    public readonly kind: vscode.SymbolKind;
    public readonly path: string;
    public readonly define: vscode.Position;
    public readonly start: vscode.Position;
    public readonly end: vscode.Position;
    public readonly lineCount: number;
    public readonly hash: Buffer;
    public children: SymbolModel[] = [];

    /** 完全修飾名 (AST の定義と突き合わせて付ける解決キー。付かなければ null) */
    public fqn: string | null = null;

    /** export 名 (トップレベルで export されていなければ null) */
    public exportName: string | null = null;

    public constructor(
        id: string,
        name: string,
        kind: vscode.SymbolKind,
        path: string,
        define: vscode.Position,
        start: vscode.Position,
        end: vscode.Position,
        hash: Buffer,
        parentId: string | null = null
    ) {
        this.id = id;
        this.parentId = parentId;
        this.name = name;
        this.kind = kind;
        this.path = path;
        this.define = define;
        this.start = start;
        this.end = end;
        this.lineCount = end.line - start.line + 1;
        this.hash = hash;
    }
    public addChild(child: SymbolModel) {
        this.children.push(child);
    }

    /**
     * 位置情報が変更されたかを判断
     * @param other 比較対象のシンボル
     * @returns 位置情報が変更されている場合true
     */
    public isPositionChanged(other: SymbolModel): boolean {
        return this.define.line !== other.define.line ||
               this.define.character !== other.define.character ||
               this.start.line !== other.start.line ||
               this.start.character !== other.start.character ||
               this.end.line !== other.end.line ||
               this.end.character !== other.end.character;
    }

    /**
     * 解決キー (完全修飾名・export 名) が変更されたかを判断
     * @param other 比較対象のシンボル
     * @returns 解決キーが変更されている場合true
     * @description 本文が同じ (ID が同じ) でも、兄弟の追加で `~N` がずれたり
     *              `export { A }` の追加で export 名が変わったりする
     */
    public isKeyChanged(other: SymbolModel): boolean {
        return this.fqn !== other.fqn || this.exportName !== other.exportName;
    }
}
