/** @file モジュール指定子の解決 (docs/ast-plan.md §7.2) */
import * as fs from 'fs';
import * as path from 'path';

/** 解決結果 */
export interface ModuleResolution {

    /** 解決先のワークスペース相対パス (解決できない・ワークスペース外なら null) */
    readonly resolvedPath: string | null;

    /** プロジェクト外か (パッケージ・組込みモジュール・ワークスペース外のファイル) */
    readonly isExternal: boolean;
}

/** ファイルシステムへの問い合わせ (単体テストで差し替える) */
export interface ModuleResolverHost {
    fileExists(absolutePath: string): boolean;
    readFile(absolutePath: string): string | undefined;
}

/** 実ファイルシステム */
export const NODE_MODULE_RESOLVER_HOST: ModuleResolverHost = {
    fileExists: (absolutePath) => {
        try {
            return fs.statSync(absolutePath).isFile();
        } catch {
            return false;
        }
    },
    readFile: (absolutePath) => {
        try {
            return fs.readFileSync(absolutePath, 'utf8');
        } catch {
            return undefined;
        }
    },
};

/** 拡張子を省いた指定子に補う拡張子 (TypeScript の探索順) */
const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** 拡張子付きのまま解決できる拡張子 */
const LOADABLE = new Set([...EXTENSIONS, '.json']);

/** ESM 形式の TypeScript が書く出力側の拡張子 (`./a.js`) から探すソース側の拡張子 */
const EMITTED_TO_SOURCE: Record<string, string[]> = {
    '.js': ['.ts', '.tsx', '.d.ts'],
    '.jsx': ['.tsx'],
    '.mjs': ['.mts', '.d.mts'],
    '.cjs': ['.cts', '.d.cts'],
};

/** tsconfig.json / jsconfig.json から読むモジュール解決の設定 */
interface ResolverConfig {

    /** baseUrl (絶対パス) */
    readonly baseUrl: string | null;

    /** paths の対応表 (パターン → 置換先) */
    readonly paths: readonly [string, readonly string[]][];

    /** paths の置換先の基準 (baseUrl が無ければ paths を定義した設定ファイルのディレクトリ) */
    readonly pathsBase: string | null;
}

/** 設定の探索は多段の extends を想定し、循環を避けるため深さを制限する */
const MAX_EXTENDS_DEPTH = 5;

/**
 * JSONC (コメント・末尾カンマ付き JSON) を読む
 * @param text 設定ファイルの内容
 * @returns 値。読めなければ null
 */
