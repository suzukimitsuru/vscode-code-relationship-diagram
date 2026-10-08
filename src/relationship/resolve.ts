/** @file Phase B: 名前解決 (docs/ast-plan.md §7。Stage 2 = 段1 ファイル内の定義 + 段2 import) */
import type * as codeDb from '../codeDb';
import {
    AstDefinition, AstImport, AstOccurrence, FACTS_VERSION, ModuleResolution,
    RELATIONSHIP_WEIGHTS, RelationshipKind, fileFqn,
} from '../extruct/ast';

/**
 * 名前解決の版数
 * @description 解決規則を変えたら上げる。DB の resolved_version がこれと異なるファイルは、事実が同じでも解決し直す
 */
export const RESOLVE_VERSION = 1;

/** 解決段階ごとの確信度 (docs/ast-plan.md §7.1) */
export const CONFIDENCE = {
    /** 段1: ファイル内の定義 */
    local: 1.0,
    /** 段2: import 束縛 */
    import: 0.95,
    /** 段2: import 先のファイルまでは分かるが、export 名の定義が見つからない (export default の無名関数など) */
    module: 0.5,
} as const;

/** 再エクスポート (export ... from) を辿る深さの上限 (循環を避ける) */
const MAX_REEXPORT_DEPTH = 3;

/** 関係 (table_relationships_v2 の1行。1参照出現 = 1行) */
export interface RelationshipV2 {
    readonly referencePath: string;
    readonly referenceFqn: string;
    readonly definePath: string;
    readonly defineFqn: string;
    readonly kind: RelationshipKind;
    readonly weight: number;
    readonly confidence: number;
    readonly referenceLine: number;
    readonly isIntraFile: boolean;
}

/** 解決できなかった・関係にしなかった理由ごとの件数 */
export interface ResolutionStats {
    /** 段1: ファイル内の定義へ解決した参照出現 */
    local: number;
    /** 段2: import 先の定義・モジュールへ解決した参照出現 */
    imported: number;
    /** 段2 のうち、export 名の定義が見つからずモジュール単位で解決したもの */
    module: number;
    /** import 文そのものの関係 (ファイル → 取り込んだ定義・モジュール) */
    importEdges: number;
    /** 自分自身・自分の内側の定義への参照 (関係にしない) */
    self: number;
    /** 引数・分割代入の変数など定義でないローカル束縛 (関係にしない) */
    localBinding: number;
    /** this / super をレシーバとする参照 (Stage 3 の型推論で解決する) */
    thisOrSuper: number;
    /** ファイル内に束縛が無い名前 (グローバル・組込み。Stage 3 の段4/5) */
    unbound: number;
    /** プロジェクト外 (パッケージ・組込みモジュール) への import */
    external: number;
    /** import 先のファイルが解決できなかった */
    unresolvedImport: number;
}

/** 解決の入力 (1ファイルの事実) */
export interface ResolutionInput {
    readonly path: string;
    readonly imports: readonly (AstImport & ModuleResolution)[];
    readonly occurrences: readonly AstOccurrence[];
}

/** 他ファイルの事実の引き方 (DB から読む。単体テストではメモリ上で差し替える) */
export interface ResolutionLookup {
    definitions(path: string): Promise<readonly AstDefinition[]>;
    imports(path: string): Promise<readonly (AstImport & ModuleResolution)[]>;
}

/** 解決先 (モジュール = ファイル全体、または定義) */
type Target =
    { readonly kind: 'module', readonly path: string } |
    { readonly kind: 'definition', readonly path: string, readonly fqn: string };

/** 空の統計 */
export function emptyResolutionStats(): ResolutionStats {
    return { local: 0, imported: 0, module: 0, importEdges: 0, self: 0, localBinding: 0, thisOrSuper: 0, unbound: 0, external: 0, unresolvedImport: 0 };
}

/** 統計を足し合わせる */
export function addResolutionStats(total: ResolutionStats, stats: ResolutionStats): void {
    for (const key of Object.keys(total) as (keyof ResolutionStats)[]) {
        total[key] += stats[key];
    }
}

/**
 * export 名から解決先を引く (再エクスポートを辿る)
 * @param lookup 他ファイルの事実
 * @param path export しているファイル
 * @param name export 名 ('default' を含む)
 * @param depth 再エクスポートを辿った深さ
 * @returns 解決先。見つからなければ null
 */
