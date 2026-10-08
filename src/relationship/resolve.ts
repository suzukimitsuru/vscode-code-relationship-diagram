/**
 * @file Phase B: 名前解決 (docs/ast-plan.md §7)
 * Stage 2 = 段1 ファイル内の定義 + 段2 import、Stage 3 = 段3 型推論 + 段4 一意名 + 段4' 曖昧候補
 */
import type * as codeDb from '../codeDb';
import {
    AstDefinition, AstImport, AstOccurrence, ELEMENT_MEMBER, FACTS_VERSION, ModuleResolution,
    RELATIONSHIP_WEIGHTS, RelationshipKind, fileFqn,
} from '../extruct/ast';

/**
 * 名前解決の版数
 * @description 解決規則を変えたら上げる。DB の resolved_version がこれと異なるファイルは、事実が同じでも解決し直す
 */
export const RESOLVE_VERSION = 2;

/** 解決段階ごとの確信度 (docs/ast-plan.md §7.1) */
export const CONFIDENCE = {
    /** 段1: ファイル内の定義 */
    local: 1.0,
    /** 段2: import 束縛 */
    import: 0.95,
    /** 段3: 型を推論して引いたメンバ (this・型注釈・new・戻り値・要素の型) */
    inferred: 0.8,
    /** 段4: プロジェクト全体で名前が一意 */
    unique: 0.6,
    /** 段4': 候補が複数 (N 個なら各 ambiguous / N) */
    ambiguous: 0.5,
    /** 段2: import 先のファイルまでは分かるが、export 名の定義が見つからない (export default の無名関数など) */
    module: 0.5,
} as const;

/** 段4' で関係にする候補の数の上限 (これを超える名前は破棄して数える) */
export const MAX_AMBIGUOUS_CANDIDATES = 4;

/** 再エクスポート (export ... from) を辿る深さの上限 (循環を避ける) */
const MAX_REEXPORT_DEPTH = 3;

/** 型を辿る深さの上限 (型注釈 → 戻り値 → 継承 … の循環を避ける) */
const MAX_TYPE_DEPTH = 8;

/**
 * 組込みのグローバルな名前 (段4 の候補にしない)
 * @description 同じ名前の定義がプロジェクトにあっても、ファイル内に束縛が無ければ組込みを指している
 */
const BUILTIN_GLOBALS: ReadonlySet<string> = new Set([
    'console', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object', 'JSON', 'Math', 'Date', 'Error', 'TypeError',
    'RangeError', 'SyntaxError', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'RegExp', 'Proxy', 'Reflect', 'Intl',
    'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
    'queueMicrotask', 'structuredClone', 'process', 'Buffer', 'require', 'module', 'exports', '__dirname', '__filename',
    'globalThis', 'window', 'document', 'navigator', 'undefined', 'NaN', 'Infinity', 'arguments', 'performance', 'URL',
    'URLSearchParams', 'TextEncoder', 'TextDecoder', 'fetch', 'Response', 'Request', 'Headers', 'AbortController',
    'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
    'Float32Array', 'Float64Array', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'atob', 'btoa',
    'requestAnimationFrame', 'cancelAnimationFrame',
]);

/**
 * 組込みの型によくあるメンバの名前 (段4 のメンバ名の候補にしない)
 * @description 型の分からない値の `xs.map()` を、プロジェクトに1つだけある `map` メソッドへ結び付けない
 */
const BUILTIN_MEMBERS: ReadonlySet<string> = new Set([
    'length', 'size', 'push', 'pop', 'shift', 'unshift', 'slice', 'splice', 'concat', 'join', 'reverse', 'sort', 'indexOf',
    'lastIndexOf', 'includes', 'find', 'findIndex', 'findLast', 'filter', 'map', 'forEach', 'reduce', 'some', 'every', 'flat',
    'flatMap', 'fill', 'keys', 'values', 'entries', 'get', 'set', 'has', 'add', 'delete', 'clear', 'then', 'catch', 'finally',
    'toString', 'toFixed', 'valueOf', 'split', 'trim', 'replace', 'match', 'startsWith', 'endsWith', 'padStart', 'padEnd',
    'toLowerCase', 'toUpperCase', 'charAt', 'substring', 'test', 'exec', 'apply', 'call', 'bind', 'log', 'error', 'warn',
    'info', 'debug', 'message', 'name', 'stack', 'getTime', 'toISOString', 'next', 'done', 'value', 'dispose', 'equals',
    'parse', 'stringify', 'max', 'min', 'floor', 'ceil', 'round', 'abs', 'sqrt', 'now', 'id', 'type', 'text', 'kind',
]);

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

