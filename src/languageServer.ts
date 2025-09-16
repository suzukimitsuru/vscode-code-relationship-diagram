import * as vscode from 'vscode';
import * as lc from './languageCongig';

export class LanguageCompleteWaiter {
    private _editor: vscode.TextEditor | null = null;

    public async waitComplete(doc: vscode.TextDocument, config: lc.Config): Promise<boolean> {

        // 言語サーバーに優先して解析させるため、出来たらエディタで開く
        try {
            this._editor = await vscode.window.showTextDocument(doc, {preview: true, preserveFocus: true, viewColumn: vscode.ViewColumn.Beside});
        } catch (error) {
            this._editor = null;
        }

        // 言語サーバが準備完了なら
        if (
            await waitReady(doc.uri, 30 * 1000)  &&  // 言語サーバ準備完了
            await waitExtensionIsActive(config)  &&  // 言語サーバ拡張機能が有効
            await indexingIsComplete()               //　インデックス完了
        ) {
        } else {
            console.warn(`Skipping reference extraction for ${config.name} (no 言語サーバ)`);
        }

        return true;
    }

    public dispose() {

        // エディタで開けたら、閉じる
        if (this._editor) {
            this._editor.hide();
        }
        this._editor = null;
    }
}

/**
 * 言語サーバ準備完了を待つ
 * @param uri       ファイルURI
 * @returns 準備完了フラグ
 */
async function waitReady(uri: vscode.Uri, maxWait: number): Promise<boolean> {
    let result = false;
    
    const checkInterval = 1000; // 1秒
    for (let elapsed = 0; (elapsed < maxWait) && !result; elapsed += checkInterval) {
        try {
            // 複数のプロバイダーが利用可能かチェック
            const [symbols, hover, definition] = await Promise.all([
                vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri),
                vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(0, 0)),
                vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, new vscode.Position(0, 0))
            ]);

            // すべてのプロバイダーが応答する（エラーなし）
            if (symbols && hover && definition) {
                result = true;
            }
        } catch (error) {
            // まだ準備中
        }
        // 少し待つ
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    return result;
}

/**
 * 言語サーバ拡張機能が有効になるまで待つ
 * @param config 言語サーバ設定
 * @returns 有効フラグ
 */
async function waitExtensionIsActive(config: lc.Config): Promise<boolean> {
    let result = false;

    // 拡張機能が在ったら
    const extension = vscode.extensions.getExtension(config.extensionId);
    if (extension) {

        // 有効になるまで待つ
        while (true) {

            // 有効なら返す
            if (extension.isActive) {
                result = true;
                break;
            } else {

                // 有効化を試みる
                console.log(`Activating ${config.name} extension...`);
                try {
                    await extension.activate();
                } catch (error) {
                    console.error(`Failed to activate ${config.name} extension:`, error);
                    break;
                }

                // 有効待ち時間待つ
                await new Promise(resolve => setTimeout(resolve, config.activationDelay));
            }
        }
    } else {
        console.warn(`${config.name} extension not found (${config.extensionId})`);
    }
    return result;
}

/**
 * インデックス完了の検出
 * @returns 完了フラグ
 */
async function indexingIsComplete(): Promise<boolean> {
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
