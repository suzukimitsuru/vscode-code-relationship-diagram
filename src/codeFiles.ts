import { TableData } from 'duckdb';
import glob from 'fast-glob';
import * as fs from 'fs';
import * as path from 'path';

/** @type 列挙したコードファイル */
export type File = {relative_path: string, updated: Date, language_id: string};

/**
 * @description .gitignoreファイルからignoreパターンを読み込む
 * @param wsFolder ワークスペースフォルダ
 * @returns ignoreパターン配列
 */
export function loadGitignorePatterns(wsFolder: string): string[] {
    const ignorePatterns: string[] = [];

    try {
        const gitignorePath = path.join(wsFolder, '.gitignore');
        if (fs.existsSync(gitignorePath)) {
            const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
            const lines = gitignoreContent.split('\n');

            for (const line of lines) {
                const trimmedLine = line.trim();
                // 空行とコメント行を除外
                if (trimmedLine && !trimmedLine.startsWith('#')) {
                    ignorePatterns.push(trimmedLine);
                }
            }
        }
    } catch (error) {
    }

    // デフォルトのignoreパターンを追加
    ignorePatterns.push(
        '.git/**',
        '.vscode/**',
        '.DS_Store'
    );

    return ignorePatterns;
}

/**
 * @description コードファイルを列挙する
 * @param wsFolder      ワークスペースフォルダ
 * @param associations  ファイル関連定義
 * @param ignores       除外パターン
 * @param progress      進捗コールバック
 * @returns void
 */
export function list(wsFolder: string, associations: object, ignores: string[], progress: (file: File) => void): void {

    // ファイル関連を列挙する
	for (const [pattern, language_id] of Object.entries(associations)) {

        // globパターンを列挙する（.gitignoreパターンを除外）
        const paths = glob.sync(pattern, {cwd: wsFolder, absolute: true, onlyFiles: true, ignore: ignores});
        for (const path of paths) {

            // ファイル状態を取得
            const stats = fs.statSync(path);
            
            // 進捗を報告
            const relative_path = path.substring(wsFolder.length + 1);
            progress({relative_path: relative_path, updated: stats.mtime, language_id: language_id});
        }
    }
}

/**
 * @description コードファイルテーブルの変更を抽出する  
 * - 追加されたファイルを追加する
 * - 更新されたファイルは更新日時を更新する
 * - 削除されたファイルを削除する
 * @param files 列挙したコードファイル配列
 * @param  rows コードファイルテーブル配列
 * @returns 変更するコードファイル配列, 削除するコードファイル名配列
*/
export function updates(files: File[], rows: TableData): [upserts: File[], nochanges: File[], removes: string[]] {
    const upserts: File[] = [];
    const nochanges: File[] = [];
    const removes: string[] = rows.map((row) => row.relative_path as string);
    for (const file of files) {

        // テーブルに登録済みなら
        const row_index = rows.findIndex((row) => row.relative_path === file.relative_path);
        if (row_index >= 0) {

            // 削除しない
            const remove_index = removes.indexOf(file.relative_path);
            if (remove_index >= 0) {
                removes.splice(remove_index, 1);
            }

            // 更新日時が変わったら、変更する
            if (rows[row_index].updated_at.toISOString() !== file.updated.toISOString()) {
                upserts.push(file);
            } else {
                nochanges.push(file);
            }
        } else {
            // 追加する
            upserts.push(file);
        }
    }

    return [upserts, nochanges, removes];
}
