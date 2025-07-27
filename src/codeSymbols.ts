import * as vscode from 'vscode';
import * as SYMBOL from './symbol';

export function load(path: string, document: vscode.TextDocument): Promise<SYMBOL.SymbolModel> {
    return new Promise(async (resolve, reject) => {
        try {
            // 書類からシンボルを抽出ll
            const docSymbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) as vscode.DocumentSymbol[];
            const symbolKinds = Object.values(vscode.SymbolKind) as vscode.SymbolKind[];
            const foundSymbols = docSymbols ? docSymbols.filter(symbol => symbolKinds.includes(symbol.kind)) : undefined;

            // シンボル階層を構築
            const rootSymbol = new SYMBOL.SymbolModel(vscode.SymbolKind.File, path, 0, document.lineCount ? document.lineCount - 1 : 0);
            const sumSymbol = (found: vscode.DocumentSymbol, symbol: SYMBOL.SymbolModel) => {
                const branch = new SYMBOL.SymbolModel(found.kind, path, found.range.start.line, found.range.end.line);
                found.children.forEach(child => { sumSymbol(child, branch); });
                symbol.addChild(branch);
            };
            foundSymbols?.forEach(found => { sumSymbol(found, rootSymbol); });
            resolve(rootSymbol);
        } catch (error) {
            reject(error);
        }
    });
}
