import * as vscode from 'vscode';
import * as SYMBOL from '../extruct/symbol';
import * as path from 'path';

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
 * インデックス完了待ち
 * @param retry 最大試行回数
 * @returns 試行回数
 */
export async function indexingCompleteWait(retry: number): Promise<number> {
    let attempt = 0;
    for (attempt = 0; attempt < retry; attempt++) {
        // プロジェクト全体のシンボル検索で完了度をテスト
        let is_complete = false;
        try {
            const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                '' // 空文字で全シンボル取得試行
            );
            is_complete = workspaceSymbols !== undefined;
        } catch {
            is_complete = false;
        }

        // インデックス作成が完了するまで待つ
        if (is_complete) {
            break;
        } else {
            // まだ完了していなかったら、もう少し待つ
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    return attempt + 1;
}

/** @description 参照ファイルのシンボル表を解決する関数（見つからなければ空配列） */
export type SymbolResolver = (refPath: string) => Promise<SYMBOL.SymbolModel[]>;

/**
 * 関係を調査する
 * @param wsFolder       ワークスペースフォルダ
 * @param define_uri     ファイルURI
 * @param def_symbols    定義側シンボル配列
 * @param resolveSymbols 参照ファイルのシンボル表を解決する関数
 * @param retries        リトライ回数
 * @param checkCancel    中断チェック（中断時は例外を投げる）
 * @returns 関係配列
 */
export async function examine(wsFolder: string, define_uri: vscode.Uri,
    def_symbols: SYMBOL.SymbolModel[], resolveSymbols: SymbolResolver, retries: number,
    checkCancel?: () => void
): Promise<Relationship[]> {
    const result: Relationship[] = [];
    for (const def_symbol of def_symbols) {
        // 親シンボルはスキップ
        if (def_symbol.parentId) {
            // 関係を抽出する
            try {
                // 全ての参照を検索
                checkCancel?.();
                const ref_locs = await examineWithRetry(define_uri, def_symbol.define, retries);
                checkCancel?.();
                for (const ref_loc of ref_locs) {

                    // 参照パスが別のファイルで
                    const ref_path = path.relative(wsFolder, ref_loc.uri.fsPath);
                    if (ref_path !== def_symbol.path) {

                        // 参照シンボルが在れば
                        const ref_root = await resolveSymbols(ref_path);
                        if (ref_root.length > 0) {
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
