import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as codeDb from './codeDb';
import { Logs } from './logs';

export interface Reference {
    id: string;
    fromSymbolId: string;
    toSymbolId: string;
    fromPath: string;
    toPath: string;
    referenceType: string;
    lineNumber: number;
}

export async function extractReferences(document: vscode.TextDocument, symbolId: string, db: codeDb.Db, logs: Logs, rootPath?: string): Promise<Reference[]> {
    const references: Reference[] = [];
    
    try {
        // ドキュメント内のすべてのシンボルを取得
        const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri) as vscode.DocumentSymbol[];

        // 各シンボルに対して参照を検索
        const allSymbols = flattenSymbols(symbols);
        for (const symbol of allSymbols) {
            const symbolPosition = symbol.selectionRange.start;
            
            try {
                const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', document.uri, symbolPosition) as vscode.Location[];
                if (locations && locations.length > 0) {
                    for (const location of locations) {

                        // 他のファイルへの参照のみを対象とする
                        if (location.uri.toString() !== document.uri.toString()) {
                            const targetDocument = await vscode.workspace.openTextDocument(location.uri);
                            const targetSymbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', targetDocument.uri) as vscode.DocumentSymbol[];
                            const targetSymbol = findSymbolAtPosition(targetSymbols, location.range.start);
                            if (targetSymbol) {
                                try {
                                    // 絶対パスを相対パスに変換
                                    const fromRelativePath = getRelativePath(document.uri.fsPath, logs, rootPath);
                                    const toRelativePath = getRelativePath(location.uri.fsPath, logs, rootPath);
                                    
                                    // DBからtargetSymbolの実際のUUIDを検索（相対パスで）
                                    const toSymbolId = await db.symbol_findId(toRelativePath, targetSymbol.name, targetSymbol.range.start.line);
                                    if (toSymbolId) {
                                        references.push({
                                            id: randomUUID(),
                                            fromSymbolId: symbolId,
                                            toSymbolId: toSymbolId,
                                            fromPath: fromRelativePath,
                                            toPath: toRelativePath,
                                            referenceType: 'reference',
                                            lineNumber: location.range.start.line
                                        });
                                        logs.log(`Reference found: ${fromRelativePath} -> ${toRelativePath}:${targetSymbol.name}:${targetSymbol.range.start.line}`);
                                    } else {
                                        logs.warn(`Target symbol not found in DB: ${toRelativePath}:${targetSymbol.name}:${targetSymbol.range.start.line}`);
                                    }
                                } catch (dbError) {
                                    logs.error(`Error querying target symbol from DB: ${location.uri.fsPath}:${targetSymbol.name}:${targetSymbol.range.start.line}`, dbError);
                                }
                            }
                        }
                    }
                }
            } catch (symbolError) {
                // 個別のシンボルでエラーが発生しても処理を続行
                logs.warn(`Error processing symbol ${symbol.name} in document ${document.uri.fsPath}:`, symbolError);
            }
        }
    } catch (error) {
        logs.error(`Error extracting references from document ${document.uri.fsPath}:`, error);
    }

    return references;
}

function getRelativePath(absolutePath: string, logs: Logs, rootPath?: string): string {
    if (!rootPath) {
        // rootPathが指定されていない場合は、絶対パスをそのまま返す
        return absolutePath;
    }
    
    try {
        const relativePath = path.relative(rootPath, absolutePath);
        // Windows環境でも'/'区切りに統一
        return relativePath.replace(/\\/g, '/');
    } catch (error) {
        logs.warn(`Failed to convert to relative path: ${absolutePath}`, error);
        return absolutePath;
    }
}

function flattenSymbols(symbols: vscode.DocumentSymbol[]): vscode.DocumentSymbol[] {
    const flattened: vscode.DocumentSymbol[] = [];
    
    function addSymbolsRecursively(symbolList: vscode.DocumentSymbol[]) {
        for (const symbol of symbolList) {
            flattened.push(symbol);
            if (symbol.children && symbol.children.length > 0) {
                addSymbolsRecursively(symbol.children);
            }
        }
    }
    
    addSymbolsRecursively(symbols);
    return flattened;
}

function findSymbolAtPosition(symbols: vscode.DocumentSymbol[], position: vscode.Position): vscode.DocumentSymbol | null {
    for (const symbol of symbols) {
        if (symbol.range.contains(position)) {
            const childSymbol = findSymbolAtPosition(symbol.children, position);
            return childSymbol || symbol;
        }
    }
    return null;
}