import * as vscode from 'vscode';
import * as path from 'path';
import * as SYMBOL from './symbol';
import { createHash, hash } from 'crypto';

export function extract(filepath: string, document: vscode.TextDocument): Promise<SYMBOL.SymbolModel[]> {
    return new Promise(async (resolve, reject) => {
        try {
            // 書類からシンボルを抽出
            const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri);
            const symbolKinds = Object.values(vscode.SymbolKind) as vscode.SymbolKind[];
            const foundSymbols = docSymbols ? docSymbols.filter(symbol => symbolKinds.includes(symbol.kind)) : undefined;

            // シンボル階層を構築
            const symbols: SYMBOL.SymbolModel[] = [];
            const rootSymbol = new SYMBOL.SymbolModel(
                filepath, path.basename(filepath), vscode.SymbolKind.File, filepath,
                new vscode.Position(0, 0), new vscode.Position(0, 0), new vscode.Position(document.lineCount ? document.lineCount - 1 : 0, 0),
                Buffer.alloc(32), null
            );
            symbols.push(rootSymbol);
            const sumSymbol = (found: vscode.DocumentSymbol, parent: SYMBOL.SymbolModel) => {
                const kind = vscode.SymbolKind[found.kind] || 'Unknown';
                const hash = createHash('sha256').update(document.getText(found.range)).digest();
                const define = found.selectionRange;
                const branch = new SYMBOL.SymbolModel(
                    `${parent.id}/${kind}.${found.name}@${hash.toString('hex')}`,
                    found.name, found.kind, filepath,
                    define.start, found.range.start, found.range.end,
                    hash, parent.id
                );
                symbols.push(branch);
                found.children.forEach(child => { sumSymbol(child, branch); });
                parent.addChild(branch);
            };
            foundSymbols?.forEach(found => { sumSymbol(found, rootSymbol); });
            resolve(symbols);
        } catch (error) {
            reject(error);
        }
    });
}
