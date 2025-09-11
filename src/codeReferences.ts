import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';
import * as lc from './languageCongig';

interface Symbol {
    id: string;
    path: string;
    startLine: number;
}

export interface Reference {
    id: string;
    from: Symbol;
    to: Symbol;
}

/**
 * 関係を抽出する
 * @param wsPath        ワークスペースのパス
 * @param config        言語サーバ設定
 * @param uri           ファイルURI
 * @param root          ルートシンボル
 * @param symbol_dic    シンボル辞書
 * @returns 参照リスト
 */
export async function extract(wsPath: string, config: lc.Config, uri: vscode.Uri,
    root: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>
): Promise<Reference[]> {
    const result: Reference[] = [];
    
    const symbols: SYMBOL.SymbolModel[] = [];
    codeSymbols.each(root, (symbol) => {
        symbols.push(symbol);
    });
    for (const symbol of symbols) {

        // 関係を抽出する
        try {
            // リトライ付きで参照取得
            const pos = new vscode.Position(symbol.startLine, symbol.startCharacter);
            const locations = await extractWithRetry(uri, pos, config, Infinity);
            const references: Reference[] = [];
            console.log(`${config.name}: Processing ${locations.length} found references`);
            for (const location of locations) {

                // 参照先パスが別のファイルで
                const to_path = location.uri.fsPath.substring(wsPath.length + 1);
                console.log(`${config.name}: Processing reference at ${to_path}:${location.range.start.line}`);
                if (to_path !== symbol.path) {
                    console.log(`${config.name}: Cross-file reference to ${to_path}`);

                    // 参照先シンボルが在れば
                    const to_root = symbol_dic[to_path]?.symbol;
                    if (to_root) {
                        const to_symbol = findSymbol(to_root, location.range.start);
                        if (to_symbol) {
                            console.log(`${config.name}: Found target symbol ${to_symbol.id}`);

                            // 参照を追加
                            references.push({
                                id: randomUUID(),
                                from: { id: symbol.id,    path: symbol.path, startLine: symbol.startLine},
                                to:   { id: to_symbol.id, path: to_path,     startLine: location.range.start.line}
                            });
                        } else {
                            console.warn(`${config.name}: Could not find target symbol at ${to_path}:${location.range.start.line}`);
                        }
                    } else {
                        console.warn(`${config.name}: No symbol dictionary entry for ${to_path}`);
                    }
                } else {
                    console.log(`${config.name}: Skipping same-file reference`);
                }
            }
            
            console.log(`${config.name}: Extracted ${references.length} references for symbol ${symbol.id}`);
            result.push(...references);
        } catch (error) {
            console.error(`${config.name}: Failed to extract references for ${symbol.path}:${symbol.startLine}`, error);
        }
        
        // 言語サーバ負荷軽減のため少し待つ
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    console.log(`${root.path}: successful, ${result.length} references found`);

    return result;
}

/**
 * リトライ機能付き参照抽出
 * @param uri       ファイルURI
 * @param start     シンボル開始位置
 * @param config    言語サーバ設定
 * @param retries   リトライ回数
 * @returns 参照リスト
 */
async function extractWithRetry(uri: vscode.Uri, start: vscode.Position, config: lc.Config, retries: number): Promise<vscode.Location[]> {
    const result: vscode.Location[] = [];
    console.log(`${config.name}: Attempting to get references for ${uri.fsPath} at line ${start.line}, char ${start.character}`);

    for (let attempt = 0; (attempt < retries) && (result.length <= 0); attempt++) {
        try {
            console.log(`${config.name}: Attempt ${attempt + 1}/${retries}...`);

            const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, start) as vscode.Location[];
            console.log(`${config.name}: executeReferenceProvider returned:`, locations);
            if (locations && locations.length > 0) {
                console.log(`${config.name}: Found ${locations.length} references on attempt ${attempt + 1}`);
                result.push(...locations);
            } else {
                if (attempt < retries - 1) {
                    console.log(`${config.name}: Attempt ${attempt + 1} returned empty, retrying in ${config.retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, config.retryDelay));
                } else {
                    console.log(`${config.name}: All ${retries} attempts failed to find references`);
                }
            }
        } catch (error) {
            console.warn(`${config.name}: Reference provider attempt ${attempt + 1} failed:`, error);
            if (attempt < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, config.retryDelay));
            }
        }
    }
    return result;
}

function findSymbol(root: SYMBOL.SymbolModel, position: vscode.Position): SYMBOL.SymbolModel | null {
    let found: SYMBOL.SymbolModel | null = null;

    codeSymbols.each(root, (symbol) => {
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
