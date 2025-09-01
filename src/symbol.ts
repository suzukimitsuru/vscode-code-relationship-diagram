/** @file Code Attractor Editor: Symbol */
import * as vscode from 'vscode';

class Vector {
    public constructor(public x: number, public y: number) {}
}
export class Position extends Vector {
    public constructor(x: number, y: number) { super(x, y); }
    public set(x: number, y: number) {
        this.x = x;
        this.y = y;
    }
}
/** @class Symbol model */
export class SymbolModel {
    public readonly id: string;
    public readonly parentId: string | null;
    public readonly name: string;
    public readonly kind: vscode.SymbolKind;
    public readonly path: string;
    public readonly startLine: number;
    public readonly startCharacter: number;
    public readonly endLine: number;
    public readonly endCharacter: number;
    public readonly lineCount: number;
    public updateId: string = '';
    public position: Position | null = null;
    public children: SymbolModel[] = [];
    public constructor(
        id: string,
        name: string,
        kind: vscode.SymbolKind,
        path: string,
        startLine: number,
        startCharacter: number,
        endLine: number,
        endCharacter: number,
        parentId: string | null = null,
        updateId: string = '',
        position: Position | null = null
    ) {
        this.id = id;
        this.parentId = parentId;
        this.name = name;
        this.kind = kind;
        this.path = path;
        this.startLine = startLine;
        this.startCharacter = startCharacter;
        this.endLine = endLine;
        this.endCharacter = endCharacter;
        this.lineCount = endLine - startLine + 1;
        this.updateId = updateId;
        this.position = position ? new Position(position.x, position.y) : null;
    }
    public addChild(child: SymbolModel) {
        this.children.push(child);
    }
    public setPosition(x: number, y: number, z: number) {
        if (this.position) {
            this.position.set(x, y);
        } else {
            this.position = new Position(x, y);
        }
    } 
}
