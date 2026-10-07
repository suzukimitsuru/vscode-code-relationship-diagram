/** @file Phase A: ローカル事実の抽出 (docs/ast-plan.md §6.3) */
import { AstNode, AstParser, AstQueryMatch } from './parser';
import { RelationshipKind, relationshipKindOf, relationshipKindRank } from './relationshipKind';

/**
 * 事実抽出の版数
 * @description クエリや抽出規則を変えたら上げる。DB の facts_version がこれと異なるファイルは、
 *              内容が変わっていなくても次の全走査で事実だけを抽出し直す
 */
export const FACTS_VERSION = 1;

/** 字句的な束縛を作らない定義の種別 (メンバは `a.m` のようにしか参照できない) */
const MEMBER_KINDS: ReadonlySet<string> = new Set(['method', 'property', 'enum_member']);

/** 定義 */
export interface AstDefinition {

    /** 完全修飾名 (`<path>#<入れ子の名前を . で連結>`。同じ親・同じ名前の2つ目以降は `~2`, `~3` …) */
    readonly fqn: string;

    /** 名前 */
    readonly name: string;

    /** 種別 (`def.<種別>` の <種別>) */
    readonly kind: string;

    /** 親の完全修飾名 (トップレベルならファイルの完全修飾名) */
    readonly parentFqn: string;

    /** export 名 (トップレベルで export されていなければ null。default export は 'default') */
    readonly exportName: string | null;

    /** 名前の開始行 (0起点。LSP の selectionRange.start と突き合わせる) */
    readonly nameLine: number;

    /** 名前の開始桁 (0起点・UTF-16) */
    readonly nameCharacter: number;

    /** 定義ノードの開始行 (0起点) */
    readonly startLine: number;

    /** 定義ノードの終了行 (0起点) */
    readonly endLine: number;
}

/** import 束縛 (再エクスポート・副作用 import を含む) */
export interface AstImport {

    /** ファイル内での束縛名 (再エクスポート・副作用 import では null) */
    readonly localName: string | null;

    /** 取り込む名前 ('*' = 名前空間全体、'default' = default export。副作用 import では null) */
    readonly importedName: string | null;

    /** 再エクスポートで公開する名前 ('*' = export * from。再エクスポートでなければ null) */
    readonly exportName: string | null;

    /** モジュール指定子 (引用符を除いた文字列) */
    readonly moduleSpec: string;

    /** 指定子の開始行 (0起点) */
    readonly line: number;

    /** 指定子の開始桁 (0起点・UTF-16) */
    readonly character: number;
}

/** 参照出現 */
export interface AstOccurrence {

    /** 開始行 (0起点) */
    readonly line: number;

    /** 開始桁 (0起点・UTF-16) */
    readonly character: number;

    /** 根の名前 (`a.b()` の 'a'。this / super をレシーバとする場合は 'this' / 'super') */
    readonly rootName: string;

    /** メンバの経路 (`a.b()` の 'b'。単純な識別子なら null) */
    readonly memberPath: string | null;

    /** 関係の種類 */
    readonly kind: RelationshipKind;

    /** 出現を囲む最内の定義の完全修飾名 (どの定義にも囲まれていなければファイルの完全修飾名) */
    readonly enclosingFqn: string;

    /**
     * 根の名前を束縛しているスコープ
     * @description 0 = モジュールスコープ (import またはトップレベルの定義)、
     *              1 以上 = ファイル内のローカルスコープ (文書順の番号)、
     *              null = ファイル内に束縛が無い (グローバル・組込み) か、根が this / super
     */
    readonly scopeId: number | null;
}

/** 1ファイルのローカル事実 */
export interface LocalFacts {
    readonly definitions: AstDefinition[];
    readonly imports: AstImport[];
    readonly occurrences: AstOccurrence[];

    /** 構文エラーを含むか (含んでも抽出はする。制御文字を含むファイルは tree-sitter が構文エラーにする) */
    readonly hasError: boolean;
}

