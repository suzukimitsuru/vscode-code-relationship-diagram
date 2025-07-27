import * as vscode from 'vscode';
import { randomUUID } from 'crypto';

export interface SymbolReference {
    id: string;
    fromSymbolId: string;
    toSymbolId: string;
    fromPath: string;
    toPath: string;
    referenceType: string;
    lineNumber: number;
}

export async function extractReferences(
    document: vscode.TextDocument,
    symbolId: string
): Promise<SymbolReference[]> {
    const references: SymbolReference[] = [];
    
    try {
        const locations = await vscode.commands.executeCommand(
            'vscode.executeReferenceProvider',
            document.uri,
            new vscode.Position(0, 0)
        ) as vscode.Location[];

        if (locations) {
            for (const location of locations) {
                if (location.uri.toString() !== document.uri.toString()) {
                    const targetDocument = await vscode.workspace.openTextDocument(location.uri);
                    const targetSymbols = await vscode.commands.executeCommand(
                        'vscode.executeDocumentSymbolProvider',
                        targetDocument.uri
                    ) as vscode.DocumentSymbol[];

                    const targetSymbol = findSymbolAtPosition(targetSymbols, location.range.start);
                    if (targetSymbol) {
                        references.push({
                            id: randomUUID(),
                            fromSymbolId: symbolId,
                            toSymbolId: `${location.uri.fsPath}:${targetSymbol.name}`,
                            fromPath: document.uri.fsPath,
                            toPath: location.uri.fsPath,
                            referenceType: 'reference',
                            lineNumber: location.range.start.line
                        });
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error extracting references:', error);
    }

    return references;
}

function findSymbolAtPosition(
    symbols: vscode.DocumentSymbol[],
    position: vscode.Position
): vscode.DocumentSymbol | null {
    for (const symbol of symbols) {
        if (symbol.range.contains(position)) {
            const childSymbol = findSymbolAtPosition(symbol.children, position);
            return childSymbol || symbol;
        }
    }
    return null;
}