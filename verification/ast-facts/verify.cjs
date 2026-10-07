/**
 * @file Stage 1 (Phase A: ローカル事実の抽出) の受け入れ基準の検証
 * @description
 * docs/ast-plan.md §12 Stage 1 の受け入れ基準を、自リポジトリを対象に実測する。
 *
 *   1. 自リポジトリ全ファイルで occurrences が保存される
 *   2. fqn がファイル内で一意
 *   3. パース時間 中央値 < 20ms/ファイル
 *   4. v1 DB から無停止で移行できる
 *
 * 拡張機能と同じ経路 (codeFiles.list による列挙・FactsExtractor・codeDb) を esbuild でバンドルして使う。
 * DuckDB は一時ディレクトリに作り、リポジトリ内の DB には書き込まない。
 *
 * 使い方: node verification/ast-facts/verify.cjs   (yarn verify:facts)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..', '..');

/** 拡張機能の files.associations 相当 (自リポジトリの TS/JS) */
const ASSOCIATIONS = {
    '**/*.ts': 'typescript',
    '**/*.tsx': 'typescriptreact',
    '**/*.js': 'javascript',
    '**/*.mjs': 'javascript',
    '**/*.cjs': 'javascript',
};

/** 受け入れ基準: パース時間の中央値 (ミリ秒/ファイル) */
const MEDIAN_LIMIT_MS = 20;

const KIND_NAMES = ['unknown', 'import', 'inheritance', 'implementation', 'instantiation', 'call', 'type_reference', 'read', 'write', 'decorator'];

const percentile = (sorted, ratio) => sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
const pad = (value, width) => String(value).padStart(width);