/** 解決の段ごと・関係にしなかった理由ごとの参照出現の件数 */
export interface ResolutionStats {
    /** 段1: ファイル内の定義へ解決した参照出現 */
    local: number;
    /** 段2: import 先の定義・モジュールへ解決した参照出現 */
    imported: number;
    /** 段3: 型を推論してメンバを引いた参照出現 (this を含む) */
    inferred: number;
    /** 段4: プロジェクト全体で一意な名前へ解決した参照出現 */
    unique: number;
    /** 段4': 複数の候補へ弱い関係を出した参照出現 */
    ambiguous: number;
    /** 段4': 候補が多すぎて破棄した参照出現 */
    ambiguousDropped: number;
    /** 段2 のうち、export 名の定義が見つからずモジュール単位で解決したもの */
    module: number;
    /** import 文そのものの関係 (ファイル → 取り込んだ定義・モジュール) */
    importEdges: number;
    /** 自分自身・自分の内側の定義への参照 (関係にしない) */
    self: number;
    /** 型の分からないローカルな値のメンバ (関係にしない) */
    localBinding: number;
    /** this / super のメンバで、クラスかメンバが見つからないもの */
    thisOrSuper: number;
    /** ファイル内に束縛が無く、段4 の候補も無い名前 (グローバル・組込み) */
    unbound: number;
    /** オブジェクトリテラルのキー (文脈の型のプロパティへの参照。名前では解決しない) */
    objectKey: number;
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
    occurrences(path: string): Promise<readonly AstOccurrence[]>;
    definitionsNamed(name: string): Promise<readonly { path: string, definition: AstDefinition }[]>;
}

/** 関係の端 (モジュール = ファイル全体、または定義) */
type Target =
    { readonly kind: 'module', readonly path: string } |
    { readonly kind: 'definition', readonly path: string, readonly fqn: string };

/** 名前を辿る途中の値 (関係の端に加え、型の分かったインスタンス) */
type Value = Target | { readonly kind: 'instance', readonly path: string, readonly fqn: string };

/** 型 (クラス・インターフェース・型エイリアスの定義と、配列か) */
interface TypeOf {
    readonly path: string;
    readonly fqn: string;
    readonly array: boolean;
}

/** 参照出現と型の手掛かりに共通する、名前の連鎖 */
interface NameChain {
    readonly rootName: string;
    readonly memberPath: string | null;
    readonly scopeId: number | null;
    readonly bindingFqn: string | null;
}

/** 名前の連鎖を辿った結果 */
interface Walked {
    /** 辿れた所までの関係の端 (this だけのように端が無ければ null) */
    readonly target: Target | null;
    /** 途中で通過した定義 */
    readonly passed: readonly Target[];
    /** 解決の段 (1 / 2。this / super の根は 3) */
    readonly stage: 1 | 2 | 3;
    /** 型を推論してメンバを引いたか */
    readonly inferred: boolean;
    /** export 名の定義が見つからずモジュールで代用したか */
    readonly fallback: boolean;
    /** 辿れなかった最初のメンバ (型が分からなかった場合のみ。段4 のメンバ名の候補にする) */
    readonly unknownMember: string | null;
    /** メンバの経路を最後まで辿れたか */
    readonly complete: boolean;

    /** 辿り着いた値がインスタンス (`this`・`xs[i]`) なら、その型 */
    readonly instance: TypeOf | null;
}

/** 根が解決できなかった理由 */
type Unrooted = 'external' | 'unresolvedImport' | 'thisOrSuper' | 'unbound' | 'local';

/** 空の統計 */
export function emptyResolutionStats(): ResolutionStats {
    return {
        local: 0, imported: 0, inferred: 0, unique: 0, ambiguous: 0, ambiguousDropped: 0, module: 0, importEdges: 0,
        self: 0, localBinding: 0, thisOrSuper: 0, unbound: 0, objectKey: 0, external: 0, unresolvedImport: 0,
    };
}

