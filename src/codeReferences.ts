import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';
import * as ls from './languageServers';

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
 * @param languageId    言語ID
 * @param doc           ドキュメント
 * @param root          ルートシンボル
 * @param symbol_dic    シンボル辞書
 * @returns 参照リスト
 */
export async function extract(wsPath: string, languageId: string, doc: vscode.TextDocument,
    root: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>
): Promise<Reference[]> {
    const result: Reference[] = [];
    
    const symbols: SYMBOL.SymbolModel[] = [];
    codeSymbols.each(root, (symbol) => {
        symbols.push(symbol);
    });
    
    console.log(`Processing ${symbols.length} symbols for ${languageId}...`);
    
    // 言語サーバ設定が在ったら
    const config = ls.getConfig(languageId);
    if (config) {

        // 言語サーバーに優先して解析させるため、エディタで開く
        const editor = await vscode.window.showTextDocument(doc, {preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside});

        // 言語サーバが有効なら
        if (await ls.activeExtension(config)) {
            for (const symbol of symbols) {

                // 関係を抽出する
                const file_path = path.join(wsPath, symbol.path);
                const file_uri = vscode.Uri.file(file_path);
                const reference = await extractReferences(wsPath, doc, symbol, symbol_dic, config);
                result.push(...reference);
                
                // 言語サーバ負荷軽減のため少し待つ
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            console.log(`${languageId}: successful, ${result.length} references found`);
        } else {
            console.warn(`Skipping reference extraction for ${languageId} (no 言語サーバ)`);
        }

        editor.hide();
    } else {
        console.warn(`No 言語サーバ configuration for ${languageId}, skipping reference extraction.`);
    }
    return result;
}

/**
 * 関係を抽出する
 * @param wsPath        ワークスペースのパス
 * @param doc           ドキュメント
 * @param target        対象シンボル
 * @param symbol_dic    シンボル辞書
 * @param config        言語サーバ設定
 * @returns 参照リスト
 */
async function extractReferences(wsPath: string, doc: vscode.TextDocument,
    target: SYMBOL.SymbolModel, symbol_dic: Record<string, codeSymbols.Dictionary>,
    config: ls.Config
): Promise<Reference[]> {
    const result: Reference[] = [];
    console.log(`${config.name}: Symbol details - ${target.kind} ${target.name} is ${target.path}:${target.startLine},${target.startCharacter}-${target.endLine},${target.endCharacter}`);
    try {
        // 言語サーバの準備確認
        const isReady = await ls.ensureReady(doc, config);
        if (isReady) {
        
            // リトライ付きで参照取得
            const pos = new vscode.Position(target.startLine, target.startCharacter);
            const locations = await ls.getReferenceWithRetry(doc.uri, pos, config, Infinity);
            const references: Reference[] = [];
            console.log(`${config.name}: Processing ${locations.length} found references`);
            for (const location of locations) {

                // 参照先パスが別のファイルで
                const to_path = location.uri.fsPath.substring(wsPath.length + 1);
                console.log(`${config.name}: Processing reference at ${to_path}:${location.range.start.line}`);
                if (to_path !== target.path) {
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
                                from: { id: target.id,    path: target.path, startLine: target.startLine},
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
            
            console.log(`${config.name}: Extracted ${references.length} references for symbol ${target.id}`);
            result.push(...references);
        } else {
            // 準備が完了していなくても処理を続行（ベストエフォート）
            console.warn(`${config.name}: Proceeding with potentially unready 言語サーバ for ${target.path}`);
        }
    } catch (error) {
        console.error(`${config.name}: Failed to extract references for ${target.path}:${target.startLine}`, error);
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
