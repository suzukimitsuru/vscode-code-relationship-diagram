import * as vscode from 'vscode';
import * as SYMBOL from './symbol';
import * as codeSymbols from './codeSymbols';

/** シンボル位置 */
export class SymbolLocation {
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
}

/** 関係(参照->定義) */
export class Relationship {
    /** 参照 */
    public readonly reference: SymbolLocation;
    /** 定義 */
    public readonly define: SymbolLocation;
    /** コンストラクタ */
    public constructor(reference: SymbolLocation, define: SymbolLocation) {
        this.reference = reference;
        this.define = define;
    }
}

/**
 * インデックス完了の検出
 * @returns 完了フラグ
 */
export async function indexingIsComplete(): Promise<boolean> {
    // プロジェクト全体のシンボル検索で完了度をテスト
    try {
        const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            'vscode.executeWorkspaceSymbolProvider',
            '' // 空文字で全シンボル取得試行
        );
        return workspaceSymbols !== undefined;
    } catch {
        return false;
    }
}

/**
 * 関係を調査する
 * @param wsFolder      ワークスペースフォルダ
 * @param define_uri    ファイルURI
 * @param root          ルートシンボル
 * @param symbol_all    シンボル辞書
 * @returns 関係配列
 */
export async function examine(wsFolder: string, define_uri: vscode.Uri,
    def_symbols: SYMBOL.SymbolModel[], symbol_all: Record<string, SYMBOL.SymbolModel[]>, retries: number
): Promise<Relationship[]> {
    const result: Relationship[] = [];
    for (const def_symbol of def_symbols) {
        // 親シンボルはスキップ
        if (def_symbol.parentId) {            
            // 関係を抽出する
            try {
                // 全ての参照を検索
                const ref_locs = await examineWithRetry(define_uri, def_symbol.define, retries);
                for (const ref_loc of ref_locs) {

                    // 参照パスが別のファイルで
                    const ref_path = ref_loc.uri.fsPath.substring(wsFolder.length + 1);
                    if (ref_path !== def_symbol.path) {

                        // 参照シンボルが在れば
                        const ref_root = symbol_all[ref_path];
                        if (ref_root) {
                            const ref_symbol = findSymbol(ref_root, ref_loc.range.start);
                            if (ref_symbol) {

                                // 関係を追加
                                result.push(new Relationship(
                                    new SymbolLocation(ref_symbol.id, ref_path, ref_loc.range.start.line),
                                    new SymbolLocation(def_symbol.id, def_symbol.path, def_symbol.start.line)
                                ));
                            }
                        }
                    }
                }
            } finally {
            }
        }
    }
    return result;
}

/**
 * リトライ機能付き関係調査
 * @param uri       ファイルURI
 * @param define    シンボル定義位置
 * @param retries   リトライ回数
 * @returns 関係リスト
 */
async function examineWithRetry(uri: vscode.Uri, define: vscode.Position, retries: number): Promise<vscode.Location[]> {
    const result: vscode.Location[] = [];
    let is_examined = false;
    for (let attempt = 0; (attempt < retries) && (result.length <= 0); attempt++) {
        try {
            const found = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, define);
            if (Array.isArray(found)) {
                if (found.length > 0 && found[0] instanceof vscode.Location) {
                    result.push(...found as vscode.Location[]);
                }
                is_examined = true;
            }
        } finally {
            if ((result.length <= 0) && (attempt < (retries - 1))) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }
    return result;
}

function findSymbol(symbols: SYMBOL.SymbolModel[], position: vscode.Position): SYMBOL.SymbolModel | null {
    let found: SYMBOL.SymbolModel | null = null;
    for (const symbol of symbols) {
        // 親シンボルはスキップ
        if (symbol.parentId) {            
            const range: vscode.Range = new vscode.Range(symbol.start, symbol.end);
            if (range.contains(position)) {
                found = symbol;
            }
        }
    }
    return found;
}