/** 統計を足し合わせる */
export function addResolutionStats(total: ResolutionStats, stats: ResolutionStats): void {
    for (const key of Object.keys(total) as (keyof ResolutionStats)[]) {
        total[key] += stats[key];
    }
}

/** 関係の端の完全修飾名 (モジュールはファイルの完全修飾名) */
const fqnOf = (target: Target): string => target.kind === 'module' ? fileFqn(target.path) : target.fqn;

/** 型として扱う定義の種別 (メンバ表を持つ) */
const TYPE_KINDS: ReadonlySet<string> = new Set(['class', 'interface', 'type', 'enum', 'module']);

/** メンバの定義の種別 (段4 のメンバ名の候補) */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'enum_member']);

/**
 * 1回の解決の間の文脈 (他ファイルの事実と、推論した型の覚え書き)
 * @description 同じ lookup を使う間は覚え書きを共有する
 */
class ResolutionContext {
    private readonly _lookup: ResolutionLookup;
    private readonly _definitionMaps = new Map<string, Promise<Map<string, AstDefinition>>>();
    private readonly _types = new Map<string, Promise<TypeOf | null>>();
    private readonly _bases = new Map<string, Promise<TypeOf[]>>();
    private readonly _scripts = new Map<string, Promise<boolean>>();

    public constructor(lookup: ResolutionLookup) {
        this._lookup = lookup;
    }

    /** ファイルの定義 (完全修飾名 → 定義) */
    public definitionMap(path: string): Promise<Map<string, AstDefinition>> {
        let found = this._definitionMaps.get(path);
        if (!found) {
            found = this._lookup.definitions(path).then(definitions => new Map(definitions.map(definition => [definition.fqn, definition])));
            this._definitionMaps.set(path, found);
        }
        return found;
    }

    /**
     * export 名から関係の端を引く (再エクスポートを辿る)
     * @param path export しているファイル
     * @param name export 名 ('default' を含む)
     * @param depth 再エクスポートを辿った深さ
     */
    public async exportOf(path: string, name: string, depth: number = 0): Promise<Target | null> {
        const definition = (await this._lookup.definitions(path)).find(entry => entry.exportName === name);
        if (definition) {
            return { kind: 'definition', path: path, fqn: definition.fqn };
        }
        if (depth >= MAX_REEXPORT_DEPTH) {
            return null;
        }
        const reexports = (await this._lookup.imports(path)).filter(entry => entry.exportName !== null && entry.resolvedPath !== null);
        // export { a as name } from / export * as name from
        for (const entry of reexports.filter(entry => entry.exportName === name)) {
            const found = entry.importedName === '*'
                ? { kind: 'module', path: entry.resolvedPath as string } as const
                : await this.exportOf(entry.resolvedPath as string, entry.importedName ?? 'default', depth + 1);
            if (found) {
                return found;
            }
        }
        // export * from (default は含まない)
        if (name !== 'default') {
            for (const entry of reexports.filter(entry => entry.exportName === '*')) {
                const found = await this.exportOf(entry.resolvedPath as string, name, depth + 1);
                if (found) {
                    return found;
                }
            }
        }
        return null;
    }

    /**
     * import 束縛の関係の端 (import 先ファイルの export)
     * @returns 関係の端と、export 名の定義が見つからずモジュールで代用したか
     */
    public async importTargetOf(entry: AstImport & ModuleResolution): Promise<{ target: Target, fallback: boolean }> {
        const path = entry.resolvedPath as string;
        if (entry.importedName === null || entry.importedName === '*') {
            return { target: { kind: 'module', path: path }, fallback: false };
        }
        const found = await this.exportOf(path, entry.importedName);
        return found ? { target: found, fallback: false } : { target: { kind: 'module', path: path }, fallback: true };
    }

    /**
     * 完全修飾名から最も近い外側のクラスを引く (this の型)
     * @param path ファイル
     * @param fqn 参照出現を囲む定義などの完全修飾名
     */
    public async enclosingClassOf(path: string, fqn: string): Promise<TypeOf | null> {
        const definitions = await this.definitionMap(path);
        for (let current = definitions.get(fqn); current; current = definitions.get(current.parentFqn)) {
            if (current.kind === 'class') {
                return { path: path, fqn: current.fqn, array: false };
            }
        }
        return null;
    }

