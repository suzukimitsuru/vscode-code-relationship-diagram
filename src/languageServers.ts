import * as vscode from 'vscode';

/** 言語サーバ設定 */
export interface Config {
    extensionId: string;
    name: string;
    activationDelay: number; // ms
    retryDelay: number; // ms
}

/** 言語サーバ設定配列 */
const LANGUAGE_SERVERS: Record<string, Config> = {
    // C/C++
    'c': { extensionId: 'ms-vscode.cpptools', name: 'C/C++', activationDelay: 2000, retryDelay: 1000 },
    'cpp': { extensionId: 'ms-vscode.cpptools', name: 'C/C++', activationDelay: 2000, retryDelay: 1000 },
    
    // Python
    'python': { extensionId: 'ms-python.python', name: 'Python', activationDelay: 3000, retryDelay: 800 },
    
    // Java
    'java': { extensionId: 'redhat.java', name: 'Java', activationDelay: 5000, retryDelay: 1500 },
    
    // JavaScript/TypeScript
    'javascript': { extensionId: 'vscode.typescript-language-features', name: 'JavaScript', activationDelay: 1000, retryDelay: 500 },
    'typescript': { extensionId: 'vscode.typescript-language-features', name: 'TypeScript', activationDelay: 1000, retryDelay: 500 },
    
    // C#
    'csharp': { extensionId: 'ms-dotnettools.csharp', name: 'C#', activationDelay: 3000, retryDelay: 1000 },
    
    // Go
    'go': { extensionId: 'golang.go', name: 'Go', activationDelay: 2000, retryDelay: 1000 },
    
    // Rust
    'rust': { extensionId: 'rust-lang.rust-analyzer', name: 'Rust Analyzer', activationDelay: 3000, retryDelay: 1200 },
    
    // PHP
    'php': { extensionId: 'bmewburn.vscode-intelephense-client', name: 'PHP Intelephense', activationDelay: 2000, retryDelay: 1000 },
    
    // Ruby
    'ruby': { extensionId: 'shopify.ruby-lsp', name: 'Ruby LSP', activationDelay: 2500, retryDelay: 1000 },
    
    // Swift
    'swift': { extensionId: 'sswg.swift-lang', name: 'Swift', activationDelay: 3000, retryDelay: 1200 },
    
    // Kotlin
    'kotlin': { extensionId: 'fwcd.kotlin', name: 'Kotlin 言語サーバ', activationDelay: 4000, retryDelay: 1500 },
    
    // Scala
    'scala': { extensionId: 'scalameta.metals', name: 'Metals', activationDelay: 5000, retryDelay: 1500 },
    
    // Dart/Flutter
    'dart': { extensionId: 'dart-code.dart-code', name: 'Dart', activationDelay: 2500, retryDelay: 1000 },
    
    // HTML/CSS/JSON
    'html': { extensionId: 'vscode.html-language-features', name: 'HTML', activationDelay: 1000, retryDelay: 500 },
    'css': { extensionId: 'vscode.css-language-features', name: 'CSS', activationDelay: 1000, retryDelay: 500 },
    'scss': { extensionId: 'vscode.css-language-features', name: 'SCSS', activationDelay: 1000, retryDelay: 500 },
    'less': { extensionId: 'vscode.css-language-features', name: 'Less', activationDelay: 1000, retryDelay: 500 },
    'json': { extensionId: 'vscode.json-language-features', name: 'JSON', activationDelay: 500, retryDelay: 300 },
    
    // Markup Languages
    'xml': { extensionId: 'redhat.vscode-xml', name: 'XML', activationDelay: 2000, retryDelay: 800 },
    'yaml': { extensionId: 'redhat.vscode-yaml', name: 'YAML', activationDelay: 1500, retryDelay: 600 },
    'markdown': { extensionId: 'yzhang.markdown-all-in-one', name: 'Markdown', activationDelay: 1000, retryDelay: 500 },
    'toml': { extensionId: 'tamasfe.even-better-toml', name: 'Even Better TOML', activationDelay: 1000, retryDelay: 500 },
    'ini': { extensionId: 'davidanson.vscode-markdownlint', name: 'INI', activationDelay: 500, retryDelay: 300 },
    
    // Shell/PowerShell
    'shellscript': { extensionId: 'timonwong.shellcheck', name: 'ShellCheck', activationDelay: 1500, retryDelay: 700 },
    'powershell': { extensionId: 'ms-vscode.powershell', name: 'PowerShell', activationDelay: 3000, retryDelay: 1000 },
    'bash': { extensionId: 'timonwong.shellcheck', name: 'ShellCheck', activationDelay: 1500, retryDelay: 700 },
    'zsh': { extensionId: 'timonwong.shellcheck', name: 'ShellCheck', activationDelay: 1500, retryDelay: 700 },
    'fish': { extensionId: 'bmalehorn.vscode-fish', name: 'Fish', activationDelay: 1000, retryDelay: 500 },
    
    // Database
    'sql': { extensionId: 'ms-mssql.mssql', name: 'SQL Server', activationDelay: 2500, retryDelay: 1000 },
    'mysql': { extensionId: 'formulahendry.vscode-mysql', name: 'MySQL', activationDelay: 2000, retryDelay: 800 },
    'postgresql': { extensionId: 'ckolkman.vscode-postgres', name: 'PostgreSQL', activationDelay: 2000, retryDelay: 800 },
    'sqlite': { extensionId: 'alexcvzz.vscode-sqlite', name: 'SQLite', activationDelay: 1500, retryDelay: 600 },
    'mongodb': { extensionId: 'mongodb.mongodb-vscode', name: 'MongoDB', activationDelay: 2500, retryDelay: 1000 },
    
    // Functional Languages
    'haskell': { extensionId: 'haskell.haskell', name: 'Haskell', activationDelay: 4000, retryDelay: 1500 },
    'ocaml': { extensionId: 'ocamllabs.ocaml-platform', name: 'OCaml', activationDelay: 3500, retryDelay: 1200 },
    'fsharp': { extensionId: 'ionide.ionide-fsharp', name: 'F#', activationDelay: 3000, retryDelay: 1000 },
    'clojure': { extensionId: 'betterthantomorrow.calva', name: 'Calva', activationDelay: 3000, retryDelay: 1000 },
    'elixir': { extensionId: 'jakebecker.elixir-ls', name: 'ElixirLS', activationDelay: 3000, retryDelay: 1000 },
    'erlang': { extensionId: 'pgourlain.erlang', name: 'Erlang', activationDelay: 2500, retryDelay: 1000 },
    'scheme': { extensionId: 'sjhuangx.vscode-scheme', name: 'Scheme', activationDelay: 1500, retryDelay: 600 },
    'racket': { extensionId: 'evzen-wybitul.magic-racket', name: 'Magic Racket', activationDelay: 2000, retryDelay: 800 },
    'commonlisp': { extensionId: 'ailisp.commonlisp-vscode', name: 'Common Lisp', activationDelay: 2000, retryDelay: 800 },
    
    // JVM Languages
    'groovy': { extensionId: 'redhat.vscode-extension-pack', name: 'Groovy', activationDelay: 3000, retryDelay: 1000 },
    //'clojure': { extensionId: 'betterthantomorrow.calva', name: 'Calva', activationDelay: 3000, retryDelay: 1000 },
    
    // System Languages
    'zig': { extensionId: 'ziglang.vscode-zig', name: 'Zig', activationDelay: 2000, retryDelay: 800 },
    'nim': { extensionId: 'premun.vscode-nim', name: 'Nim', activationDelay: 2500, retryDelay: 1000 },
    'd': { extensionId: 'webfreak.dlang', name: 'D Language', activationDelay: 2500, retryDelay: 1000 },
    'crystal': { extensionId: 'crystal-lang-tools.crystal-lang', name: 'Crystal', activationDelay: 2500, retryDelay: 1000 },
    'carbon': { extensionId: 'carbon.carbon-lang', name: 'Carbon', activationDelay: 2000, retryDelay: 800 },
    'v': { extensionId: 'vlang.vscode-vlang', name: 'V', activationDelay: 2000, retryDelay: 800 },
    'odin': { extensionId: 'danielgavin.ols', name: 'Odin 言語サーバ', activationDelay: 2000, retryDelay: 800 },
    
    // Scripting Languages
    'lua': { extensionId: 'sumneko.lua', name: 'Lua', activationDelay: 2000, retryDelay: 800 },
    'perl': { extensionId: 'richterger.perl', name: 'Perl', activationDelay: 2000, retryDelay: 800 },
    'r': { extensionId: 'ikuyadeu.r', name: 'R', activationDelay: 2500, retryDelay: 1000 },
    'julia': { extensionId: 'julialang.language-julia', name: 'Julia', activationDelay: 4000, retryDelay: 1500 },
    'tcl': { extensionId: 'bitwisecook.tcl', name: 'Tcl', activationDelay: 1500, retryDelay: 600 },
    'awk': { extensionId: 'luggage66.awk', name: 'AWK', activationDelay: 1000, retryDelay: 500 },
    'sed': { extensionId: 'zhangciwu.sed-syntax', name: 'SED', activationDelay: 500, retryDelay: 300 },
    
    // Web Technologies
    'vue': { extensionId: 'vue.volar', name: 'Volar', activationDelay: 2000, retryDelay: 800 },
    'svelte': { extensionId: 'svelte.svelte-vscode', name: 'Svelte', activationDelay: 2000, retryDelay: 800 },
    'angular': { extensionId: 'angular.ng-template', name: 'Angular Language Service', activationDelay: 3000, retryDelay: 1000 },
    'react': { extensionId: 'vscode.typescript-language-features', name: 'TypeScript', activationDelay: 1000, retryDelay: 500 },
    'astro': { extensionId: 'astro-build.astro-vscode', name: 'Astro', activationDelay: 2000, retryDelay: 800 },
    'solid': { extensionId: 'solidjs-community.solid', name: 'SolidJS', activationDelay: 2000, retryDelay: 800 },
    'ember': { extensionId: 'emberjs.emberjs', name: 'Ember.js', activationDelay: 2500, retryDelay: 1000 },
    'lit': { extensionId: 'runem.lit-plugin', name: 'Lit Plugin', activationDelay: 1500, retryDelay: 600 },
    'stencil': { extensionId: 'ionic.ionic', name: 'Stencil', activationDelay: 2000, retryDelay: 800 },
    
    // Mobile Development
    'objective-c': { extensionId: 'ms-vscode.cpptools', name: 'C/C++', activationDelay: 2000, retryDelay: 1000 },
    'objective-cpp': { extensionId: 'ms-vscode.cpptools', name: 'C/C++', activationDelay: 2000, retryDelay: 1000 },
    'xamarin': { extensionId: 'ms-dotnettools.csharp', name: 'C#', activationDelay: 3000, retryDelay: 1000 },
    'reactnative': { extensionId: 'msjsdiag.vscode-react-native', name: 'React Native Tools', activationDelay: 2500, retryDelay: 1000 },
    'flutter': { extensionId: 'dart-code.flutter', name: 'Flutter', activationDelay: 3000, retryDelay: 1200 },
    'unity': { extensionId: 'visualstudiotoolsforunity.vstuc', name: 'Unity', activationDelay: 3000, retryDelay: 1200 },
    
    // Configuration Languages
    'dockerfile': { extensionId: 'ms-azuretools.vscode-docker', name: 'Docker', activationDelay: 1500, retryDelay: 600 },
    'dockercompose': { extensionId: 'ms-azuretools.vscode-docker', name: 'Docker', activationDelay: 1500, retryDelay: 600 },
    'terraform': { extensionId: 'hashicorp.terraform', name: 'Terraform', activationDelay: 2000, retryDelay: 800 },
    'makefile': { extensionId: 'ms-vscode.makefile-tools', name: 'Makefile Tools', activationDelay: 1000, retryDelay: 500 },
    'cmake': { extensionId: 'twxs.cmake', name: 'CMake', activationDelay: 1500, retryDelay: 600 },
    'bazel': { extensionId: 'bazelbuild.vscode-bazel', name: 'Bazel', activationDelay: 2000, retryDelay: 800 },
    'gradle': { extensionId: 'naco-siren.gradle-language-server', name: 'Gradle', activationDelay: 2500, retryDelay: 1000 },
    'ant': { extensionId: 'redhat.java', name: 'Java', activationDelay: 2000, retryDelay: 800 },
    'maven': { extensionId: 'redhat.java', name: 'Java', activationDelay: 2000, retryDelay: 800 },
    'sbt': { extensionId: 'scalameta.metals', name: 'Metals', activationDelay: 3000, retryDelay: 1200 },
    'ninja': { extensionId: 'ms-vscode.cmake-tools', name: 'CMake Tools', activationDelay: 1500, retryDelay: 600 },
    'meson': { extensionId: 'asabil.meson', name: 'Meson', activationDelay: 1500, retryDelay: 600 },
    
    // Assembly & Low-level
    'asm': { extensionId: '13xforever.language-x86-64-assembly', name: 'x86-64 Assembly', activationDelay: 1000, retryDelay: 500 },
    'nasm': { extensionId: '13xforever.language-x86-64-assembly', name: 'x86-64 Assembly', activationDelay: 1000, retryDelay: 500 },
    'gas': { extensionId: '13xforever.language-x86-64-assembly', name: 'x86-64 Assembly', activationDelay: 1000, retryDelay: 500 },
    'masm': { extensionId: '13xforever.language-x86-64-assembly', name: 'x86-64 Assembly', activationDelay: 1000, retryDelay: 500 },
    'arm': { extensionId: 'dan-c-underwood.arm', name: 'ARM Assembly', activationDelay: 1000, retryDelay: 500 },
    'riscv': { extensionId: 'zhwu95.riscv', name: 'RISC-V', activationDelay: 1000, retryDelay: 500 },
    'wasm': { extensionId: 'dtsvet.vscode-wasm', name: 'WebAssembly', activationDelay: 1500, retryDelay: 600 },
    
    // Blockchain & Smart Contracts
    'solidity': { extensionId: 'juanblanco.solidity', name: 'Solidity', activationDelay: 2000, retryDelay: 800 },
    'vyper': { extensionId: 'tintinweb.solidity-visual-auditor', name: 'Vyper', activationDelay: 2000, retryDelay: 800 },
    'move': { extensionId: 'move.move-analyzer', name: 'Move Analyzer', activationDelay: 2500, retryDelay: 1000 },
    'cairo': { extensionId: 'starkware.cairo1', name: 'Cairo', activationDelay: 2500, retryDelay: 1000 },
    'clarity': { extensionId: 'lgalabru.clarity', name: 'Clarity', activationDelay: 2000, retryDelay: 800 },
    'cadence': { extensionId: 'onflow.cadence', name: 'Cadence', activationDelay: 2000, retryDelay: 800 },
    
    // Scientific Computing & Data Science
    'matlab': { extensionId: 'mathworks.language-matlab', name: 'MATLAB', activationDelay: 3000, retryDelay: 1200 },
    'octave': { extensionId: 'toasty-technologies.octave', name: 'Octave', activationDelay: 2000, retryDelay: 800 },
    'scilab': { extensionId: 'scilab.scilab-lsp', name: 'Scilab', activationDelay: 2500, retryDelay: 1000 },
    'fortran': { extensionId: 'fortls.fortls', name: 'Fortran 言語サーバ', activationDelay: 2000, retryDelay: 800 },
    'cobol': { extensionId: 'broadcommainfram.cobol-language-support', name: 'COBOL', activationDelay: 2500, retryDelay: 1000 },
    'mathematica': { extensionId: 'njpipeorgan.wolfram-language', name: 'Wolfram Language', activationDelay: 3000, retryDelay: 1200 },
    'sage': { extensionId: 'sagemath.sage-language-server', name: 'SageMath', activationDelay: 3000, retryDelay: 1200 },
    
    // GPU Computing & Parallel Programming
    'cuda': { extensionId: 'nvidia.nsight-vscode-edition', name: 'Nsight Visual Studio Code Edition', activationDelay: 2500, retryDelay: 1000 },
    'opencl': { extensionId: 'galarius.vscode-opencl', name: 'OpenCL', activationDelay: 2000, retryDelay: 800 },
    'hlsl': { extensionId: 'timgrant.hlsl', name: 'HLSL Tools', activationDelay: 1500, retryDelay: 600 },
    'glsl': { extensionId: 'slevesque.shader', name: 'Shader Languages Support', activationDelay: 1500, retryDelay: 600 },
    'metal': { extensionId: 'dmenozzi.metal', name: 'Metal', activationDelay: 1500, retryDelay: 600 },
    
    // Game Development
    'gdscript': { extensionId: 'geequlim.godot-tools', name: 'godot-tools', activationDelay: 2000, retryDelay: 800 },
    'unrealscript': { extensionId: 'epicgames.unreal-engine', name: 'Unreal Engine', activationDelay: 3000, retryDelay: 1200 },
    'actionscript': { extensionId: 'bowlerhatllc.vscode-as3mxml', name: 'ActionScript & MXML', activationDelay: 2000, retryDelay: 800 },
    
    // Specialized DSLs & Tools
    'regex': { extensionId: 'chrisbibby.hide-comments', name: 'Regular Expressions', activationDelay: 500, retryDelay: 300 },
    'dot': { extensionId: 'joaompinto.vscode-graphviz', name: 'Graphviz', activationDelay: 1000, retryDelay: 500 },
    'plantuml': { extensionId: 'jebbs.plantuml', name: 'PlantUML', activationDelay: 1500, retryDelay: 600 },
    'mermaid': { extensionId: 'bierner.markdown-mermaid', name: 'Markdown Mermaid', activationDelay: 1000, retryDelay: 500 },
    'latex': { extensionId: 'james-yu.latex-workshop', name: 'LaTeX Workshop', activationDelay: 2500, retryDelay: 1000 },
    'bibtex': { extensionId: 'james-yu.latex-workshop', name: 'LaTeX Workshop', activationDelay: 2000, retryDelay: 800 },
    'gnuplot': { extensionId: 'mammothb.gnuplot', name: 'Gnuplot', activationDelay: 1000, retryDelay: 500 },
    
    // Historic & Educational Languages
    'pascal': { extensionId: 'alefragnani.pascal', name: 'Pascal', activationDelay: 1500, retryDelay: 600 },
    'basic': { extensionId: 'bkiers.vscode-qbasic', name: 'QBasic', activationDelay: 1000, retryDelay: 500 },
    'logo': { extensionId: 'techtheawesome.logo-ls', name: 'Logo', activationDelay: 1000, retryDelay: 500 },
    'smalltalk': { extensionId: 'janbrummer.vscode-smalltalk', name: 'Smalltalk', activationDelay: 2000, retryDelay: 800 },
    'forth': { extensionId: 'amitben.forth', name: 'Forth', activationDelay: 1000, retryDelay: 500 },
    'prolog': { extensionId: 'arthwang.vsc-prolog', name: 'VSC-Prolog', activationDelay: 1500, retryDelay: 600 },
    
    // Esoteric & Fun Languages
    'brainfuck': { extensionId: 'tomphilbin.brainfuck', name: 'Brainfuck', activationDelay: 500, retryDelay: 300 },
    'whitespace': { extensionId: 'yiufung.whitespace-language', name: 'Whitespace', activationDelay: 500, retryDelay: 300 }
};

