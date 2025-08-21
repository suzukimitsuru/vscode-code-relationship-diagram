import * as vscode from 'vscode';
import * as SYMBOL from './symbol';

export class Dictionary {
    constructor(public updated: Date, public symbol: SYMBOL.SymbolModel) {}
}

export function extract(path: string, document: vscode.TextDocument): Promise<SYMBOL.SymbolModel> {
    return new Promise(async (resolve, reject) => {
        try {
            // 書類からシンボルを抽出ll
            const docSymbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) as vscode.DocumentSymbol[];
            const symbolKinds = Object.values(vscode.SymbolKind) as vscode.SymbolKind[];
            const foundSymbols = docSymbols ? docSymbols.filter(symbol => symbolKinds.includes(symbol.kind)) : undefined;

            // シンボル階層を構築
            const fileName = path.split('/').pop() || path;
            const rootSymbol = new SYMBOL.SymbolModel(fileName, vscode.SymbolKind.File, path,
                0, 0, document.lineCount ? document.lineCount - 1 : 0, 0);
            const sumSymbol = (found: vscode.DocumentSymbol, parent: SYMBOL.SymbolModel) => {
                const branch = new SYMBOL.SymbolModel(found.name, found.kind, path,
                    found.range.start.line, found.range.start.character,
                    found.range.end.line, found.range.end.character,
                    parent.id);
                found.children.forEach(child => { sumSymbol(child, branch); });
                parent.addChild(branch);
            };
            foundSymbols?.forEach(found => { sumSymbol(found, rootSymbol); });
            resolve(rootSymbol);
        } catch (error) {
            reject(error);
        }
    });
}

export function each(symbol: SYMBOL.SymbolModel, callback: (symbol: SYMBOL.SymbolModel) => void): void {
    if (symbol.kind !== vscode.SymbolKind.File) {
        callback(symbol);
    }
    for (const child of symbol.children) {
        each(child, callback);
    }
}