/**
 * ファイルの完全修飾名 (モジュールスコープの参照元・トップレベル定義の親)
 * @param relativePath ワークスペース相対パス
 * @returns `<path>#`
 * @description 名前に '#' は現れないため、最後の '#' より前がパス、後ろが入れ子の名前になる
 */
export function fileFqn(relativePath: string): string {
    return `${relativePath}#`;
}

/** 開始・終了インデックス (UTF-16、終了は含まない) を持つ区間 */
interface Interval<T> {
    readonly start: number;
    readonly end: number;
    readonly value: T;
}

/**
 * 入れ子の区間 (構文木のノード範囲) から、位置を含む最内の区間を引く
 * @description 構文木のノード範囲は必ず入れ子か素であるため、開始位置の二分探索と
 *              親への遡りだけで最内の区間が求まる。1出現ごとに構文木の親を辿る
 *              (WASM 境界を越える) より十分に速い
 */
class NestedIntervals<T> {
    private readonly _items: Interval<T>[];
    private readonly _parents: number[];

    public constructor(items: Interval<T>[]) {
        this._items = [...items].sort((a, b) => (a.start - b.start) || (b.end - a.end));
        this._parents = [];
        const stack: number[] = [];
        this._items.forEach((item, index) => {
            while (stack.length > 0 && this._items[stack[stack.length - 1]].end <= item.start) {
                stack.pop();
            }
            this._parents.push(stack.length > 0 ? stack[stack.length - 1] : -1);
            stack.push(index);
        });
    }

    public get length(): number {
        return this._items.length;
    }

    public item(index: number): Interval<T> {
        return this._items[index];
    }

    public parentOf(index: number): number {
        return this._parents[index];
    }

    /**
     * 位置を含む最内の区間
     * @param position 位置 (UTF-16 インデックス)
     * @returns 区間の番号。含む区間が無ければ -1
     */
    public find(position: number): number {
        let low = 0;
        let high = this._items.length - 1;
        let index = -1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            if (this._items[middle].start <= position) {
                index = middle;
                low = middle + 1;
            } else {
                high = middle - 1;
            }
        }
        while (index >= 0 && this._items[index].end <= position) {
            index = this._parents[index];
        }
        return index;
    }
}

/** 引用符を外す */
const unquote = (text: string): string => {
    const first = text.charAt(0);
    return ((first === '"' || first === '\'' || first === '`') && text.endsWith(first) && text.length >= 2)
        ? text.slice(1, -1) : text;
};

/** マッチ内のキャプチャを名前で引けるようにする (同じ名前は最初の1件) */
const capturesByName = (match: AstQueryMatch): Map<string, AstNode> => {
    const found = new Map<string, AstNode>();
    for (const capture of match.captures) {
        if (!found.has(capture.name)) {
            found.set(capture.name, capture.node);
        }
    }
    return found;
};

/** 定義の候補 (統合前) */
interface DefinitionCandidate {
    readonly name: string;
    readonly kind: string;
    readonly signature: boolean;
    readonly node: AstNode;
    readonly nameNode: AstNode;
}

/** 参照出現の候補 (種類の絞り込み前) */
interface OccurrenceCandidate {
    readonly target: AstNode;
    readonly receiver: AstNode | null;
    readonly kind: RelationshipKind;
}

/**
 * クエリのマッチからローカル事実を抽出する
 * @param relativePath ワークスペース相対パス (完全修飾名の接頭辞になる)
 * @param root 構文木の根
 * @param matches クエリのマッチ
 * @returns ローカル事実
 * @description 構文木が生きている間 (AstParser.withMatches の中) に呼ぶ事。戻り値は構文木を参照しない
 */
