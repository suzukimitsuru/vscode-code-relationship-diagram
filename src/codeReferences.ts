import * as vscode from 'vscode';
import * as path from 'path';
import { randomUUID } from 'crypto';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';
import * as lc from './languageCongig';

export class Symbol {
    public readonly id: string;
    private _path: string;
    private _startLine: number;
    public get path(): string { return this._path; }
    public get startLine(): number { return this._startLine; }
    public constructor(id: string, path: string, startLine: number) {
        this.id = id;
        this._path = path;
        this._startLine = startLine;
    }
    public update(path: string, startLine: number) {
        this._path = path;
        this._startLine = startLine;
    }
}

export class Reference {
    public readonly id: string;
    public readonly from: Symbol;
    public readonly to: Symbol;
    public constructor(id: string, from: Symbol, to: Symbol) {
        this.id = id;
        this.from = from;
        this.to = to;
    }
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
    root: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>, retries: number
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
            const locations = await extractWithRetry(uri, pos, config, retries, symbol.name);
            const references: Reference[] = [];
            console.log(`${config.name} ${symbol.name}: Processing ${locations.length} found references`);
            for (const location of locations) {

                // 参照先パスが別のファイルで
                const to_path = location.uri.fsPath.substring(wsPath.length + 1);
                console.log(`${config.name} ${symbol.name}: Processing reference at ${to_path}:${location.range.start.line}`);
                if (to_path !== symbol.path) {
                    console.log(`${config.name} ${symbol.name}: Cross-file reference to ${to_path}`);

                    // 参照先シンボルが在れば
                    const to_root = symbol_dic[to_path]?.symbol;
                    if (to_root) {
                        const to_symbol = findSymbol(to_root, location.range.start);
                        if (to_symbol) {
                            console.log(`${config.name} ${symbol.name}: Found target symbol ${to_symbol.id}`);

                            // 参照を追加
                            references.push(new Reference(randomUUID(),
                                new Symbol(symbol.id, symbol.path, symbol.startLine),
                                new Symbol(to_symbol.id, to_path, location.range.start.line)
                            ));
                        } else {
                            console.warn(`${config.name} ${symbol.name}: Could not find target symbol at ${to_path}:${location.range.start.line}`);
                        }
                    } else {
                        console.warn(`${config.name} ${symbol.name}: No symbol dictionary entry for ${to_path}`);
                    }
                } else {
                    console.log(`${config.name} ${symbol.name}: Skipping same-file reference`);
                }
            }
            
            console.log(`${config.name} ${symbol.name}: Extracted ${references.length} references for symbol ${symbol.id}`);
            result.push(...references);
        } catch (error) {
            console.error(`${config.name} ${symbol.name}: Failed to extract references for ${symbol.path}:${symbol.startLine}`, error);
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
async function extractWithRetry(uri: vscode.Uri, start: vscode.Position, config: lc.Config, retries: number, symbolName: string): Promise<vscode.Location[]> {
    const result: vscode.Location[] = [];
    console.log(`${config.name}: Attempting to get references for ${path.basename(uri.fsPath)} at line ${start.line}, char ${start.character}`);

    for (let attempt = 0; (attempt < retries) && (result.length <= 0); attempt++) {
        try {
            console.log(`${config.name} ${symbolName}: Attempt ${attempt + 1}/${retries}...`);

            const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, start) as vscode.Location[];
            console.log(`${config.name} ${symbolName}: executeReferenceProvider returned:`, locations);
            if (locations && locations.length > 0) {
                console.log(`${config.name} ${symbolName}: Found ${locations.length} references on attempt ${attempt + 1}`);
                result.push(...locations);
            } else {
                if (attempt < retries - 1) {
                    console.log(`${config.name} ${symbolName}: Attempt ${attempt + 1} returned empty, retrying in ${config.retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, config.retryDelay));
                } else {
                    console.log(`${config.name} ${symbolName}: All ${retries} attempts failed to find references`);
                }
            }
        } catch (error) {
            console.warn(`${config.name} ${symbolName}: Reference provider attempt ${attempt + 1} failed:`, error);
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
