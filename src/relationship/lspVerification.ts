/**
 * @file 低確信度の関係を LSP で確定する (docs/ast-plan.md §7.4)
 * @description 名前解決の確信度が閾値未満の参照出現だけ、言語サーバに定義の位置を問い合わせ (参照 → 定義の1往復)、
 *              返った位置の AST の定義へ関係を置き換える。言語サーバが答えなければ、関係はそのまま残す
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type * as codeDb from '../codeDb';
import { CONFIDENCE, RelationshipV2 } from './resolve';

/** 定義の位置 (path はワークスペース相対。ワークスペースの外なら null) */
export interface DefinitionLocation {
    readonly path: string | null;
    readonly line: number;
    readonly character: number;
}

/**
 * 参照の位置から定義の位置を問い合わせる
 * @returns 定義の位置。言語サーバが答えなかった (未導入・起動前・定義が見つからない) なら null か空の配列
 */
export type DefinitionProvider = (relativePath: string, line: number, character: number) => Promise<DefinitionLocation[] | null>;

/** LSP による確定の統計 */
export interface VerificationStats {
    /** 問い合わせた名前 (参照出現 × 名前) */
    queried: number;
    /** 言語サーバが答えなかった (関係はそのまま残す) */
    unanswered: number;
    /** 候補のどれかが確定した */
    confirmed: number;
    /** 候補には無い定義へ置き換えた */
    replaced: number;
    /** 定義がプロジェクトの外 (組込み・パッケージ) で、候補を全て消した */
    dropped: number;
    /** ソース中に名前が見つからず、問い合わせなかった */
    unlocated: number;
}

/** 空の統計 */
export function emptyVerificationStats(): VerificationStats {
    return { queried: 0, unanswered: 0, confirmed: 0, replaced: 0, dropped: 0, unlocated: 0 };
}

/** 名前を探すのは参照出現の開始からこの文字数まで (メンバの連鎖が改行をまたいでも届く長さ) */
const SEARCH_WINDOW = 2000;

/** 完全修飾名の最後の名前 (同名の兄弟の番号 ~N を除く) */
export function lastNameOf(fqn: string): string {
    return fqn.slice(fqn.lastIndexOf('#') + 1).split('.').pop()!.replace(/~\d+$/, '');
}

/**
 * 参照出現の開始から、名前の最初の出現の位置を探す
 * @param source ソース
 * @param line 参照出現の開始行
 * @param character 参照出現の開始桁 (UTF-16)
 * @param name 名前
 * @returns 名前の開始位置 (見つからなければ null)
 * @description 参照出現の位置は根の名前の位置なので、`a.b.c` の `c` はその後ろを探す
 */
export function locateName(source: string, line: number, character: number, name: string): { line: number, character: number } | null {
    let offset = 0;
    for (let current = 0; current < line; current++) {
        const next = source.indexOf('\n', offset);
        if (next < 0) {
            return null;
        }
        offset = next + 1;
    }
    offset += character;
    const escaped = name.replace(/[$]/g, '\\$');
    const pattern = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g');
    pattern.lastIndex = offset;
    const found = pattern.exec(source);
    if (!found || found.index > offset + SEARCH_WINDOW) {
        return null;
    }
    const before = source.slice(0, found.index);
    const lineStart = before.lastIndexOf('\n') + 1;
    return { line: before.split('\n').length - 1, character: found.index - lineStart };
}

/** 確定に使う DB の操作 */
export type VerificationDb = Pick<codeDb.Db, 'relationships_v2_queryUncertain' | 'relationships_v2_confirm' | 'definitions_queryAt'>;

/**
 * 低確信度の関係を LSP で確定する
 */
export class LspVerifier {
    private readonly _db: VerificationDb;
    private readonly _definitionAt: DefinitionProvider;
    private readonly _readSource: (relativePath: string) => Promise<string | null>;

    /**
     * @param db DB
     * @param definitionAt 定義の位置の問い合わせ
     * @param readSource ソースの読み込み (事実を抽出した時と同じ内容。読めなければ null)
     */
    public constructor(db: VerificationDb, definitionAt: DefinitionProvider, readSource: (relativePath: string) => Promise<string | null>) {
        this._db = db;
        this._definitionAt = definitionAt;
        this._readSource = readSource;
    }