/**
 * 言語サーバ設定を取得する
 * @param languageId 言語ID
 * @returns 言語サーバ設定 or null
 */
export function getConfig(languageId: string): Config | null {
    return LANGUAGE_SERVERS[languageId] ? LANGUAGE_SERVERS[languageId] : null;
}

/**
 * 言語サーバ拡張機能を有効化する
 * @param config 言語サーバ設定
 * @returns 有効フラグ
 */
export async function activeExtension(config: Config): Promise<boolean> {
    let result = false;

    // 言語サーバ設定が在って
    if (config) {

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
    }    
    return result;
}

// 言語サーバ準備確認
export async function ensureReady(doc: vscode.TextDocument, config: Config): Promise<boolean> {
    let result = false;
    console.log(`${config.name}: Preparing 言語サーバ for ${doc.uri.path}...`);
    
    // 言語サーバの準備を待つ
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // 複数の方法で言語サーバ機能を確認
    const checks = [
        // シンボル抽出
        { name: 'DocumentSymbolProvider', execute: () => vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri) },
        { name: 'HoverProvider', execute: () => vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri, new vscode.Position(0, 0)) },
        { name: 'DefinitionProvider', execute: () => vscode.commands.executeCommand('vscode.executeDefinitionProvider', doc.uri, new vscode.Position(0, 0)) }
    ];
    
    for (const check of checks) {
        try {
            console.log(`${config.name}: Checking ${check.name}...`);
            const command = await check.execute();
            console.log(`${config.name}: ${check.name} result:`, command);
            if (command && (Array.isArray(command) ? command.length > 0 : true)) {
                console.log(`${config.name} 言語サーバ is ready for ${doc.uri.path}`);
                result = true;
                break;
            }
        } catch (error) {
            console.warn(`${config.name}: ${check.name} check failed:`, error);
        }
    }

    return result;
}

