import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';
import * as ls from './languageServers';

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

export async function extract(rootPath: string, languageId: string, from: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>): Promise<Reference[]> {
    const symbols: SYMBOL.SymbolModel[] = [];
    codeSymbols.each(from, (symbol) => {
        symbols.push(symbol);
    });
    
    console.log(`Processing ${symbols.length} symbols for ${languageId}...`);
    
    // languageIdを使用してLanguage Server設定を確認
    const config = await ls.checkLanguageServerStatus(languageId);
    if (!config) {
        console.warn(`Skipping reference extraction for ${languageId} (no Language Server)`);
        return [];
    }
    
    const allReferences: Reference[] = [];
    const BATCH_SIZE = config.activationDelay > 2000 ? 3 : 5;
    
    let processed = 0;
    let successful = 0;
    let failed = 0;
    let totalReferences = 0;
    
    for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        const promises = batch.map(symbol => extractReferences(rootPath, languageId, symbol, symbol_dic, config));
        
        const results = await Promise.allSettled(promises);
        
        for (const result of results) {
            processed++;
            if (result.status === 'fulfilled') {
                successful++;
                totalReferences += result.value.length;
                allReferences.push(...result.value);
            } else {
                failed++;
                console.warn(`${languageId}: Reference extraction failed:`, result.reason);
            }
        }
        
        // バッチ間の待機（Language Server負荷軽減）
        if (i + BATCH_SIZE < symbols.length) {
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    }
    
    console.log(`${languageId}: ${successful}/${processed} successful, ${totalReferences} references found`);
    return allReferences;
}

async function extractReferences(
    rootPath: string, 
    languageId: string, 
    symbol: SYMBOL.SymbolModel, 
    symbol_dic: Record<string, codeSymbols.Dictionary>,
    config: ls.LanguageServerConfig
): Promise<Reference[]> {
    
    const filePath = path.join(rootPath, symbol.path);
    const uri = vscode.Uri.file(filePath);
    
    // シンボルの位置を使用（selectionRangeで取得された正確な位置）
    const searchPosition = new vscode.Position(symbol.startLine, symbol.startCharacter);
    console.log(`${config.name}: Using search position ${searchPosition.line}:${searchPosition.character}`);
    
    console.log(`${config.name}: Extracting references for symbol ${symbol.id} in ${symbol.path}:${symbol.startLine}:${symbol.startCharacter} (languageId: ${languageId})`);
    console.log(`${config.name}: Symbol details - kind: ${symbol.kind}, name: ${symbol.name}, range: ${symbol.startLine}:${symbol.startCharacter}-${symbol.endLine}:${symbol.endCharacter}`);
    
    try {
        // Language Serverの準備確認
        const isReady = await ls.ensureLanguageServerReady(uri, config);
        if (!isReady) {
            // 準備が完了していなくても処理を続行（ベストエフォート）
            console.warn(`${config.name}: Proceeding with potentially unready Language Server for ${symbol.path}`);
        }
        
        // リトライ付きで参照取得
        const founds = await ls.getReferenceWithRetry(uri, searchPosition, config);
        const references: Reference[] = [];
        console.log(`${config.name}: Processing ${founds.length} found references`);
        
        for (const found of founds) {
            console.log(`${config.name}: Processing reference at ${found.uri.path}:${found.range.start.line}`);
            const to_path = found.uri.path.substring(rootPath.length + 1);
            if (to_path !== symbol.path) {
                console.log(`${config.name}: Cross-file reference to ${to_path}`);
                const to_root = symbol_dic[to_path]?.symbol;
                if (to_root) {
                    const to_symbol = findSymbol(to_root, found.range.start);
                    if (to_symbol) {
                        console.log(`${config.name}: Found target symbol ${to_symbol.id}`);
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
                    } else {
                        console.warn(`${config.name}: Could not find target symbol at ${to_path}:${found.range.start.line}`);
                    }
                } else {
                    console.warn(`${config.name}: No symbol dictionary entry for ${to_path}`);
                }
            } else {
                console.log(`${config.name}: Skipping same-file reference`);
            }
        }
        
        console.log(`${config.name}: Extracted ${references.length} references for symbol ${symbol.id}`);
        return references;
        
    } catch (error) {
        console.error(`${config.name}: Failed to extract references for ${symbol.path}:${symbol.startLine}`, error);
        return [];
    }
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
