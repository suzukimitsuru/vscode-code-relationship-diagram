/** @file Phase A: ローカル事実の抽出 (docs/ast-plan.md §6.3) */
import { AstNode, AstParser, AstQueryMatch } from './parser';
import { RelationshipKind, relationshipKindOf, relationshipKindRank } from './relationshipKind';

/**
 * 事実抽出の版数
 * @description クエリや抽出規則を変えたら上げる。DB の facts_version がこれと異なるファイルは、
 *              内容が変わっていなくても次の全走査で事実だけを抽出し直す
 */
export const FACTS_VERSION = 2;

/**
 * 自ファイルを指すモジュール指定子
 * @description `export default a` / `export { a as b }` で、既に別の名前で export している定義を
 *              もう1つの名前で export する時、「自ファイルからの再エクスポート」として import 束縛に記録する
 *              (export_name は1つしか持てないため)。モジュール解決はこのファイル自身へ解決する
 */
export const SELF_MODULE_SPEC = '';

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

    /**
     * 根の名前を束縛しているファイル内の定義の完全修飾名
     * @description import 束縛・定義以外の束縛 (引数・分割代入の変数など)・ファイル内に束縛が無い場合は null。
     *              同じスコープで import と定義が同じ名前を束縛する場合 (const fs = require('fs')) は import を優先して null
     */
    readonly bindingFqn: string | null;
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
    /** コンストラクタ引数のプロパティ (親はコンストラクタの1つ外側のクラス) */
    readonly parameter: boolean;
    readonly node: AstNode;
    readonly nameNode: AstNode;
}

/** 束縛の種類 (優先順位は BINDER_PRIORITY) */
interface Binder {
    readonly type: 'import' | 'definition' | 'local';
    readonly fqn: string | null;
}

/** 同じスコープ・同じ名前を複数が束縛する時の優先順位 (小さいほど優先) */
const BINDER_PRIORITY: Readonly<Record<Binder['type'], number>> = { import: 0, definition: 1, local: 2 };

/** メンバ参照の連鎖として正規化したレシーバ (A.B.c() のレシーバ A.B → 根 A・経路 [B]) */
interface ReceiverChain {
    readonly root: AstNode;
    readonly members: string[];

    /** 連鎖を構成するノード (根と途中のメンバ) */
    readonly nodes: number[];
}

/**
 * レシーバをメンバ参照の連鎖として正規化する
 * @param receiver レシーバのノード (識別子・this・super・メンバ参照・型の修飾名)
 * @returns 連鎖。途中に呼び出しや添字を含む (`a().b`、`a[0].b`) なら null
 */
