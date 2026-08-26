/** @file AST 資産(WASM / クエリ)を dist へ配置する */
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** web-tree-sitter 本体の WASM (Parser.init が locateFile で探す) */
const RUNTIME_WASM = 'web-tree-sitter.wasm';

/** 同梱する言語文法の WASM (tree-sitter-<grammar>.wasm) */
const GRAMMAR_WASMS = ['typescript', 'tsx', 'javascript'];

/** dist 配下の配置先 (parser.ts の resources.ts と対応させる事) */
export const WASM_DIRNAME = 'wasm';
export const QUERY_DIRNAME = 'queries';

/** 1ファイルを複製する (内容が同じなら何もしない) */
const copyFile = (source, destination) => {
    if (!fs.existsSync(source)) {
        throw new Error(`AST asset not found: ${source}`);
    }
    if (fs.existsSync(destination)) {
        const from = fs.statSync(source);
        const to = fs.statSync(destination);
        if (from.size === to.size && from.mtimeMs <= to.mtimeMs) {
            return false;
        }
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    return true;
};

/**
 * AST 資産を dist へコピーする
 * @param {string} outDir 出力先ディレクトリ(既定: <project>/dist)
 * @returns {{wasmDir: string, queryDir: string, files: number, copied: number, bytes: number}} 配置結果
 */
export function copyAstAssets(outDir = path.join(projectRoot, 'dist')) {
    const wasmDir = path.join(outDir, WASM_DIRNAME);
    const queryDir = path.join(outDir, QUERY_DIRNAME);
    let files = 0;
    let copied = 0;
    let bytes = 0;

    // web-tree-sitter 本体の WASM
    const runtimeSource = path.join(projectRoot, 'node_modules', 'web-tree-sitter', RUNTIME_WASM);
    if (copyFile(runtimeSource, path.join(wasmDir, RUNTIME_WASM))) { copied++; }
    files++;
    bytes += fs.statSync(runtimeSource).size;

    // 言語文法の WASM (バンドルはせず実行時に遅延ロードする)
    const grammarDir = path.join(projectRoot, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm');
    for (const grammar of GRAMMAR_WASMS) {
        const name = `tree-sitter-${grammar}.wasm`;
        const source = path.join(grammarDir, name);
        if (copyFile(source, path.join(wasmDir, name))) { copied++; }
        files++;
        bytes += fs.statSync(source).size;
    }

    // 言語クエリ(.scm)
    const querySource = path.join(projectRoot, 'src', 'extruct', 'ast', 'queries');
    for (const name of fs.readdirSync(querySource).filter(file => file.endsWith('.scm'))) {
        const source = path.join(querySource, name);
        if (copyFile(source, path.join(queryDir, name))) { copied++; }
        files++;
        bytes += fs.statSync(source).size;
    }

    return { wasmDir, queryDir, files, copied, bytes };
}

// 直接実行された場合はコピーして結果を表示する
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = copyAstAssets();
    console.log(`[ast-assets] ${result.files} file(s) (${result.copied} updated), total ${(result.bytes / 1024 / 1024).toFixed(2)} MB -> ${result.wasmDir}`);
}
