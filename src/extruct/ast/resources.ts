/** @file AST 資産(WASM / クエリ)の配置解決 */
import * as fs from 'fs';
import * as path from 'path';

/** web-tree-sitter 本体の WASM 名 (Parser.init が locateFile で要求する) */
export const RUNTIME_WASM_NAME = 'web-tree-sitter.wasm';

/** dist 配下の配置先 (scripts/ast-assets.mjs と対応させる事) */
const WASM_DIRNAME = 'wasm';
const QUERY_DIRNAME = 'queries';

/** AST パーサが実行時に読み込む資産の在り処 */
export interface AstResources {

    /** web-tree-sitter 本体の WASM を含むディレクトリ */
    readonly wasmDirectory: string;

    /** 言語クエリ(.scm)を含むディレクトリ */
    readonly queryDirectory: string;
}

/**
 * 拡張機能のルートから AST 資産の配置を解決する
 * @param extensionRoot 拡張機能のルート(`ExtensionContext.extensionPath`)
 * @returns 資産の在り処
 * @description bindings/ と同じく、バンドルには含めず `dist/` 配下から実行時に読み込む
 */
export function resolveAstResources(extensionRoot: string): AstResources {
    const distDirectory = path.join(extensionRoot, 'dist');
    return {
        wasmDirectory: path.join(distDirectory, WASM_DIRNAME),
        queryDirectory: path.join(distDirectory, QUERY_DIRNAME),
    };
}

/**
 * 資産が配置済みかを確認する
 * @param resources 資産の在り処
 * @returns 不足している資産のパス(全て揃っていれば空配列)
 */
export function missingAstResources(resources: AstResources): string[] {
    const missing: string[] = [];
    const runtime = path.join(resources.wasmDirectory, RUNTIME_WASM_NAME);
    if (!fs.existsSync(runtime)) {
        missing.push(runtime);
    }
    if (!fs.existsSync(resources.queryDirectory)) {
        missing.push(resources.queryDirectory);
    }
    return missing;
}