    /**
     * 型の継承元 (extends / implements の参照出現を解決する)
     * @param type クラス・インターフェース
     */
    public basesOf(type: TypeOf, depth: number): Promise<TypeOf[]> {
        const key = JSON.stringify([type.path, type.fqn]);
        let found = this._bases.get(key);
        if (!found) {
            found = (async () => {
                const bases: TypeOf[] = [];
                const heritages = (await this._lookup.occurrences(type.path)).filter(occurrence => occurrence.enclosingFqn === type.fqn &&
                    (occurrence.kind === RelationshipKind.inheritance || occurrence.kind === RelationshipKind.implementation));
                for (const heritage of heritages) {
                    const walked = await this.walk(type.path, heritage, heritage.enclosingFqn, depth + 1);
                    if (typeof walked !== 'string' && walked.target?.kind === 'definition') {
                        bases.push({ path: walked.target.path, fqn: walked.target.fqn, array: false });
                    }
                }
                return bases;
            })();
            this._bases.set(key, found);
        }
        return found;
    }

    /**
     * 型のメンバを引く (継承元も辿る)
     * @param type クラス・インターフェース・型エイリアス
     * @param member メンバ名
     */
    public async memberOf(type: TypeOf, member: string, depth: number, visited: Set<string> = new Set()): Promise<Target | null> {
        const key = JSON.stringify([type.path, type.fqn]);
        if (depth > MAX_TYPE_DEPTH || visited.has(key)) {
            return null;
        }
        visited.add(key);
        const fqn = `${type.fqn}.${member}`;
        if ((await this.definitionMap(type.path)).has(fqn)) {
            return { kind: 'definition', path: type.path, fqn: fqn };
        }
        for (const base of await this.basesOf(type, depth)) {
            const found = await this.memberOf(base, member, depth + 1, visited);
            if (found) {
                return found;
            }
        }
        return null;
    }

    /**
     * 定義の値の型 (関数・メソッドは戻り値の型)
     * @param path 定義のファイル
     * @param definition 定義
     */
    public typeOf(path: string, definition: AstDefinition, depth: number): Promise<TypeOf | null> {
        const key = JSON.stringify([path, definition.fqn]);
        let found = this._types.get(key);
        if (!found) {
            found = this._typeOf(path, definition, depth);
            this._types.set(key, found);
        }
        return found;
    }

    private async _typeOf(path: string, definition: AstDefinition, depth: number): Promise<TypeOf | null> {
        if (TYPE_KINDS.has(definition.kind)) {
            return { path: path, fqn: definition.fqn, array: false };
        }
        const type = definition.type;
        if (!type || depth > MAX_TYPE_DEPTH) {
            return null;
        }
        const walked = await this.walk(path, type, definition.parentFqn, depth + 1);
        if (typeof walked === 'string') {
            return null;
        }
        // const x = xs[i] / const { b } = this のように、インスタンスに辿り着いた値はその型
        if (walked.instance && walked.complete) {
            return type.mode === 'value' || type.mode === 'annotation' ? walked.instance : null;
        }
        if (walked.target?.kind !== 'definition') {
            return null;
        }
        const target = walked.target;
        const resolved = (await this.definitionMap(target.path)).get(target.fqn);
        if (!resolved) {
            return null;
        }
        switch (type.mode) {
            case 'annotation':
            case 'new':
                return { path: target.path, fqn: target.fqn, array: type.array };
            case 'call':
            case 'value':
                return this.typeOf(target.path, resolved, depth + 1);
            case 'element': {
                const iterable = await this.typeOf(target.path, resolved, depth + 1);
                return iterable?.array ? { ...iterable, array: false } : null;
            }
        }
    }

