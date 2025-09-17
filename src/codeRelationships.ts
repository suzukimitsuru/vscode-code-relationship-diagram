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

/** 関係(参照->定義) */
export class Relationship {
    /** 識別 */
    public readonly id: string;
    /** 参照 */
    public readonly reference: Symbol;
    /** 定義 */
    public readonly define: Symbol;
    /** コンストラクタ */
    public constructor(id: string, reference: Symbol, define: Symbol) {
        this.id = id;
        this.reference = reference;
        this.define = define;
    }
}

/**
 * 関係を抽出する
 * @param wsFolder      ワークスペースフォルダ
 * @param config        言語サーバ設定
 * @param uri           ファイルURI
 * @param root          ルートシンボル
 * @param symbol_dic    シンボル辞書
 * @returns 関係配列
 */
export async function extract(wsFolder: string, config: lc.Config, uri: vscode.Uri,
    root: SYMBOL.SymbolModel, symbol_dic: Record<string,codeSymbols.Dictionary>, retries: number
): Promise<Relationship[]> {
    const result: Relationship[] = [];
    
    const symbols: SYMBOL.SymbolModel[] = [];
    codeSymbols.each(root, (symbol) => {
        symbols.push(symbol);
    });
    for (const symbol of symbols) {

        // 関係を抽出する
        try {
            // リトライ付きで関係取得
            const pos = new vscode.Position(symbol.startLine, symbol.startCharacter);
            const locations = await extractWithRetry(uri, pos, config, retries, symbol.name);
            const relationships: Relationship[] = [];
            console.log(`${config.name} ${symbol.name}: Processing ${locations.length} found relationships`);
            for (const location of locations) {

                // 参照パスが別のファイルで
                const reference_path = location.uri.fsPath.substring(wsFolder.length + 1);
                console.log(`${config.name} ${symbol.name}: Processing relationship at ${reference_path}:${location.range.start.line}`);
                if (reference_path !== symbol.path) {
                    console.log(`${config.name} ${symbol.name}: Cross-file relationship referrence ${reference_path}`);

                    // 参照シンボルが在れば
                    const reference_root = symbol_dic[reference_path]?.symbol;
                    if (reference_root) {
                        const reference_symbol = findSymbol(reference_root, location.range.start);
                        if (reference_symbol) {
                            console.log(`${config.name} ${symbol.name}: Found source symbol ${reference_symbol.id}`);

                            // 関係を追加
                            relationships.push(new Relationship(randomUUID(),
                                new Symbol(reference_symbol.id, reference_path, location.range.start.line),
                                new Symbol(symbol.id, symbol.path, symbol.startLine)
                            ));
                        } else {
                            console.warn(`${config.name} ${symbol.name}: Could not find target symbol at ${reference_path}:${location.range.start.line}`);
                        }
                    } else {
                        console.warn(`${config.name} ${symbol.name}: No symbol dictionary entry for ${reference_path}`);
                    }
                } else {
                    console.log(`${config.name} ${symbol.name}: Skipping same-file relationship`);
                }
            }
            
            console.log(`${config.name} ${symbol.name}: Extracted ${relationships.length} relationships for symbol ${symbol.id}`);
            result.push(...relationships);
        } catch (error) {
            console.error(`${config.name} ${symbol.name}: Failed to extract relationships for ${symbol.path}:${symbol.startLine}`, error);
        }
        
        // 言語サーバ負荷軽減のため少し待つ
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    console.log(`${root.path}: successful, ${result.length} relationships found`);

    return result;
}

/**
 * リトライ機能付き関係抽出
 * @param uri       ファイルURI
 * @param start     シンボル開始位置
 * @param config    言語サーバ設定
 * @param retries   リトライ回数
 * @returns 関係リスト
 */
async function extractWithRetry(uri: vscode.Uri, start: vscode.Position, config: lc.Config, retries: number, symbolName: string): Promise<vscode.Location[]> {
    const result: vscode.Location[] = [];
    console.log(`${config.name}: Attempting to get relationships for ${path.basename(uri.fsPath)} at line ${start.line}, char ${start.character}`);

    for (let attempt = 0; (attempt < retries) && (result.length <= 0); attempt++) {
        try {
            console.log(`${config.name} ${symbolName}: Attempt ${attempt + 1}/${retries}...`);

            const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, start) as vscode.Location[];
            console.log(`${config.name} ${symbolName}: executeReferenceProvider returned:`, locations);
            if (locations && locations.length > 0) {
                console.log(`${config.name} ${symbolName}: Found ${locations.length} relationships on attempt ${attempt + 1}`);
                result.push(...locations);
            } else {
                if (attempt < retries - 1) {
                    console.log(`${config.name} ${symbolName}: Attempt ${attempt + 1} returned empty, retrying in ${config.retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, config.retryDelay));
                } else {
                    console.log(`${config.name} ${symbolName}: All ${retries} attempts failed to find relationships`);
                }
            }
        } catch (error) {
            console.warn(`${config.name} ${symbolName}: Relationship provider attempt ${attempt + 1} failed:`, error);
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
