import { TableData } from 'duckdb';
import glob from 'fast-glob';
import * as fs from 'fs';
import * as path from 'path';

/** @type 列挙したコードファイル */
export class File  {
    constructor(public readonly relative_path: string, public readonly language_id: string, public readonly updated: Date) {};
}

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
            progress(new File(path.substring(wsFolder.length + 1), typeof language_id === 'string' ? language_id : '', stats.mtime));
        }
    }
}