    /**
     * 名前の連鎖を辿る (段1・段2 で根を引き、メンバは入れ子の定義・型のメンバとして引く)
     * @param path 名前が現れたファイル
     * @param chain 名前の連鎖
     * @param enclosingFqn 名前を囲む定義 (this の型を引くため)
     * @returns 辿った結果。根が引けなければその理由
     */
    public async walk(path: string, chain: NameChain, enclosingFqn: string, depth: number): Promise<Walked | Unrooted> {
        let value: Value;
        let stage: 1 | 2 | 3;
        let fallback = false;
        let inferred = false;
        if (chain.rootName === 'this' || chain.rootName === 'super') {
            const owner = await this.enclosingClassOf(path, enclosingFqn);
            const type = owner && chain.rootName === 'super' ? (await this.basesOf(owner, depth))[0] ?? null : owner;
            if (!type) {
                return 'thisOrSuper';
            }
            value = { kind: 'instance', path: type.path, fqn: type.fqn };
            stage = 3;
            inferred = true;
        } else if (chain.bindingFqn !== null) {
            value = { kind: 'definition', path: path, fqn: chain.bindingFqn };
            stage = 1;
        } else if (chain.scopeId === 0) {
            const entry = (await this._lookup.imports(path)).find(candidate => candidate.localName === chain.rootName);
            if (!entry) {
                return 'unbound';
            }
            if (entry.isExternal) {
                return 'external';
            }
            if (entry.resolvedPath === null) {
                return 'unresolvedImport';
            }
            const imported = await this.importTargetOf(entry);
            value = imported.target;
            fallback = imported.fallback;
            stage = 2;
        } else {
            return chain.scopeId === null ? 'unbound' : 'local';
        }
        return this.walkMembers(value, chain.memberPath, { stage, inferred, fallback }, depth);
    }

    /**
     * メンバの経路を辿る
     * @param start 根の値
     * @param memberPath メンバの経路 (`B.c`)
     */
    public async walkMembers(start: Value, memberPath: string | null,
        state: { stage: 1 | 2 | 3, inferred: boolean, fallback: boolean }, depth: number): Promise<Walked> {
        let value = start;
        let inferred = state.inferred;
        let unknownMember: string | null = null;
        let complete = true;
        const passed: Target[] = [];
        const members = memberPath ? memberPath.split('.') : [];
        for (const [index, member] of members.entries()) {
            let next: Value | null = null;
            if (member === ELEMENT_MEMBER) {
                // xs[i] は配列の要素の型のインスタンス (型が分からなければ、その次のメンバを段4 の候補にする)
                const definition = value.kind === 'definition' ? (await this.definitionMap(value.path)).get(value.fqn) : undefined;
                const type = definition ? await this.typeOf(value.path, definition, depth) : null;
                if (type?.array) {
                    next = { kind: 'instance', path: type.path, fqn: type.fqn };
                    inferred = true;
                } else if (definition && !type) {
                    unknownMember = members.slice(index + 1).find(rest => rest !== ELEMENT_MEMBER) ?? null;
                }
            } else if (value.kind === 'module') {
                next = await this.exportOf(value.path, member);
            } else if (value.kind === 'instance') {
                next = await this.memberOf({ path: value.path, fqn: value.fqn, array: false }, member, depth);
            } else {
                // 入れ子の定義 (名前空間・静的メンバ・列挙子) を先に引き、無ければ値の型のメンバを引く
                const definitions = await this.definitionMap(value.path);
                const nested = `${value.fqn}.${member}`;
                const definition = definitions.get(value.fqn);
                if (definitions.has(nested)) {
                    next = { kind: 'definition', path: value.path, fqn: nested };
                } else if (definition) {
                    const type = await this.typeOf(value.path, definition, depth);
                    if (type && !type.array) {
                        next = await this.memberOf(type, member, depth);
                        inferred = inferred || next !== null;
                    } else if (!type) {
                        unknownMember = member;
                    }
                }
            }
            if (!next) {
                complete = false;
                break;
            }
            // 通過した定義も参照している (名前空間・モジュールは関係にしない)
            if (value.kind === 'definition') {
                passed.push(value);
            }
            value = next;
        }
        return {
            target: value.kind === 'instance' ? null : value,
            passed: passed, stage: state.stage, inferred: inferred, fallback: state.fallback, unknownMember: unknownMember, complete: complete,
            instance: value.kind === 'instance' ? { path: value.path, fqn: value.fqn, array: false } : null,
        };
    }

    /**
     * スクリプト (import / export の無いファイル) か宣言ファイルか (トップレベルの定義がグローバルになる)
     * @param path ファイル
     */
    public isGlobalScope(path: string): Promise<boolean> {
        let found = this._scripts.get(path);
        if (!found) {
            found = (async () => path.endsWith('.d.ts') || (
                (await this._lookup.imports(path)).length === 0 &&
                !(await this._lookup.definitions(path)).some(definition => definition.exportName !== null)))();
            this._scripts.set(path, found);
        }
        return found;
    }
}