export function parseJsonc(text: string): unknown {
    let output = '';
    let index = 0;
    while (index < text.length) {
        const character = text[index];
        if (character === '"') {
            // 文字列はエスケープを含めてそのまま写す
            let end = index + 1;
            while (end < text.length && text[end] !== '"') {
                end += text[end] === '\\' ? 2 : 1;
            }
            output += text.slice(index, end + 1);
            index = end + 1;
        } else if (character === '/' && text[index + 1] === '/') {
            while (index < text.length && text[index] !== '\n') {
                index++;
            }
        } else if (character === '/' && text[index + 1] === '*') {
            const end = text.indexOf('*/', index + 2);
            index = end < 0 ? text.length : end + 2;
        } else {
            output += character;
            index++;
        }
    }
    try {
        return JSON.parse(output.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
        return null;
    }
}

/**
 * モジュール指定子をワークスペース内のファイルへ解決する
 * @description
 * - 相対指定 (`./` `../`) はファイルからの相対で、拡張子と index.* を補って探す
 * - パッケージ名などの非相対指定は、最寄りの tsconfig.json / jsconfig.json の paths と baseUrl で
 *   ワークスペース内のファイルへ写せればプロジェクト内、写せなければプロジェクト外とする
 *   (node_modules を探索しないのは、プロジェクト外である事さえ分かればよいため)
 * - 相対指定で見つからないものはプロジェクト内の未解決 (生成物・削除済み) とし、プロジェクト外にしない
 */
export class ModuleResolver {
    private readonly _workspaceFolder: string;
    private readonly _host: ModuleResolverHost;

    /** ディレクトリ → 最寄りの設定 (無ければ null) */
    private readonly _configs = new Map<string, ResolverConfig | null>();

    public constructor(workspaceFolder: string, host: ModuleResolverHost = NODE_MODULE_RESOLVER_HOST) {
        this._workspaceFolder = path.resolve(workspaceFolder);
        this._host = host;
    }

    /**
     * モジュール指定子を解決する
     * @param fromRelativePath import しているファイルのワークスペース相対パス
     * @param moduleSpec モジュール指定子 (引用符なし)
     * @returns 解決結果
     */
    public resolve(fromRelativePath: string, moduleSpec: string): ModuleResolution {
        const fromDirectory = path.dirname(path.resolve(this._workspaceFolder, fromRelativePath));

        // 相対指定・絶対パス
        if (moduleSpec === '.' || moduleSpec === '..' || moduleSpec.startsWith('./') || moduleSpec.startsWith('../') || path.isAbsolute(moduleSpec)) {
            const found = this.probe(path.resolve(fromDirectory, moduleSpec));
            return found ? this.toResolution(found) : { resolvedPath: null, isExternal: false };
        }

        // 組込みモジュール
        if (moduleSpec.startsWith('node:')) {
            return { resolvedPath: null, isExternal: true };
        }

        // tsconfig の paths / baseUrl で写せる非相対指定はプロジェクト内
        const config = this.configFor(fromDirectory);
        if (config) {
            for (const [pattern, targets] of config.paths) {
                const captured = matchPattern(pattern, moduleSpec);
                if (captured === null || !config.pathsBase) {
                    continue;
                }
                for (const target of targets) {
                    const found = this.probe(path.resolve(config.pathsBase, target.replace('*', captured)));
                    if (found) {
                        return this.toResolution(found);
                    }
                }
            }
            if (config.baseUrl) {
                const found = this.probe(path.resolve(config.baseUrl, moduleSpec));
                if (found) {
                    return this.toResolution(found);
                }
            }
        }
        return { resolvedPath: null, isExternal: true };
    }

    /**
     * 拡張子・index.* を補ってファイルを探す
     * @param candidate 指定子を絶対パスにしたもの
     * @returns 見つかったファイルの絶対パス。無ければ null
     */
    private probe(candidate: string): string | null {
        const extension = path.extname(candidate);
        if (LOADABLE.has(extension) && this._host.fileExists(candidate)) {
            return candidate;
        }
        for (const source of EMITTED_TO_SOURCE[extension] ?? []) {
            const found = candidate.slice(0, -extension.length) + source;
            if (this._host.fileExists(found)) {
                return found;
            }
        }
        for (const added of EXTENSIONS) {
            if (this._host.fileExists(candidate + added)) {
                return candidate + added;
            }
        }
        for (const added of EXTENSIONS) {
            const index = path.join(candidate, `index${added}`);
            if (this._host.fileExists(index)) {
                return index;
            }
        }
        return null;
    }

    /** 見つかったファイルを結果にする (ワークスペース外ならプロジェクト外) */
    private toResolution(absolutePath: string): ModuleResolution {
        const relative = path.relative(this._workspaceFolder, absolutePath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
            return { resolvedPath: null, isExternal: true };
        }
        return { resolvedPath: relative, isExternal: false };
    }

    /**
     * ディレクトリから最寄りの設定を探す (ワークスペースのルートまで遡る)
     * @param directory 絶対パス
     * @returns 設定。無ければ null
     */
    private configFor(directory: string): ResolverConfig | null {
        const cached = this._configs.get(directory);
        if (cached !== undefined) {
            return cached;
        }
        let found: ResolverConfig | null = null;
        for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const file = path.join(directory, name);
            if (this._host.fileExists(file)) {
                found = this.loadConfig(file, 0);
                break;
            }
        }
        const parent = path.dirname(directory);
        const inside = !path.relative(this._workspaceFolder, directory).startsWith('..');
        if (!found && inside && directory !== this._workspaceFolder && parent !== directory) {
            found = this.configFor(parent);
        }
        this._configs.set(directory, found);
        return found;
    }

    /**
     * 設定ファイルを読む (相対パスの extends を辿り、子の設定で上書きする)
     * @param file 設定ファイルの絶対パス
     * @param depth extends の深さ
     * @returns 設定。読めなければ null
     */
    private loadConfig(file: string, depth: number): ResolverConfig | null {
        const text = this._host.readFile(file);
        const json = text === undefined ? null : parseJsonc(text) as { extends?: unknown, compilerOptions?: { baseUrl?: unknown, paths?: unknown } } | null;
        if (!json || typeof json !== 'object') {
            return null;
        }
        const directory = path.dirname(file);

        // 相対パスの extends を先に読み、子で上書きする (パッケージ名の extends は辿らない)
        let base: ResolverConfig | null = null;
        const parents = typeof json.extends === 'string' ? [json.extends] : Array.isArray(json.extends) ? json.extends : [];
        for (const parent of parents) {
            if (typeof parent === 'string' && parent.startsWith('.') && depth < MAX_EXTENDS_DEPTH) {
                const parentFile = path.resolve(directory, parent.endsWith('.json') ? parent : `${parent}.json`);
                base = this.loadConfig(parentFile, depth + 1) ?? base;
            }
        }

        const options = json.compilerOptions ?? {};
        const baseUrl = typeof options.baseUrl === 'string' ? path.resolve(directory, options.baseUrl) : (base?.baseUrl ?? null);
        const ownPaths = (options.paths && typeof options.paths === 'object')
            ? Object.entries(options.paths as Record<string, unknown>)
                .map(([pattern, targets]) => [pattern, Array.isArray(targets) ? targets.filter((target): target is string => typeof target === 'string') : []] as [string, string[]])
            : null;
        const paths = ownPaths ?? base?.paths ?? [];
        const pathsBase = baseUrl ?? (ownPaths ? directory : (base?.pathsBase ?? null));
        return { baseUrl: baseUrl, paths: paths, pathsBase: pathsBase };
    }
}

/**
 * paths のパターン (`*` を1つまで含む) に指定子を当てる
 * @param pattern パターン
 * @param moduleSpec 指定子
 * @returns `*` に当たった部分文字列 (`*` 無しの完全一致なら空文字列)。当たらなければ null
 */
function matchPattern(pattern: string, moduleSpec: string): string | null {
    const star = pattern.indexOf('*');
    if (star < 0) {
        return pattern === moduleSpec ? '' : null;
    }
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (moduleSpec.length >= prefix.length + suffix.length && moduleSpec.startsWith(prefix) && moduleSpec.endsWith(suffix)) {
        return moduleSpec.slice(prefix.length, moduleSpec.length - suffix.length);
    }
    return null;
}
