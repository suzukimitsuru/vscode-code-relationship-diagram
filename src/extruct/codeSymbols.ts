import * as vscode from 'vscode';
import * as path from 'path';
import * as SYMBOL from './symbol';
import { AstDefinition, fileFqn } from './ast/localFacts';
import { createHash, hash } from 'crypto';

/**
 * AST の定義から、シンボルへ解決キー (完全修飾名・export 名) を付ける
 * @param relativePath ワークスペース相対パス
 * @param symbols シンボル配列 (DocumentSymbolProvider 由来、またはDBから読んだもの)
 * @param definitions 同じ内容から抽出した AST の定義
 * @returns 解決キーを付けたシンボルの数 (ファイルのルートシンボルを除く)
 * @description
 * - ファイルのルートシンボルにはファイルの完全修飾名 (`<path>#`) を付ける
 * - 名前の開始位置 (LSP の selectionRange.start と AST の名前ノードの開始) が一致する定義を付ける。
 *   どちらも UTF-16 の桁で数えるため、そのまま比較できる
 * - 位置が一致しなければ、シンボルの範囲内に名前がある同名の定義を付ける
 * - 1つの定義は1つのシンボルにしか付けない。付かなかったシンボルの解決キーは null にする
 */
export function attachAstKeys(relativePath: string, symbols: SYMBOL.SymbolModel[], definitions: AstDefinition[]): number {
    const byPosition = new Map<string, AstDefinition>();
    for (const definition of definitions) {
        byPosition.set(JSON.stringify([definition.nameLine, definition.nameCharacter]), definition);
    }
    const used = new Set<AstDefinition>();
    const attach = (symbol: SYMBOL.SymbolModel, definition: AstDefinition | undefined): boolean => {
        if (!definition || used.has(definition)) {
            return false;
        }
        used.add(definition);
        symbol.fqn = definition.fqn;
        symbol.exportName = definition.exportName;
        return true;
    };

    let attached = 0;
    const unmatched: SYMBOL.SymbolModel[] = [];
    for (const symbol of symbols) {
        symbol.fqn = null;
        symbol.exportName = null;
        if (!symbol.parentId) {
            symbol.fqn = fileFqn(relativePath);
        } else if (attach(symbol, byPosition.get(JSON.stringify([symbol.define.line, symbol.define.character])))) {
            attached++;
        } else {
            unmatched.push(symbol);
        }
    }
    const contains = (symbol: SYMBOL.SymbolModel, definition: AstDefinition): boolean => {
        const after = (definition.nameLine > symbol.start.line) ||
            (definition.nameLine === symbol.start.line && definition.nameCharacter >= symbol.start.character);
        const before = (definition.nameLine < symbol.end.line) ||
            (definition.nameLine === symbol.end.line && definition.nameCharacter <= symbol.end.character);
        return after && before;
    };
    for (const symbol of unmatched) {
        if (attach(symbol, definitions.find(definition =>
            !used.has(definition) && definition.name === symbol.name && contains(symbol, definition)))) {
            attached++;
        }
    }
    return attached;
}

export function extract(filepath: string, document: vscode.TextDocument): Promise<SYMBOL.SymbolModel[]> {
    return new Promise(async (resolve, reject) => {
        try {
            // 書類からシンボルを抽出
            const docSymbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', document.uri);
            const symbolKinds = Object.values(vscode.SymbolKind) as vscode.SymbolKind[];
            const foundSymbols = docSymbols ? docSymbols.filter(symbol => symbolKinds.includes(symbol.kind)) : undefined;

            // シンボル階層を構築
            const symbols: SYMBOL.SymbolModel[] = [];
            const rootSymbol = new SYMBOL.SymbolModel(
                filepath, path.basename(filepath), vscode.SymbolKind.File, filepath,
                new vscode.Position(0, 0), new vscode.Position(0, 0), new vscode.Position(document.lineCount ? document.lineCount - 1 : 0, 0),
                Buffer.alloc(32), null
            );
            symbols.push(rootSymbol);
            const sumSymbol = (found: vscode.DocumentSymbol, parent: SYMBOL.SymbolModel) => {
                const kind = vscode.SymbolKind[found.kind] || 'Unknown';
                const hash = createHash('sha256').update(document.getText(found.range)).digest();
                const define = found.selectionRange;
                const branch = new SYMBOL.SymbolModel(
                    `${parent.id}/${kind}.${found.name}@${hash.toString('hex')}`,
                    found.name, found.kind, filepath,
                    define.start, found.range.start, found.range.end,
                    hash, parent.id
                );
                symbols.push(branch);
                found.children.forEach(child => { sumSymbol(child, branch); });
                parent.addChild(branch);
            };
            foundSymbols?.forEach(found => { sumSymbol(found, rootSymbol); });
            resolve(symbols);
        } catch (error) {
            reject(error);
        }
    });
}