async function exportOf(lookup: ResolutionLookup, path: string, name: string, depth: number = 0): Promise<Target | null> {
    const definition = (await lookup.definitions(path)).find(entry => entry.exportName === name);
    if (definition) {
        return { kind: 'definition', path: path, fqn: definition.fqn };
    }
    if (depth >= MAX_REEXPORT_DEPTH) {
        return null;
    }
    const reexports = (await lookup.imports(path)).filter(entry => entry.exportName !== null && entry.resolvedPath !== null);
    // export { a as name } from / export * as name from
    for (const entry of reexports.filter(entry => entry.exportName === name)) {
        const found = entry.importedName === '*'
            ? { kind: 'module', path: entry.resolvedPath as string } as const
            : await exportOf(lookup, entry.resolvedPath as string, entry.importedName ?? 'default', depth + 1);
        if (found) {
            return found;
        }
    }
    // export * from (default は含まない)
    if (name !== 'default') {
        for (const entry of reexports.filter(entry => entry.exportName === '*')) {
            const found = await exportOf(lookup, entry.resolvedPath as string, name, depth + 1);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

/**
 * メンバの経路を辿る (モジュールなら export 名、定義なら入れ子の定義として引く)
 * @param lookup 他ファイルの事実
 * @param target 根の解決先
 * @param memberPath メンバの経路 (`B.c`)
 * @returns 辿れた所までの解決先 (インスタンスのメンバのように定義が無ければ、その手前で止まる) と、
 *          途中で通過した定義 (`A.B.c()` の `A.B` が定義なら、`c` だけでなく `A.B` も参照している)
 */
async function memberOf(lookup: ResolutionLookup, target: Target, memberPath: string | null): Promise<{ target: Target, passed: Target[] }> {
    let current = target;
    const passed: Target[] = [];
    for (const member of memberPath ? memberPath.split('.') : []) {
        let next: Target | null;
        if (current.kind === 'module') {
            next = await exportOf(lookup, current.path, member);
        } else {
            const fqn = `${current.fqn}.${member}`;
            next = (await lookup.definitions(current.path)).some(entry => entry.fqn === fqn)
                ? { kind: 'definition', path: current.path, fqn: fqn } : null;
        }
        if (!next) {
            break;
        }
        if (current.kind === 'definition') {
            passed.push(current);
        }
        current = next;
    }
    return { target: current, passed: passed };
}

/** 解決先の完全修飾名 (モジュールはファイルの完全修飾名) */
const fqnOf = (target: Target): string => target.kind === 'module' ? fileFqn(target.path) : target.fqn;

/**
 * import 束縛の解決先 (import 先ファイルの export)
 * @returns 解決先と、export 名の定義が見つからずモジュールで代用したか
 */
async function importTargetOf(lookup: ResolutionLookup, entry: AstImport & ModuleResolution): Promise<{ target: Target, fallback: boolean }> {
    const path = entry.resolvedPath as string;
    if (entry.importedName === null || entry.importedName === '*') {
        return { target: { kind: 'module', path: path }, fallback: false };
    }
    const found = await exportOf(lookup, path, entry.importedName);
    return found ? { target: found, fallback: false } : { target: { kind: 'module', path: path }, fallback: true };
}

/**
 * 1ファイルの参照出現と import を解決する (Stage 2: 段1 + 段2)
 * @param input 1ファイルの事実
 * @param lookup 他ファイル (自ファイルを含む) の事実。DB に保存済みの事実を引く
 * @returns 関係と統計
 * @description
 * - 段1: 根の名前をファイル内の定義が束縛していれば (binding_fqn)、その定義とメンバを引く
 * - 段2: モジュールスコープの import 束縛なら、import 先の export (再エクスポートを辿る) とメンバを引く
 * - メンバの連鎖で途中に通過した定義 (`Cls.create()` の `Cls`) にも読み取りの関係を出す
 * - import 文そのものも「ファイル → 取り込んだ定義・モジュール」の import 関係にする
 * - this / super・ファイル内に束縛の無い名前は Stage 3 で扱う (ここでは件数だけ数える)
 */
export async function resolveFile(input: ResolutionInput, lookup: ResolutionLookup): Promise<{ relationships: RelationshipV2[], stats: ResolutionStats }> {
    const stats = emptyResolutionStats();
    const relationships: RelationshipV2[] = [];
    const push = (referenceFqn: string, target: Target, kind: RelationshipKind, confidence: number, line: number): void => {
        relationships.push({
            referencePath: input.path, referenceFqn: referenceFqn,
            definePath: target.path, defineFqn: fqnOf(target),
            kind: kind, weight: RELATIONSHIP_WEIGHTS[kind], confidence: confidence,
            referenceLine: line, isIntraFile: target.path === input.path,
        });
    };
    const importsByLocal = new Map<string, AstImport & ModuleResolution>();
    for (const entry of input.imports) {
        if (entry.localName !== null && !importsByLocal.has(entry.localName)) {
            importsByLocal.set(entry.localName, entry);
        }
    }

    for (const occurrence of input.occurrences) {
        if (occurrence.bindingFqn !== null) {
            // 段1: ファイル内の定義 (自分自身・自分の内側の定義への参照は依存ではない)
            const { target, passed } = await memberOf(lookup, { kind: 'definition', path: input.path, fqn: occurrence.bindingFqn }, occurrence.memberPath);
            const isSelf = (candidate: Target): boolean => {
                const fqn = fqnOf(candidate);
                return fqn === occurrence.enclosingFqn || fqn.startsWith(`${occurrence.enclosingFqn}.`);
            };
            if (isSelf(target)) {
                stats.self++;
            } else {
                push(occurrence.enclosingFqn, target, occurrence.kind, CONFIDENCE.local, occurrence.line);
                stats.local++;
            }
            for (const through of passed.filter(candidate => !isSelf(candidate))) {
                push(occurrence.enclosingFqn, through, RelationshipKind.read, CONFIDENCE.local, occurrence.line);
            }
        } else if (occurrence.scopeId === 0 && importsByLocal.has(occurrence.rootName)) {
            // 段2: import 束縛
            const entry = importsByLocal.get(occurrence.rootName) as AstImport & ModuleResolution;
            if (entry.isExternal) {
                stats.external++;
            } else if (entry.resolvedPath === null) {
                stats.unresolvedImport++;
            } else {
                const imported = await importTargetOf(lookup, entry);
                const { target, passed } = await memberOf(lookup, imported.target, occurrence.memberPath);
                const confidence = imported.fallback ? CONFIDENCE.module : CONFIDENCE.import;
                push(occurrence.enclosingFqn, target, occurrence.kind, confidence, occurrence.line);
                for (const through of passed) {
                    push(occurrence.enclosingFqn, through, RelationshipKind.read, confidence, occurrence.line);
                }
                stats.imported++;
                if (imported.fallback) {
                    stats.module++;
                }
            }
        } else if (occurrence.scopeId === null) {
            if (occurrence.rootName === 'this' || occurrence.rootName === 'super') {
                stats.thisOrSuper++;
            } else {
                stats.unbound++;
            }
        } else {
            stats.localBinding++;
        }
    }

    // import 文: ファイル → 取り込んだ定義・モジュール (再エクスポート・副作用 import を含む。自ファイルの別名 export は除く)
    for (const entry of input.imports) {
        if (entry.resolvedPath === input.path) {
            continue;
        } else if (entry.isExternal) {
            stats.external++;
        } else if (entry.resolvedPath === null) {
            stats.unresolvedImport++;
        } else {
            const { target, fallback } = await importTargetOf(lookup, entry);
            push(fileFqn(input.path), target, RelationshipKind.import, fallback ? CONFIDENCE.module : CONFIDENCE.import, entry.line);
            stats.importEdges++;
        }
    }
    return { relationships, stats };
}

/**
 * DB に保存済みの事実を引く (1回の解決の間だけキャッシュする)
 * @description 解決中に他ファイルの事実が書き換わらないよう、キューのコミットと同じ直列区間で使う事
 */
export class DbResolutionLookup implements ResolutionLookup {
    private readonly _db: codeDb.Db;
    private readonly _definitions = new Map<string, Promise<AstDefinition[]>>();
    private readonly _imports = new Map<string, Promise<(AstImport & ModuleResolution)[]>>();

    public constructor(db: codeDb.Db) {
        this._db = db;
    }

    public definitions(path: string): Promise<AstDefinition[]> {
        let found = this._definitions.get(path);
        if (!found) {
            found = this._db.definitions_query(path);
            this._definitions.set(path, found);
        }
        return found;
    }

    public imports(path: string): Promise<(AstImport & ModuleResolution)[]> {
        let found = this._imports.get(path);
        if (!found) {
            found = this._db.imports_query(path);
            this._imports.set(path, found);
        }
        return found;
    }
}

/**
 * 名前解決 (Phase B) を DB 上で行う
 * @description 名前解決が必要なファイル (事実が最新で resolved_version が古い) を集め、
 *              参照元ファイル単位で table_relationships_v2 を置き換える
 */
export class Resolver {
    private readonly _db: codeDb.Db;

    public constructor(db: codeDb.Db) {
        this._db = db;
    }

    /** 名前解決が必要なファイル */
    public pendingFiles(): Promise<string[]> {
        return this._db.resolution_pendingFiles(FACTS_VERSION, RESOLVE_VERSION);
    }

    /**
     * ファイル群を解決して保存する
     * @param paths 参照元ファイル
     * @returns 保存した関係の数と統計
     * @description 読み込みから保存までの間に他ファイルの事実が変わらないよう、キューのコミットと同じ直列区間で呼ぶ事
     */
    public async resolveFiles(paths: string[]): Promise<{ relationships: number, stats: ResolutionStats }> {
        const lookup = new DbResolutionLookup(this._db);
        const stats = emptyResolutionStats();
        const relationships: RelationshipV2[] = [];
        for (const path of paths) {
            const facts = await this._db.facts_query(path);
            const resolved = await resolveFile({ path: path, imports: facts.imports, occurrences: facts.occurrences }, lookup);
            relationships.push(...resolved.relationships);
            addResolutionStats(stats, resolved.stats);
        }
        await this._db.relationships_v2_replace(paths, relationships, RESOLVE_VERSION);
        return { relationships: relationships.length, stats: stats };
    }
}