/**
 * リトライ機能付き参照取得
 * @param uri       ファイルURI
 * @param start     シンボル開始位置
 * @param config    言語サーバ設定
 * @param retries   リトライ回数
 * @returns 参照リスト
 */
export async function getReferenceWithRetry(uri: vscode.Uri, start: vscode.Position, config: Config, retries: number): Promise<vscode.Location[]> {
    const result: vscode.Location[] = [];
    console.log(`${config.name}: Attempting to get references for ${uri.path} at line ${start.line}, char ${start.character}`);

    for (let attempt = 0; (attempt < retries) && (result.length <= 0); attempt++) {
        try {
            console.log(`${config.name}: Attempt ${attempt + 1}/${retries}...`);

            const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, start) as vscode.Location[];
            console.log(`${config.name}: executeReferenceProvider returned:`, locations);
            if (locations && locations.length > 0) {
                console.log(`${config.name}: Found ${locations.length} references on attempt ${attempt + 1}`);
                result.push(...locations);
            } else {
                if (attempt < retries - 1) {
                    console.log(`${config.name}: Attempt ${attempt + 1} returned empty, retrying in ${config.retryDelay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, config.retryDelay));
                } else {
                    console.log(`${config.name}: All ${retries} attempts failed to find references`);
                }
            }
        } catch (error) {
            console.warn(`${config.name}: Reference provider attempt ${attempt + 1} failed:`, error);
            if (attempt < retries - 1) {
                await new Promise(resolve => setTimeout(resolve, config.retryDelay));
            }
        }
    }
    return result;
}

/* ⏺ 型付き言語でも100%の保証はありませんが、信頼性を高める方法とインデックス状態の検出方法があります。
  重要な注意:
  - 型付き言語でも動的な要素（リフレクション、動的ロード等）は検出困難
  - 大規模プロジェクトでは完全なインデックス化に時間がかかる
  - 外部依存関係の参照は言語サーバーの設定に依存

  最も実用的なのは、複数の情報源を組み合わせて信頼性を判定し、不完全な可能性をログに記録することです。

//  参照取得の信頼性を高める方法

// 1. 言語サーバーの完全初期化待機
async function waitForLanguageServerReady(document: vscode.TextDocument): Promise<boolean> {
    const uri = document.uri;
    const maxWait = 30000; // 30秒
    const checkInterval = 1000; // 1秒
    for (let elapsed = 0; elapsed < maxWait; elapsed += checkInterval) {
        try {
            // 複数のプロバイダーが利用可能かチェック
            const [symbols, hover, definition] = await Promise.all([
                vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', uri),
                vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, new vscode.Position(0, 0)),
                vscode.commands.executeCommand<vscode.Location[]>('vscode.executeDefinitionProvider', uri, new vscode.Position(0, 0))
            ]);

            // すべてのプロバイダーが応答する（エラーなし）
            if (symbols !== undefined && hover !== undefined && definition !== undefined) {
                return true;
            }
        } catch (error) {
            // まだ準備中
        }
        await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
    return false;
}

// 2. インデックス完了状態の検出
async function checkIndexingStatus(): Promise<{isComplete: boolean, progress?: number}> {
    // TypeScript言語サーバーの場合
    const tsExtension = vscode.extensions.getExtension('vscode.typescript-language-features');
    if (tsExtension?.isActive) {
        // TypeScript言語サーバーのステータス確認
        const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);

        // プロジェクト全体のシンボル検索で完了度をテスト
        try {
            const workspaceSymbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
                'vscode.executeWorkspaceSymbolProvider',
                '' // 空文字で全シンボル取得試行
            );
            return {
                isComplete: workspaceSymbols !== undefined,
                progress: workspaceSymbols?.length
            };
        } catch {
            return { isComplete: false };
        }
    }
    return { isComplete: false };
}

// 3. 言語固有の完全性チェック
async function verifyReferenceCompleteness(uri: vscode.Uri, position: vscode.Position): Promise<{references: vscode.Location[], isReliable: boolean}> {
    // 1. 基本的な参照取得
    const references = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeReferenceProvider', uri, position
    );
    // 2. 定義情報で存在確認
    const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
        'vscode.executeDefinitionProvider', uri, position
    );
    // 3. ホバー情報で型情報確認
    const hover = await vscode.commands.executeCommand<vscode.Hover[]>(
        'vscode.executeHoverProvider', uri, position
    );
    // 4. シンボル情報確認
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        'vscode.executeDocumentSymbolProvider', uri
    );
    // 信頼性判定
    const isReliable = !!(
        definitions && definitions.length > 0 &&  // 定義が見つかる
        hover && hover.length > 0 &&             // 型情報がある
        symbols && symbols.length > 0            // シンボルが解析済み
    );
    return {
        references: references || [],
        isReliable
    };
}
// 4. プロジェクトレベルのインデックス完了待機
async function waitForProjectIndexing(): Promise<boolean> {
    const workspace = vscode.workspace;
    if (!workspace.workspaceFolders) {
        return false;
    } else {
        // 主要ファイルでのシンボル解析完了を確認
        const testFiles = await vscode.workspace.findFiles('*⭐️*⭐️/*.{ts,js,py,java,cs}', null, 10);
        for (const file of testFiles) {
            const document = await vscode.workspace.openTextDocument(file);
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider', file
            );

            if (!symbols || symbols.length === 0) {
                // まだインデックス中の可能性
                return false;
            }
        }
        return true;
    }
}
// 5. 実用的な組み合わせ
async function getReferencesReliably(uri: vscode.Uri, position: vscode.Position) {
    // 1. 言語サーバー準備待機
    const document = await vscode.workspace.openTextDocument(uri);
    const isReady = await waitForLanguageServerReady(document);
    if (!isReady) {
        console.warn('Language server not ready');
        return [];
    }
    // 2. インデックス状態確認
    const indexStatus = await checkIndexingStatus();
    if (!indexStatus.isComplete) {
        console.warn('Project indexing incomplete');
    }
    // 3. 完全性チェック付き参照取得
    const result = await verifyReferenceCompleteness(uri, position);
    if (!result.isReliable) {
        console.warn('Reference result may be incomplete');
    }
    return result.references;
}
*/
