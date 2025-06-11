import glob from 'fast-glob';
import * as fs from 'fs';

/** @type 列挙したコードファイル */
export type File = {relative_path: string, updated: Date, language_id: string};

/**
 * @description コードファイルを列挙する
 * @param folder        フォルダ
 * @param associations  ファイル関連定義
 * @param progress      進捗コールバック
 * @returns void
 */
export function list(folder: string, associations: object, progress: (file: File) => void): void {

    // ファイル関連を列挙する
	for (const [pattern, language_id] of Object.entries(associations)) {

        // globパターンを列挙する
        const paths = glob.sync(pattern, {cwd: folder, absolute: true, onlyFiles: true});
        for (const path of paths) {

            // ファイル状態を取得
            const stats = fs.statSync(path);
            
            // 進捗を報告
            const relative_path = path.substring(folder.length + 1);
            progress({relative_path: relative_path, updated: stats.mtime, language_id: language_id});
        }
    }
}