export function extractLocalFacts(relativePath: string, root: AstNode, matches: AstQueryMatch[]): LocalFacts {
    const fileKey = fileFqn(relativePath);

    // 1. キャプチャを役割ごとに振り分ける
    const definitionCandidates: DefinitionCandidate[] = [];
    const occurrenceCandidates: OccurrenceCandidate[] = [];
    const scopeNodes: AstNode[] = [];
    const bindNodes: AstNode[] = [];
    const excluded = new Set<number>();         // 参照出現にしないノード (定義名・束縛・import・export)
    const exportStatements = new Set<number>();
    const exportDefaults = new Set<number>();
    const exportClauses: { local: string, name: string }[] = [];
    const imports: AstImport[] = [];
    const usedModules = new Set<number>();
    const bareModules: AstNode[] = [];

    for (const match of matches) {
        const captures = capturesByName(match);
        for (const capture of match.captures) {
            const prefix = capture.name.split('.')[0];
            if (prefix === 'def' || prefix === 'bind' || prefix === 'imp' ||
                capture.name === 'export.local' || capture.name === 'export.default.local') {
                excluded.add(capture.node.id);
            }
            if (prefix === 'bind') {
                bindNodes.push(capture.node);
            } else if (capture.name === 'scope') {
                scopeNodes.push(capture.node);
            } else if (capture.name === 'export.statement') {
                exportStatements.add(capture.node.id);
            } else if (capture.name === 'export.default') {
                exportDefaults.add(capture.node.id);
            }
        }

        // 定義
        const definition = match.captures.find(capture => capture.name.startsWith('def.') && capture.name !== 'def.node');
        if (definition) {
            const [, kind, modifier] = definition.name.split('.');
            const node = captures.get('def.node') ?? definition.node.parent;
            if (node) {
                definitionCandidates.push({
                    name: definition.node.text, kind: kind, signature: modifier === 'signature',
                    node: node, nameNode: definition.node,
                });
            }
        }

        // export { local as name } (from 無し) / export default <識別子>
        const exportLocal = captures.get('export.local');
        const exportName = captures.get('export.name');
        if (exportLocal && exportName) {
            exportClauses.push({ local: exportLocal.text, name: exportName.text });
        }
        const exportDefaultLocal = captures.get('export.default.local');
        if (exportDefaultLocal) {
            exportClauses.push({ local: exportDefaultLocal.text, name: 'default' });
        }

        // import 束縛 (1マッチ = 1束縛)
        const module = captures.get('imp.module');
        if (module) {
            usedModules.add(module.id);
            const position = { moduleSpec: unquote(module.text), line: module.startPosition.row, character: module.startPosition.column };
            const local = captures.get('imp.local');
            const exported = captures.get('imp.export');
            if (captures.has('imp.reexport')) {
                imports.push({ localName: null, importedName: '*', exportName: '*', ...position });
            } else if (exported) {
                imports.push({ localName: null, importedName: captures.get('imp.imported')?.text ?? '*', exportName: exported.text, ...position });
            } else if (local) {
                const imported = captures.has('imp.default') ? 'default'
                    : captures.has('imp.namespace') ? '*'
                    : (captures.get('imp.imported')?.text ?? null);
                imports.push({ localName: local.text, importedName: imported, exportName: null, ...position });
            }
        }
        const bare = captures.get('imp.module.bare');
        if (bare) {
            bareModules.push(bare);
        }

        // 参照出現
        const reference = match.captures.find(capture => relationshipKindOf(capture.name) !== null);
        if (reference) {
            occurrenceCandidates.push({
                target: reference.node,
                receiver: captures.get('ref.receiver') ?? null,
                kind: relationshipKindOf(reference.name) as RelationshipKind,
            });
        }
    }

    // 束縛の無い import / require は、同じ指定子を他の束縛が使っていなければ副作用 import
    for (const bare of bareModules) {
        if (!usedModules.has(bare.id)) {
            usedModules.add(bare.id);
            imports.push({
                localName: null, importedName: null, exportName: null,
                moduleSpec: unquote(bare.text), line: bare.startPosition.row, character: bare.startPosition.column,
            });
        }
    }

    // 2. 定義: 入れ子の親を求め、本体の無い宣言 (オーバーロード) を同名の定義へまとめる
    const candidates = new NestedIntervals(definitionCandidates.map(candidate =>
        ({ start: candidate.node.startIndex, end: candidate.node.endIndex, value: candidate })));
    const dropped = new Set<number>();
    const groups = new Map<string, number[]>();
    for (let index = 0; index < candidates.length; index++) {
        const key = JSON.stringify([candidates.parentOf(index), candidates.item(index).value.name]);
        groups.set(key, [...(groups.get(key) ?? []), index]);
    }
    for (const members of groups.values()) {
        const signatures = members.filter(index => candidates.item(index).value.signature);
        if (signatures.length === 0) {
            continue;
        }
        if (signatures.length < members.length) {
            signatures.forEach(index => dropped.add(index));
        } else {
            signatures.slice(1).forEach(index => dropped.add(index));
        }
    }
    // 落とした宣言の内側 (型リテラルのメンバ等) も落とす
    for (let index = 0; index < candidates.length; index++) {
        for (let parent = candidates.parentOf(index); parent >= 0; parent = candidates.parentOf(parent)) {
            if (dropped.has(parent)) {
                dropped.add(index);
                break;
            }
        }
    }

    // 3. 完全修飾名を文書順に振る (同じ親・同じ名前の2つ目以降は ~N)
    const fqns: (string | null)[] = new Array(candidates.length).fill(null);
    const taken = new Map<string, number>();
    const definitions: AstDefinition[] = [];
    const keptIntervals: Interval<number>[] = [];
    for (let index = 0; index < candidates.length; index++) {
        if (dropped.has(index)) {
            continue;
        }
        let parent = candidates.parentOf(index);
        while (parent >= 0 && dropped.has(parent)) {
            parent = candidates.parentOf(parent);
        }
        const candidate = candidates.item(index).value;
        const parentFqn = parent >= 0 ? fqns[parent] as string : fileKey;
        const base = parent >= 0 ? `${parentFqn}.${candidate.name}` : `${parentFqn}${candidate.name}`;
        const count = (taken.get(base) ?? 0) + 1;
        taken.set(base, count);
        fqns[index] = count === 1 ? base : `${base}~${count}`;
        keptIntervals.push({ start: candidate.node.startIndex, end: candidate.node.endIndex, value: definitions.length });
        definitions.push({
            fqn: fqns[index] as string,
            name: candidate.name,
            kind: candidate.kind,
            parentFqn: parentFqn,
            exportName: parent < 0 ? exportNameOf(candidate.node, candidate.name, exportStatements, exportDefaults) : null,
            nameLine: candidate.nameNode.startPosition.row,
            nameCharacter: candidate.nameNode.startPosition.column,
            startLine: candidate.node.startPosition.row,
            endLine: candidate.node.endPosition.row,
        });
    }

    // export { local as name } / export default <識別子> をトップレベルの定義へ反映する
    const exported = definitions.map(definition => definition.exportName);
    for (const clause of exportClauses) {
        definitions.forEach((definition, index) => {
            if (definition.parentFqn === fileKey && definition.name === clause.local && exported[index] === null) {
                exported[index] = clause.name;
            }
        });
    }
    const finalDefinitions = definitions.map((definition, index) =>
        exported[index] === definition.exportName ? definition : { ...definition, exportName: exported[index] });

    // 4. スコープと束縛
    const scopes = new NestedIntervals(scopeNodes.map(node => ({ start: node.startIndex, end: node.endIndex, value: node.id })));
    const bindings = new Map<number, Set<string>>();
    const bind = (scopeId: number, name: string): void => {
        let names = bindings.get(scopeId);
        if (!names) {
            names = new Set<string>();
            bindings.set(scopeId, names);
        }
        names.add(name);
    };
    for (const entry of imports) {
        if (entry.localName) {
            bind(0, entry.localName);
        }
    }
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates.item(index).value;
        if (dropped.has(index) || MEMBER_KINDS.has(candidate.kind)) {
            continue;
        }
        // 定義の名前は、定義ノード自身ではなくその外側のスコープを束縛する (function f の f は外側で見える)
        let scope = scopes.find(candidate.node.startIndex);
        if (scope >= 0 && scopes.item(scope).start === candidate.node.startIndex && scopes.item(scope).end === candidate.node.endIndex) {
            scope = scopes.parentOf(scope);
        }
        bind(scope + 1, candidate.name);
    }
    for (const node of bindNodes) {
        bind(scopes.find(node.startIndex) + 1, node.text);
    }
    const scopeIdOf = (name: string, position: number): number | null => {
        if (name === 'this' || name === 'super') {
            return null;
        }
        for (let scope = scopes.find(position); scope >= 0; scope = scopes.parentOf(scope)) {
            if (bindings.get(scope + 1)?.has(name)) {
                return scope + 1;
            }
        }
        return bindings.get(0)?.has(name) ? 0 : null;
    };

    // 5. 参照出現: 同じノードを捉えた候補から最も具体的な種類を残す
    const selected = new Map<number, OccurrenceCandidate>();
    for (const candidate of occurrenceCandidates) {
        if (excluded.has(candidate.target.id)) {
            continue;
        }
        const current = selected.get(candidate.target.id);
        const rank = relationshipKindRank(candidate.kind);
        const currentRank = current ? relationshipKindRank(current.kind) : Number.MAX_SAFE_INTEGER;
        if (rank < currentRank || (rank === currentRank && current && !current.receiver && candidate.receiver)) {
            selected.set(candidate.target.id, candidate);
        }
    }
    const enclosing = new NestedIntervals(keptIntervals);
    const occurrences: AstOccurrence[] = [];
    for (const candidate of selected.values()) {
        const rootNode = candidate.receiver ?? candidate.target;
        const definition = enclosing.find(candidate.target.startIndex);
        occurrences.push({
            line: candidate.target.startPosition.row,
            character: candidate.target.startPosition.column,
            rootName: rootNode.text,
            memberPath: candidate.receiver ? candidate.target.text : null,
            kind: candidate.kind,
            enclosingFqn: definition >= 0 ? finalDefinitions[enclosing.item(definition).value].fqn : fileKey,
            scopeId: scopeIdOf(rootNode.text, rootNode.startIndex),
        });
    }
    occurrences.sort((a, b) => (a.line - b.line) || (a.character - b.character));

    // import は同じ束縛の重複を除く
    const seen = new Set<string>();
    const uniqueImports = imports.filter(entry => {
        const key = JSON.stringify([entry.localName, entry.importedName, entry.exportName, entry.moduleSpec]);
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });

    return { definitions: finalDefinitions, imports: uniqueImports, occurrences: occurrences, hasError: root.hasError };
}

/**
 * トップレベルの定義の export 名
 * @param node 定義ノード
 * @param name 定義の名前
 * @param statements export 文のノード ID
 * @param defaults export default 文のノード ID
 * @returns export 名。export されていなければ null
 * @description 定義ノードの親 (export class A) か祖父 (export const a = 1 の変数宣言) が export 文なら export されている
 */
function exportNameOf(node: AstNode, name: string, statements: ReadonlySet<number>, defaults: ReadonlySet<number>): string | null {
    let ancestor = node.parent;
    for (let depth = 0; ancestor && depth < 2; depth++, ancestor = ancestor.parent) {
        if (statements.has(ancestor.id)) {
            return defaults.has(ancestor.id) ? 'default' : name;
        }
    }
    return null;
}

/**
 * 1ファイルのローカル事実を抽出する
 * @param parser パーササービス
 * @param languageId VSCode の language id
 * @param relativePath ワークスペース相対パス
 * @param source ソースコード
 * @returns ローカル事実。未対応の language id なら null
 */
export async function collectLocalFacts(parser: AstParser, languageId: string, relativePath: string, source: string): Promise<LocalFacts | null> {
    return parser.withMatches(languageId, source, (root, matches) => extractLocalFacts(relativePath, root, matches));
}