/** lookup ごとの解決の文脈 (同じ lookup で解決する間は推論した型を使い回す) */
const contexts = new WeakMap<ResolutionLookup, ResolutionContext>();

/**
 * 1ファイルの参照出現と import を解決する
 * @param input 1ファイルの事実
 * @param lookup 他ファイル (自ファイルを含む) の事実。DB に保存済みの事実を引く
 * @returns 関係と統計
 * @description
 * - 段1: 根の名前をファイル内の定義が束縛していれば (binding_fqn)、その定義から辿る
 * - 段2: モジュールスコープの import 束縛なら、import 先の export (再エクスポートを辿る) から辿る
 * - 段3: メンバは入れ子の定義 (名前空間・静的メンバ) を先に引き、無ければ値の型 (型注釈・new・戻り値・要素) の
 *        メンバを継承元まで引く。this / super は囲むクラスとその継承元のメンバを引く
 * - 段4 / 4': 型の分からない値のメンバ、ファイル内に束縛の無い名前は、プロジェクト全体の同名の定義へ弱い関係を出す
 *        (組込みによくある名前は除く。束縛の無い名前は、スクリプトと宣言ファイルのトップレベルの定義だけを候補にする)
 * - 途中で通過した定義 (`Cls.create()` の `Cls`) にも読み取りの関係を出す。`new X()` は X のコンストラクタも参照する
 * - import 文そのものも「ファイル → 取り込んだ定義・モジュール」の import 関係にする
 */
