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
}