const main = async () => {
    // 1. AST 資産を dist へ配置し、拡張機能と同じモジュールをバンドルする
    //    codeDb は bindings/ を `<バンドルの親>/bindings` から読むため、out/ (gitignore 済み) へ出力する
    const { copyAstAssets } = await import(path.join(projectRoot, 'scripts', 'ast-assets.mjs'));
    copyAstAssets();
    const esbuild = require(path.join(projectRoot, 'node_modules', 'esbuild'));
    const bundle = path.join(projectRoot, 'out', 'verify-ast-facts.cjs');
    await esbuild.build({
        stdin: {
            contents: [
                "export * from './src/extruct/ast';",
                "export * as codeDb from './src/codeDb';",
                "export * as codeFiles from './src/extruct/codeFiles';",
            ].join('\n'),
            resolveDir: projectRoot, loader: 'ts',
        },
        bundle: true, format: 'cjs', platform: 'node', outfile: bundle,
        external: ['duckdb'], logLevel: 'warning',
        alias: { vscode: path.join(projectRoot, 'src', 'test', 'mocks', 'vscode.ts') },
    });
    const { AstParser, FactsExtractor, ModuleResolver, resolveAstResources, astLanguageOf, FACTS_VERSION, codeDb, codeFiles } = require(bundle);

    // 2. 拡張機能と同じ規則 (files.associations + .gitignore) で自リポジトリのファイルを列挙する
    const files = [];
    codeFiles.list(projectRoot, ASSOCIATIONS, codeFiles.loadGitignorePatterns(projectRoot), file => files.push(file));
    files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));

    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'crd-verify-facts-'));
    const parser = await AstParser.create(resolveAstResources(projectRoot));
    const extractor = new FactsExtractor(parser, new ModuleResolver(projectRoot));
    const db = new codeDb.Db(path.join(temporary, 'crd.duckdb'));
    const failures = [];
    try {
        await db.table_create();

        // 3. 1ファイルずつ抽出して保存する
        const elapsed = [];
        const warmups = [];     // 文法ごとの最初の1ファイル (WASM の遅延ロードとクエリのコンパイルを含む)
        const warmedGrammars = new Set();
        const totals = { definitions: 0, exported: 0, imports: 0, internal: 0, external: 0, unresolved: 0, occurrences: 0 };
        const kinds = new Array(KIND_NAMES.length).fill(0);
        const scopes = { module: 0, local: 0, unbound: 0, thisOrSuper: 0 };
        const warned = [];
        const duplicated = [];
        const extracted = new Map();
        for (const file of files) {
            const source = fs.readFileSync(path.join(projectRoot, file.relative_path), 'utf8').replace(/^\uFEFF/, '');
            const facts = await extractor.extract(file.relative_path, file.language_id, source);
            if (!facts) {
                failures.push(`${file.relative_path}: language '${file.language_id}' is not supported`);
                continue;
            }
            const grammar = astLanguageOf(file.language_id).grammar;
            if (warmedGrammars.has(grammar)) {
                elapsed.push(facts.elapsedMs);
            } else {
                warmedGrammars.add(grammar);
                warmups.push(`${grammar} ${facts.elapsedMs.toFixed(1)}ms (${file.relative_path})`);
            }
            extracted.set(file.relative_path, facts);
            if (facts.hasError) {
                warned.push(file.relative_path);
            }
            const fqns = facts.definitions.map(definition => definition.fqn);
            if (new Set(fqns).size !== fqns.length) {
                duplicated.push(`${file.relative_path}: ${fqns.filter((fqn, index) => fqns.indexOf(fqn) !== index).join(', ')}`);
            }
            totals.definitions += facts.definitions.length;
            totals.exported += facts.definitions.filter(definition => definition.exportName !== null).length;
            totals.imports += facts.imports.length;
            totals.internal += facts.imports.filter(entry => entry.resolvedPath !== null).length;
            totals.external += facts.imports.filter(entry => entry.isExternal).length;
            totals.unresolved += facts.imports.filter(entry => entry.resolvedPath === null && !entry.isExternal).length;
            totals.occurrences += facts.occurrences.length;
            for (const occurrence of facts.occurrences) {
                kinds[occurrence.kind]++;
                if (occurrence.rootName === 'this' || occurrence.rootName === 'super') { scopes.thisOrSuper++; }
                else if (occurrence.scopeId === null) { scopes.unbound++; }
                else if (occurrence.scopeId === 0) { scopes.module++; }
                else { scopes.local++; }
            }
            await db.codeFile_upsert(file, FACTS_VERSION);
            await db.facts_replace(file.relative_path, facts);
        }

        // 4. DB から読み戻し、抽出した件数と一致する事を確かめる
        let saved = 0;
        for (const [relativePath, facts] of extracted) {
            const found = await db.facts_query(relativePath);
            if (found.occurrences.length === facts.occurrences.length && found.imports.length === facts.imports.length) {
                saved++;
            } else {
                failures.push(`${relativePath}: saved ${found.occurrences.length}/${facts.occurrences.length} occurrences, ${found.imports.length}/${facts.imports.length} imports`);
            }
        }
        const versions = await db.codeFile_queryFactsVersions();
        const versioned = [...versions.values()].filter(version => version === FACTS_VERSION).length;

        // 5. 結果を表示する
        elapsed.sort((a, b) => a - b);
        const median = percentile(elapsed, 0.5);
        const byLanguage = files.reduce((count, file) => ({ ...count, [file.language_id]: (count[file.language_id] ?? 0) + 1 }), {});
        console.log(`files               ${files.length} (${Object.entries(byLanguage).map(([id, count]) => `${id} ${count}`).join(', ')})`);
        console.log(`saved               ${saved}/${extracted.size} files (occurrences and imports match), facts_version=${FACTS_VERSION} on ${versioned} files`);
        console.log(`definitions         ${totals.definitions} (exported ${totals.exported}), fqn duplicated in ${duplicated.length} files`);
        console.log(`imports             ${totals.imports} (in project ${totals.internal}, external ${totals.external}, unresolved ${totals.unresolved})`);
        console.log(`occurrences         ${totals.occurrences}`);
        console.log(`  by kind           ${KIND_NAMES.map((name, kind) => kinds[kind] > 0 ? `${name} ${kinds[kind]}` : '').filter(Boolean).join(', ')}`);
        console.log(`  by binding        module ${scopes.module}, local ${scopes.local}, unbound ${scopes.unbound}, this/super ${scopes.thisOrSuper}`);
        console.log(`elapsed (ms/file)   median ${median.toFixed(1)}, p95 ${percentile(elapsed, 0.95).toFixed(1)}, max ${elapsed[elapsed.length - 1].toFixed(1)}` +
            `  (parse + extract + resolve imports, ${elapsed.length} files)`);
        console.log(`  first per grammar ${warmups.join(', ')}  (includes lazy loading of the grammar and query compilation)`);
        const slowest = [...extracted.values()].sort((a, b) => b.elapsedMs - a.elapsedMs).slice(0, 3);
        console.log(`  slowest overall   ${slowest.map(facts => `${facts.relativePath} ${facts.elapsedMs.toFixed(1)}ms`).join(', ')}`);
        for (const file of warned) {
            console.log(`  WARN ${file}: has syntax error (facts are extracted from the rest of the file)`);
        }
        for (const entry of duplicated) {
            failures.push(`fqn is not unique: ${entry}`);
        }
        if (saved !== files.length) {
            failures.push(`only ${saved}/${files.length} files were saved`);
        }
        if (median >= MEDIAN_LIMIT_MS) {
            failures.push(`median ${median.toFixed(1)}ms/file exceeds ${MEDIAN_LIMIT_MS}ms`);
        }
    } finally {
        db.dispose();
        parser.dispose();
    }

    // 6. 拡張機能が作った実際の v1 DB を複製して移行する (元の DB には触れない)
    const source = path.join(projectRoot, 'exsample-workspace', '.vscode', 'crd.duckdb');
    const copy = path.join(temporary, 'v1.duckdb');
    fs.copyFileSync(source, copy);
    if (fs.existsSync(`${source}.wal`)) {
        fs.copyFileSync(`${source}.wal`, `${copy}.wal`);
    }
    const migrated = new codeDb.Db(copy);
    try {
        const count = async (table) => Number((await migrated.executeQuery(`SELECT COUNT(*) AS count FROM ${table}`))[0].count);
        const before = [await count('table_files'), await count('table_symbols'), await count('table_relationships')];
        const versionBefore = await migrated.executeQuery("SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_name = 'table_schema_version'");
        const started = performance.now();
        await migrated.table_create();
        const migrationMs = performance.now() - started;
        const after = [await count('table_files'), await count('table_symbols'), await count('table_relationships')];
        const version = await migrated.schema_version();
        console.log(`migration v1 -> v${version}  ${migrationMs.toFixed(0)}ms, rows files/symbols/relationships ${before.join('/')} -> ${after.join('/')}` +
            `${Number(versionBefore[0].count) === 0 ? ' (source had no schema version table = v1)' : ''}`);
        if (version !== codeDb.SCHEMA_VERSION || before.join('/') !== after.join('/')) {
            failures.push('migration of the v1 database did not preserve rows or did not reach the latest version');
        }
    } finally {
        migrated.dispose();
        fs.rmSync(temporary, { recursive: true, force: true });
    }

    if (failures.length > 0) {
        throw new Error(failures.join('\n'));
    }
    console.log('AST facts verification: PASSED');
};

main().catch(error => {
    console.error(`AST facts verification: FAILED\n${error && error.stack ? error.stack : error}`);
    process.exit(1);
});
