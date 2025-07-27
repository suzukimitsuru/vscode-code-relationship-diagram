/** @file Code Attractor Editor: Symbol */
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

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
    public readonly kind: vscode.SymbolKind;
    public readonly path: string;
    public readonly startLine: number;
    public readonly endLine: number;
    public readonly lineCount: number;
    public updateId: string = '';
    public position: Position | null = null;
    public children: SymbolModel[] = [];
    public constructor(
        kind: vscode.SymbolKind,
        path: string,
        startLine: number,
        endLine: number,
        updateId: string = '',
        position: Position | null = null,
        id: string | null = null,
        parentId: string | null = null
    ) {
        this.id = id ?? randomUUID();
        this.parentId = parentId;
        this.kind = kind;
        this.path = path;
        this.startLine = startLine;
        this.endLine = endLine;
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
