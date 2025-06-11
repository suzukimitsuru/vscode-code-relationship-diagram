import glob from 'fast-glob';
import * as fs from 'fs';

/** @type 解決したコードファイル */
export type File = {relative_path: string, updated: Date, language_id: string};
export type Resolve = {relative_path: string, updated: Date, language_id: string};
/** @type 文脈付き却下 */
export type Reject = { error: Error, context: string };

/**
 * コードファイルを列挙する
 * @param folder        フォルダ
 * @param associations  ファイル関連定義
 * @returns コードファイル
 */
export function list(folder: string, associations: object): Promise<Promise<Resolve>[]>[] {
    const languages: Promise<Promise<Resolve>[]>[] = [];

    // ファイル関連を列挙する
	for (const [pattern, language_id] of Object.entries(associations)) {
        languages.push(new Promise<Promise<Resolve>[]>((resolve: (codefile: Promise<Resolve>[]) => void, reject: (reject: Reject) => void) => {

            // globパターンを列挙する
            glob(pattern, {cwd: folder, absolute: true, onlyFiles: true}).then((paths) => {
                const files: Promise<Resolve>[] = [];

                for (const path of paths) {
                    files.push(new Promise<Resolve>((resolve: (codefile: Resolve) => void, reject: (reject: Reject) => void) => {

                        // ファイル状態を取得
                        fs.stat(path, (error: NodeJS.ErrnoException | null, stats: fs.Stats) => {
                            if (error) {
                                reject({ error, context: `fs.stat(${path})` });
                            } else {
                                // コードファイルを返す
                                const relative_path = path.substring(folder.length + 1);
                                resolve({relative_path: relative_path, updated: stats.mtime, language_id: language_id});
                            }
                        });
                    }));
                }
                resolve(files);
            }).catch((error: Error) => {
                reject({ error, context: `glob(${pattern})` });
            });
        }));
    }
    return languages;
}

export function files(list: Promise<Promise<Resolve>[]>[]): Promise<Resolve[]> {
    return new Promise<Resolve[]>(async (resolve: (value: Resolve[]) => void, reject: (reject: Reject) => void) => {
        try {
            const files: Resolve[] = [];
            // コードファイルを収集する
            for (const pattern of list) {
                const paths = await pattern;
                for (const path of paths) {
                    files.push(await path);
                }
            }

            // コードファイルをパスでソートする
            const sorted = files.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
            resolve(sorted);
        } catch (error) {
            reject(error as Reject);
        }
    });
}

/**
 * @description コードファイルを列挙する
 * @param folder        フォルダ
 * @param associations  ファイル関連定義
 * @param progress      進捗コールバック
 * @returns void
 */
export function listSync(folder: string, associations: object, progress: (file: File) => void): void {

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