    /**
     * ファイル群の低確信度の関係を問い合わせ、置き換える内容を求める (DB へは書き込まない)
     * @param paths 参照元ファイル
     * @param threshold 確信度の閾値 (これ未満を問い合わせる)
     * @returns 消す関係・加える関係と統計
     * @description 1つの参照出現 (位置) の関係を、定義側の名前ごとにまとめて1回問い合わせる。
     *              モジュール単位の関係 (export default の無名関数など) は名前が無いため問い合わせない
     */
    public async verify(paths: string[], threshold: number): Promise<{ removes: RelationshipV2[], inserts: RelationshipV2[], stats: VerificationStats }> {
        const stats = emptyVerificationStats();
        const removes: RelationshipV2[] = [];
        const inserts: RelationshipV2[] = [];
        const uncertain = (await this._db.relationships_v2_queryUncertain(paths, threshold)).filter(entry => !entry.defineFqn.endsWith('#'));

        // 参照出現の位置 × 名前 ごとにまとめる
        const groups = new Map<string, RelationshipV2[]>();
        for (const entry of uncertain) {
            const key = JSON.stringify([entry.referencePath, entry.referenceLine, entry.referenceCharacter, lastNameOf(entry.defineFqn)]);
            groups.set(key, [...(groups.get(key) ?? []), entry]);
        }

        const sources = new Map<string, string | null>();
        for (const [key, group] of groups) {
            const [referencePath, line, character, name] = JSON.parse(key) as [string, number, number, string];
            if (!sources.has(referencePath)) {
                sources.set(referencePath, await this._readSource(referencePath));
            }
            const source = sources.get(referencePath);
            const position = source ? locateName(source, line, character, name) : null;
            if (!position) {
                stats.unlocated++;
                continue;
            }
            stats.queried++;
            const locations = await this._definitionAt(referencePath, position.line, position.character);
            if (!locations || locations.length === 0) {
                stats.unanswered++;
                continue;
            }

            // 返った位置の AST の定義 (ワークスペースの外・定義の無い位置は除く)
            const defined: { path: string, fqn: string }[] = [];
            for (const location of locations) {
                const fqn = location.path === null ? null : await this._db.definitions_queryAt(location.path, location.line, location.character);
                if (location.path !== null && fqn !== null && !defined.some(entry => entry.fqn === fqn)) {
                    defined.push({ path: location.path, fqn: fqn });
                }
            }
            removes.push(...group);
            if (defined.length === 0) {
                stats.dropped++;
                continue;
            }
            const sample = group[0];
            const isSelf = (fqn: string): boolean => fqn === sample.referenceFqn || fqn.startsWith(`${sample.referenceFqn}.`);
            const candidates = new Set(group.map(entry => entry.defineFqn));
            for (const entry of defined.filter(entry => !isSelf(entry.fqn))) {
                inserts.push({
                    ...sample, definePath: entry.path, defineFqn: entry.fqn,
                    confidence: CONFIDENCE.confirmed, isIntraFile: entry.path === sample.referencePath,
                });
            }
            if (defined.some(entry => candidates.has(entry.fqn))) {
                stats.confirmed++;
            } else {
                stats.replaced++;
            }
        }
        return { removes, inserts, stats };
    }
}

/**
 * VS Code の言語サーバに定義の位置を問い合わせる
 * @param workspaceFolder ワークスペースフォルダ
 * @returns 問い合わせ関数
 */
export function vscodeDefinitionProvider(workspaceFolder: string): DefinitionProvider {
    return async (relativePath, line, character) => {
        const uri = vscode.Uri.file(path.join(workspaceFolder, relativePath));
        let found: (vscode.Location | vscode.LocationLink)[] | undefined;
        try {
            found = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                'vscode.executeDefinitionProvider', uri, new vscode.Position(line, character));
        } catch {
            return null;
        }
        if (!Array.isArray(found)) {
            return null;
        }
        return found.map(location => {
            const target = 'targetUri' in location
                ? { uri: location.targetUri, start: (location.targetSelectionRange ?? location.targetRange).start }
                : { uri: location.uri, start: location.range.start };
            const relative = path.relative(workspaceFolder, target.uri.fsPath);
            const inside = target.uri.scheme === 'file' && relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
            return { path: inside ? relative : null, line: target.start.line, character: target.start.character };
        });
    };
}

/**
 * 事実を抽出した時と同じ内容でソースを読む (UTF-8。BOM は内容に含めない)
 * @param workspaceFolder ワークスペースフォルダ
 * @returns 読み込み関数
 */
export function workspaceSourceReader(workspaceFolder: string): (relativePath: string) => Promise<string | null> {
    return async (relativePath) => {
        try {
            return (await fs.promises.readFile(path.join(workspaceFolder, relativePath), 'utf8')).replace(/^﻿/, '');
        } catch {
            return null;
        }
    };
}
