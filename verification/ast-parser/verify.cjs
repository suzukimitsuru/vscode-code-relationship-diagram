/**
 * @file 配布物(dist)から WASM がロードされる事の検証
 * @description
 * `.vsix` に同梱されるのは `dist/` 配下のみである。
 * このスクリプトは拡張機能と同じ経路 —— `dist/extension.js` のバンドルと
 * `dist/wasm` / `dist/queries` の実ファイル —— で TS/JS がパースできるかを確認する。
 *
 * 使い方: node esbuild.js && node verification/ast-parser/verify.cjs
 */
const fs = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');
const distDir = path.join(projectRoot, 'dist');

/** 検証するソース（言語ごとの代表例） */
const SAMPLES = [
    { languageId: 'typescript', source: 'import { Base } from "./base";\nexport class A extends Base { run(x: T): void { new B().go(); } }' },
    { languageId: 'typescriptreact', source: 'const V = (p: Props) => <div>{p.label}</div>;' },
    { languageId: 'javascript', source: 'const fs = require("fs");\nclass A extends Base { run() { return new B(); } }' },
];

const main = async () => {
    // 1. 配布物の存在を確認する
    const required = [
        path.join(distDir, 'extension.js'),
        path.join(distDir, 'wasm', 'web-tree-sitter.wasm'),
        path.join(distDir, 'wasm', 'tree-sitter-typescript.wasm'),
        path.join(distDir, 'wasm', 'tree-sitter-tsx.wasm'),
        path.join(distDir, 'wasm', 'tree-sitter-javascript.wasm'),
        path.join(distDir, 'queries', 'typescript.scm'),
        path.join(distDir, 'queries', 'javascript.scm'),
    ];
    const missing = required.filter(file => !fs.existsSync(file));
    if (missing.length > 0) {
        throw new Error(`dist assets are missing:\n  ${missing.join('\n  ')}\nRun: node esbuild.js`);
    }
    let total = 0;
    for (const file of required.slice(1)) {
        const size = fs.statSync(file).size;
        total += size;
        console.log(`  ${path.relative(projectRoot, file).padEnd(42)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
    }
    console.log(`  ${'total (packaged AST assets)'.padEnd(42)} ${(total / 1024).toFixed(0).padStart(6)} KB`);

    // 2. 配布物が ESM 版の web-tree-sitter を巻き込んでいない事を確認する
    //    ESM 版は `createRequire(import.meta.url)` で WASM を読むため、CJS バンドルでは
    //    `import.meta.url` が undefined になり初期化に失敗する
    const bundled = fs.readFileSync(path.join(distDir, 'extension.js'), 'utf8');
    if (/createRequire\s*\(\s*import_meta/.test(bundled) || /import\.meta/.test(bundled)) {
        throw new Error('dist/extension.js contains import.meta: the ESM build of web-tree-sitter was bundled');
    }

    // 3. 拡張機能と同じ設定でバンドルし、dist と同じ配置で WASM をロードしてパースする
    //    (拡張機能は resolveAstResources(extensionPath) で dist/ を指す)
    const esbuild = require(path.join(projectRoot, 'node_modules', 'esbuild'));
    for (const minify of [false, true]) {
        const bundle = path.join(__dirname, '.build', minify ? 'ast.min.js' : 'ast.js');
        await esbuild.build({
            entryPoints: [path.join(projectRoot, 'src', 'extruct', 'ast', 'index.ts')],
            bundle: true, format: 'cjs', platform: 'node', outfile: bundle,
            external: ['vscode', 'duckdb'], minify: minify, logLevel: 'warning',
        });
        const label = minify ? 'bundled (esbuild --production)' : 'bundled (esbuild)';
        console.log(`  ${label.padEnd(42)} ${(fs.statSync(bundle).size / 1024).toFixed(0).padStart(6)} KB`);

        const { AstParser, resolveAstResources, missingAstResources } = require(bundle);
        const resources = resolveAstResources(projectRoot);
        if (missingAstResources(resources).length > 0) {
            throw new Error(`resolveAstResources() could not find assets: ${missingAstResources(resources).join(', ')}`);
        }
        const parser = await AstParser.create(resources);
        try {
            for (const sample of SAMPLES) {
                const captures = await parser.captures(sample.languageId, sample.source);
                const hasError = await parser.withTree(sample.languageId, sample.source, root => root.hasError);
                if (hasError || !captures || captures.length === 0) {
                    throw new Error(`${sample.languageId}: parse failed (hasError=${hasError}, captures=${captures ? captures.length : 'null'})`);
                }
                console.log(`    ${sample.languageId.padEnd(18)} OK  captures=${captures.length}`);
            }
            // 遅延ロード: 使った言語文法だけがロードされている
            const loaded = parser.loadedGrammars.join(', ');
            if (loaded !== 'javascript, tsx, typescript') {
                throw new Error(`unexpected loaded grammars: ${loaded}`);
            }
            console.log(`    loaded grammars    ${loaded}`);
        } finally {
            parser.dispose();
        }
    }

    // 4. 自リポジトリの TS を全てパースする（任意の TS/JS が扱える事の実地確認）
    const sources = [];
    const collect = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) { collect(full); }
            else if (entry.name.endsWith('.ts')) { sources.push(full); }
        }
    };
    collect(path.join(projectRoot, 'src'));

    const { AstParser, resolveAstResources } = require(path.join(__dirname, '.build', 'ast.js'));
    const parser = await AstParser.create(resolveAstResources(projectRoot));
    try {
        // tree-sitter は制御文字(NUL等)をソースに含むファイルを ERROR ノードにする。
        // TypeScript は受け付けるため、既知の限界として警告に留める
        const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;
        const failed = [];
        const warned = [];
        const elapsed = [];
        for (const file of sources) {
            const source = fs.readFileSync(file, 'utf8');
            const started = process.hrtime.bigint();
            const hasError = await parser.withTree('typescript', source, root => root.hasError);
            elapsed.push(Number(process.hrtime.bigint() - started) / 1e6);
            if (hasError !== false) {
                const relative = path.relative(projectRoot, file);
                (CONTROL_CHARACTERS.test(source) ? warned : failed).push(relative);
            }
        }
        elapsed.sort((a, b) => a - b);
        const median = elapsed[Math.floor(elapsed.length / 2)];
        const parsed = sources.length - failed.length - warned.length;
        console.log(`  self repository      ${parsed}/${sources.length} parsed, median ${median.toFixed(1)} ms/file, max ${elapsed[elapsed.length - 1].toFixed(1)} ms`);
        for (const file of warned) {
            console.log(`    WARN ${file}: contains a control character (known tree-sitter limitation)`);
        }
        if (failed.length > 0) {
            throw new Error(`failed to parse:\n  ${failed.join('\n  ')}`);
        }
    } finally {
        parser.dispose();
    }

    console.log('AST parser verification: PASSED');
};

main().catch(error => {
    console.error(`AST parser verification: FAILED\n${error && error.stack ? error.stack : error}`);
    process.exit(1);
});