export async function resolveFile(input: ResolutionInput, lookup: ResolutionLookup): Promise<{ relationships: RelationshipV2[], stats: ResolutionStats }> {
    let found = contexts.get(lookup);
    if (!found) {
        found = new ResolutionContext(lookup);
        contexts.set(lookup, found);
    }
    const context = found;
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
    const membersNamed = async (member: string): Promise<{ path: string, definition: AstDefinition }[]> =>
        BUILTIN_MEMBERS.has(member) ? [] :
            (await lookup.definitionsNamed(member)).filter(candidate => MEMBER_KINDS.has(candidate.definition.kind));
    const globalsNamed = async (name: string): Promise<{ path: string, definition: AstDefinition }[]> => {
        if (BUILTIN_GLOBALS.has(name)) {
            return [];
        }
        const globals: { path: string, definition: AstDefinition }[] = [];
        for (const candidate of await lookup.definitionsNamed(name)) {
            if (candidate.path !== input.path && candidate.definition.parentFqn === fileFqn(candidate.path) &&
                await context.isGlobalScope(candidate.path)) {
                globals.push(candidate);
            }
        }
        return globals;
    };
    const restAfter = (memberPath: string | null, member: string): string | null => {
        const segments = memberPath ? memberPath.split('.') : [];
        const rest = segments.slice(segments.indexOf(member) + 1);
        return rest.length > 0 ? rest.join('.') : null;
    };

    for (const occurrence of input.occurrences) {
        if (occurrence.kind === RelationshipKind.object_key) {
            stats.objectKey++;
            continue;
        }
        const isSelf = (target: Target): boolean => {
            const fqn = fqnOf(target);
            return fqn === occurrence.enclosingFqn || fqn.startsWith(`${occurrence.enclosingFqn}.`);
        };
        const emit = async (walked: Walked, confidence: number): Promise<boolean> => {
            const target = walked.target;
            if (!target || isSelf(target)) {
                return false;
            }
            push(occurrence.enclosingFqn, target, occurrence.kind, confidence, occurrence.line);
            for (const through of walked.passed.filter(candidate => !isSelf(candidate))) {
                push(occurrence.enclosingFqn, through, RelationshipKind.read, confidence, occurrence.line);
            }
            // new X() は X のコンストラクタも参照する
            if (occurrence.kind === RelationshipKind.instantiation && target.kind === 'definition') {
                const constructor = `${target.fqn}.constructor`;
                if ((await context.definitionMap(target.path)).has(constructor)) {
                    push(occurrence.enclosingFqn, { kind: 'definition', path: target.path, fqn: constructor }, occurrence.kind, confidence, occurrence.line);
                }
            }
            return true;
        };
        // 段4 / 4': 同名の定義が N 個なら、N = 1 は一意、N ≤ 上限は曖昧候補として各 1/N、それ以上は破棄
        const byName = async (candidates: readonly { path: string, definition: AstDefinition }[], rest: string | null): Promise<boolean> => {
            if (candidates.length === 0) {
                return false;
            }
            if (candidates.length > MAX_AMBIGUOUS_CANDIDATES) {
                stats.ambiguousDropped++;
                return true;
            }
            const confidence = candidates.length === 1 ? CONFIDENCE.unique : CONFIDENCE.ambiguous / candidates.length;
            let emitted = false;
            for (const candidate of candidates) {
                const walked = await context.walkMembers({ kind: 'definition', path: candidate.path, fqn: candidate.definition.fqn }, rest,
                    { stage: 1, inferred: false, fallback: false }, 0);
                emitted = (await emit(walked, confidence)) || emitted;
            }
            if (!emitted) {
                return false;
            }
            if (candidates.length === 1) {
                stats.unique++;
            } else {
                stats.ambiguous++;
            }
            return true;
        };

        const walked = await context.walk(input.path, occurrence, occurrence.enclosingFqn, 0);
        if (typeof walked === 'string') {
            if (walked === 'external' || walked === 'unresolvedImport') {
                stats[walked]++;
            } else if (walked === 'thisOrSuper') {
                stats.thisOrSuper++;
            } else if (walked === 'local') {
                // 型の分からないローカルな値 (分割代入の変数など) のメンバは、段4 のメンバ名で引く
                const first = occurrence.memberPath?.split('.').find(member => member !== ELEMENT_MEMBER) ?? null;
                if (!first || !(await byName(await membersNamed(first), restAfter(occurrence.memberPath, first)))) {
                    stats.localBinding++;
                }
            } else if (!(await byName(await globalsNamed(occurrence.rootName), occurrence.memberPath))) {
                stats.unbound++;
            }
            continue;
        }

        const confidence = walked.inferred ? CONFIDENCE.inferred
            : walked.fallback ? CONFIDENCE.module
            : walked.stage === 1 ? CONFIDENCE.local : CONFIDENCE.import;
        if (await emit(walked, confidence)) {
            if (walked.inferred) {
                stats.inferred++;
            } else if (walked.stage === 1) {
                stats.local++;
            } else {
                stats.imported++;
                if (walked.fallback) {
                    stats.module++;
                }
            }
        } else if (walked.unknownMember !== null &&
            await byName(await membersNamed(walked.unknownMember), restAfter(occurrence.memberPath, walked.unknownMember))) {
            // 型の分からない値のメンバを段4 で引いた
        } else if (walked.target === null) {
            stats.thisOrSuper++;
        } else if (!walked.complete) {
            // 自分の引数・ローカル変数のメンバで、型が分からない (または型にメンバが無い)
            stats.localBinding++;
        } else {
            stats.self++;
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
            const { target, fallback } = await context.importTargetOf(entry);
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
    private readonly _occurrences = new Map<string, Promise<AstOccurrence[]>>();
    private readonly _named = new Map<string, Promise<{ path: string, definition: AstDefinition }[]>>();

    public constructor(db: codeDb.Db) {
        this._db = db;
    }

    private static _cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
        let found = cache.get(key);
        if (!found) {
            found = load();
            cache.set(key, found);
        }
        return found;
    }

    public definitions(path: string): Promise<AstDefinition[]> {
        return DbResolutionLookup._cached(this._definitions, path, () => this._db.definitions_query(path));
    }

    public imports(path: string): Promise<(AstImport & ModuleResolution)[]> {
        return DbResolutionLookup._cached(this._imports, path, () => this._db.imports_query(path));
    }

    public occurrences(path: string): Promise<AstOccurrence[]> {
        return DbResolutionLookup._cached(this._occurrences, path, () => this._db.occurrences_query(path));
    }

    public definitionsNamed(name: string): Promise<{ path: string, definition: AstDefinition }[]> {
        return DbResolutionLookup._cached(this._named, name, () => this._db.definitions_queryNamed(name));
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
            const resolved = await resolveFile({ path: path, imports: await lookup.imports(path), occurrences: await lookup.occurrences(path) }, lookup);
            relationships.push(...resolved.relationships);
            addResolutionStats(stats, resolved.stats);
        }
        await this._db.relationships_v2_replace(paths, relationships, RESOLVE_VERSION);
        return { relationships: relationships.length, stats: stats };
    }
}
