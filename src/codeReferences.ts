import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';

export interface Symbol {
    id: string;
    path: string;
    startLine: number;
}

export interface Reference {
    id: string;
    from: Symbol;
    to: Symbol;
}

export function extract(rootPath: string, from: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>): Promise<Reference[]> {
    return new Promise((resolve, reject) => {
        const promises: Promise<Reference[]>[] = [];

        // シンボルを列挙
        codeSymbols.each(from, (symbol) => {
            promises.push(extractReferences(rootPath, symbol, symbol_dic));
        });

        Promise.all(promises).then((results) => {
            const references = results.flat();
            resolve(references);
        }).catch(reject);
    });
}

function extractReferences(rootPath: string, symbol: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>): Promise<Reference[]> {
    return new Promise((resolve, reject) => {
        // シンボルの参照を取得
        const uri = vscode.Uri.file(path.join(rootPath, symbol.path));
        const position = new vscode.Position(symbol.startLine, symbol.startCharacter);
        vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, position).then((result) => {
            const references: Reference[] = [];
            const founds = result as vscode.Location[];
            if (founds && founds.length > 0) {
                for (const found of founds) {

                    // 他のファイルへの参照のみを対象とする
                    const to_path = found.uri.path.substring(rootPath.length + 1);
                    if (to_path !== symbol.path) {
                        const to_root = symbol_dic[to_path].symbol;
                        const to_symbol = findSymbol(to_root, found.range.start);
                        if (to_symbol) {
                            references.push({
                                id: randomUUID(),
                                from: {
                                    id: symbol.id,
                                    path: symbol.path,
                                    startLine: symbol.startLine
                                },
                                to: {
                                    id: to_symbol.id,
                                    path: to_path,
                                    startLine: found.range.start.line
                                }
                            });
                        }
                    }
                }
            }
            resolve(references);
        }, (error) => {
            reject(error);
        });
    });
}

function findSymbol(symbol: SYMBOL.SymbolModel, position: vscode.Position): SYMBOL.SymbolModel | null {
    let found: SYMBOL.SymbolModel | null = null;
    codeSymbols.each(symbol, (symbol) => {
        const range: vscode.Range = new vscode.Range(
            new vscode.Position(symbol.startLine, symbol.startCharacter),
            new vscode.Position(symbol.endLine, symbol.endCharacter)
        );
        if (range.contains(position)) {
            found = symbol;
        }
    });
    return found;
}