function receiverChainOf(receiver: AstNode): ReceiverChain | null {
    const members: string[] = [];
    const nodes: number[] = [];
    let node: AstNode | null = receiver;
    while (node && (node.type === 'member_expression' || node.type === 'nested_identifier')) {
        const property = node.childForFieldName('property');
        if (!property || property.type !== 'property_identifier') {
            return null;
        }
        members.unshift(property.text);
        nodes.push(property.id);
        node = node.childForFieldName('object');
    }
    if (!node || (node.type !== 'identifier' && node.type !== 'this' && node.type !== 'super')) {
        return null;
    }
    nodes.push(node.id);
    return { root: node, members: members, nodes: nodes };
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
    const exportClauses: { local: string, name: string, line: number, character: number }[] = [];
    const definitionNames = new Set<number>();
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
        if (definition && !definitionNames.has(definition.node.id)) {
            // 同じ名前ノードを複数のパターンが捉える事がある (public readonly x の x)
            definitionNames.add(definition.node.id);
            const [, kind, modifier] = definition.name.split('.');
            const node = captures.get('def.node') ?? definition.node.parent;
            if (node) {
                definitionCandidates.push({
                    name: definition.node.text, kind: kind, signature: modifier === 'signature', parameter: modifier === 'parameter',
                    node: node, nameNode: definition.node,
                });
            }
        }

        // export { local as name } (from 無し) / export default <識別子>
        const exportLocal = captures.get('export.local');
        const exportName = captures.get('export.name');
        if (exportLocal && exportName) {
            exportClauses.push({ local: exportLocal.text, name: exportName.text,
                line: exportLocal.startPosition.row, character: exportLocal.startPosition.column });
        }
        const exportDefaultLocal = captures.get('export.default.local');
        if (exportDefaultLocal) {
            exportClauses.push({ local: exportDefaultLocal.text, name: 'default',
                line: exportDefaultLocal.startPosition.row, character: exportDefaultLocal.startPosition.column });
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
        const candidate = candidates.item(index).value;
        let parent = candidates.parentOf(index);
        if (candidate.parameter && parent >= 0) {
            parent = candidates.parentOf(parent);
        }
        while (parent >= 0 && dropped.has(parent)) {
            parent = candidates.parentOf(parent);
        }
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
    // 既に別の名前で export している定義と、import した名前の export は、再エクスポートとして import 束縛に記録する
    const exported = definitions.map(definition => definition.exportName);
    for (const clause of exportClauses) {
        const position = { line: clause.line, character: clause.character };
        let found = false;
        definitions.forEach((definition, index) => {
            if (definition.parentFqn === fileKey && definition.name === clause.local) {
                found = true;
                if (exported[index] === null) {
                    exported[index] = clause.name;
                } else if (exported[index] !== clause.name) {
                    imports.push({ localName: null, importedName: clause.local, exportName: clause.name, moduleSpec: SELF_MODULE_SPEC, ...position });
                }
            }
        });
        const imported = found ? undefined : imports.find(entry => entry.localName === clause.local);
        if (imported && imported.importedName !== null) {
            imports.push({ localName: null, importedName: imported.importedName, exportName: clause.name, moduleSpec: imported.moduleSpec, ...position });
        }
    }
    const finalDefinitions = definitions.map((definition, index) =>
        exported[index] === definition.exportName ? definition : { ...definition, exportName: exported[index] });

    // 4. スコープと束縛 (同じスコープ・同じ名前では import > 定義 > 定義以外の束縛 の順に優先する)
    const scopes = new NestedIntervals(scopeNodes.map(node => ({ start: node.startIndex, end: node.endIndex, value: node.id })));
    const bindings = new Map<number, Map<string, Binder>>();
    const bind = (scopeId: number, name: string, binder: Binder): void => {
        let names = bindings.get(scopeId);
        if (!names) {
            names = new Map<string, Binder>();
            bindings.set(scopeId, names);
        }
        const current = names.get(name);
        if (!current || BINDER_PRIORITY[binder.type] < BINDER_PRIORITY[current.type]) {
            names.set(name, binder);
        }
    };
    for (const entry of imports) {
        if (entry.localName) {
            bind(0, entry.localName, { type: 'import', fqn: null });
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
        bind(scope + 1, candidate.name, { type: 'definition', fqn: fqns[index] });
    }
    for (const node of bindNodes) {
        bind(scopes.find(node.startIndex) + 1, node.text, { type: 'local', fqn: null });
    }
    const bindingOf = (name: string, position: number): { scopeId: number | null, bindingFqn: string | null } => {
        if (name === 'this' || name === 'super') {
            return { scopeId: null, bindingFqn: null };
        }
        for (let scope = scopes.find(position); scope >= -1; scope = scope >= 0 ? scopes.parentOf(scope) : -2) {
            const binder = bindings.get(scope + 1)?.get(name);
            if (binder) {
                return { scopeId: scope + 1, bindingFqn: binder.type === 'definition' ? binder.fqn : null };
            }
        }
        return { scopeId: null, bindingFqn: null };
    };

    // 5. 参照出現: レシーバをメンバ参照の連鎖として正規化し、同じノードを捉えた候補から最も具体的な種類を残す
    //    連鎖 (A.B.c) の内側のノード (A, B) を捉えた読み取りは、連鎖全体の参照出現に含まれるため除く
    const chains = new Map<OccurrenceCandidate, ReceiverChain>();
    const chainNodes = new Set<number>();
    for (const candidate of occurrenceCandidates) {
        if (!candidate.receiver) {
            continue;
        }
        const chain = receiverChainOf(candidate.receiver);
        if (chain) {
            chains.set(candidate, chain);
            chain.nodes.forEach(id => chainNodes.add(id));
        }
    }
    const selected = new Map<number, OccurrenceCandidate>();
    for (const candidate of occurrenceCandidates) {
        if (excluded.has(candidate.target.id) || (candidate.receiver && !chains.has(candidate)) ||
            (candidate.kind === RelationshipKind.read && chainNodes.has(candidate.target.id))) {
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
        const chain = chains.get(candidate);
        const rootNode = chain?.root ?? candidate.target;
        const definition = enclosing.find(candidate.target.startIndex);
        occurrences.push({
            line: candidate.target.startPosition.row,
            character: candidate.target.startPosition.column,
            rootName: rootNode.text,
            memberPath: chain ? [...chain.members, candidate.target.text].join('.') : null,
            kind: candidate.kind,
            enclosingFqn: definition >= 0 ? finalDefinitions[enclosing.item(definition).value].fqn : fileKey,
            ...bindingOf(rootNode.text, rootNode.startIndex),
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
