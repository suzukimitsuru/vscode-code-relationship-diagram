import * as vscode from 'vscode';
import * as path from 'path';
import * as codeDb from '../codeDb';
import * as codeFiles from '../extruct/codeFiles';
import * as SYMBOL from '../extruct/symbol';
import * as codeSymbols from '../extruct/codeSymbols';
import * as codeRelationships from './codeRelationships';
import { distribute } from '../distributor';

// ファイルの差分
export class FileDifference {
    public readonly lists: codeFiles.File[];
    public readonly additions: codeFiles.File[];
    public readonly updates: codeFiles.File[];
    public readonly notchanges: codeFiles.File[];
    public readonly removes: string[];
    public constructor(lists: codeFiles.File[], additions: codeFiles.File[], updates: codeFiles.File[], notchanges: codeFiles.File[], removes: string[]) {
        this.lists = lists;
        this.additions = additions;
        this.updates = updates;
        this.notchanges = notchanges;
        this.removes = removes;
    }
}

// 関係を調査するシンボル
export class WillExamine {
    private readonly _file: codeFiles.File;
    public readonly lineCount: number;
    public readonly languageId: string;
    public readonly uri: vscode.Uri;
    public readonly symbols: SYMBOL.SymbolModel[];
    public constructor(file: codeFiles.File, document: vscode.TextDocument, symbols: SYMBOL.SymbolModel[]) {
        this._file = file;
        this.languageId = document.languageId;
        this.uri = document.uri;
        const sum_line = symbols.reduce((sum, symbol) => sum + symbol.lineCount, 0);
        const file_line = symbols.reduce((sum, symbol) => sum + ((symbol.kind === vscode.SymbolKind.File) ? symbol.lineCount : 0), 0);
        this.lineCount = file_line > 0 ? file_line : sum_line;
        this.symbols = symbols;
    }
    public get path(): string {
        return this._file.relative_path;
    }
    public get updated(): Date {
        return this._file.updated;
    }
    public get file(): codeFiles.File {
        return this._file;
    }
}	

export class Examine {
    private _ws_folder: string;
    private _db: codeDb.Db;
    private _last_phase: number = 7;
    private _log: (message: string) => void;
    private _error: (message: string, error: unknown) => void;

    private _line_count = 0;
    private _relationship_count = 0;

    // 更新対象
    private readonly _symbol_all: Record<string, SYMBOL.SymbolModel[]> = {};
	private readonly _code_upserts: WillExamine[] = [];
    public readonly processes: Promise<void>[] = [];

    public constructor(wsFolder: string, db: codeDb.Db, log: (message: string) => void, error: (message: string, error: unknown) => void) {
        this._ws_folder = wsFolder;
        this._db = db;
        this._log = log;
        this._error = error;
    }

    private _extruct_symbols(relativePath: string): Promise<{ doc: vscode.TextDocument, symbols: SYMBOL.SymbolModel[] }> {
        return new Promise<{ doc: vscode.TextDocument, symbols: SYMBOL.SymbolModel[] }>(resolve => {
            vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this._ws_folder, relativePath))).then(doc => {
                codeSymbols.extract(relativePath, doc).then((symbols) => resolve({doc, symbols})).catch(() => resolve({doc, symbols: []}));
            });
        });
    }

    public async fileDifference(wsFolder: string, associations: object, progress: () => void): Promise<FileDifference>
    {
        // ファイルを列挙する
        const lists: codeFiles.File[] = [];
        const ignores = codeFiles.loadGitignorePatterns(wsFolder);
        codeFiles.list(wsFolder, associations, ignores, (file: codeFiles.File) => {
            lists.push(file);
            this._log(`1/${this._last_phase} Listed file: ${file.relative_path}`);
            progress();
        });
        this._log(`Listed file: ${lists.length} files`);

        // ファイルテーブルの全件を読み込む
        const file_loads = await this._db.codeFile_queryAll();

        // ファイルの変更を分配する
        const file_sorted = lists.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
        const [additions, updates, notchanges, removes] = distribute<codeFiles.File, codeFiles.File>(file_loads, file_sorted,
            (oldItem) => oldItem?.relative_path ?? '',
            (newItem) => newItem.relative_path,
            (oldItem, newItem) => newItem.relative_path === oldItem.relative_path,
            (oldItem, newItem) => newItem.updated.getTime() !== oldItem.updated.getTime()  
        );
        return new FileDifference(lists, additions, updates, notchanges, removes);
    }

    public async fileAdditions(file_additions: codeFiles.File[], progress: (code: codeFiles.File, doc: vscode.TextDocument, symbols: SYMBOL.SymbolModel[]) => void): Promise<number> {
        let upsert_count = 0;

        // 追加ファイルは、シンボルをコードから抽出する
        for (const code of file_additions) {
            try {
                // シンボルをコードから抽出する
                const {doc, symbols} = await this._extruct_symbols(code.relative_path);

                // 更新対象を登録
                this._code_upserts.push(new WillExamine(code, doc, symbols));
                upsert_count++;
                this._symbol_all[code.relative_path] = symbols;
                progress(code, doc, symbols);

                // 経過表示
                this._log(`2/${this._last_phase} Extructed symbol: ${code.relative_path}`);
            } catch (error) {
                this._error(`2/${this._last_phase} Failed to open document ${code.relative_path}: `, error);
            }
        }
        return upsert_count;
    }

    public async fileUpdates(file_lists: codeFiles.File[], file_updates: codeFiles.File[]): Promise<number> {
        let upsert_count = 0;

        // 変更ファイルは、シンボルのテーブルと抽出から変更を分配する
        for (const code of file_updates) {

            // シンボルのテーブルからの読み込みと、コードからシンボルの抽出を行う
            const symbol_results = await Promise.allSettled([
                this._db.symbol_query(code.relative_path),
                this._extruct_symbols(code.relative_path),
            ]);
            const olds = symbol_results[0].status === 'fulfilled' ? symbol_results[0].value : [];
            const { doc, symbols: news } = symbol_results[1].status === 'fulfilled' ? symbol_results[1].value : { doc: null, symbols: [] };

            // シンボルの変更を分配する
            const [symbol_additions, symbol_updates, symbol_notchanges, symbol_removes] =
                distribute<SYMBOL.SymbolModel, SYMBOL.SymbolModel>(olds, news,
                (oldItem) => oldItem.id,
                (newItem) => newItem.id,
                (oldItem, newItem) => newItem.id === oldItem.id,
                (oldItem, newItem) => !newItem.hash.equals(oldItem.hash)
            );

            // 追加シンボルは、定義から関係を調査する
            const define_symbols: SYMBOL.SymbolModel[] = [];
            define_symbols.push(...symbol_additions);

            // 変更シンボルは、定義から関係を調査する
            define_symbols.push(...symbol_updates);
            if (doc) {
                // 更新対象を登録
                this._code_upserts.push(new WillExamine(code, doc, define_symbols));
                upsert_count++;
            }

            // 変更シンボルは、参照から関係を調査する
            const refs = await this._db.relationship_queryReferencedSymbols(symbol_updates.map(symbol => symbol.id));
            for (const ref of refs) {
                const { doc: ref_doc, symbols: ref_symbols} = await this._extruct_symbols(ref.reference.path);
                const ref_file = file_lists.filter((file) => file.relative_path === ref.reference.path);
                // 更新対象を登録
                this._code_upserts.push(new WillExamine(ref_file[0], ref_doc, ref_symbols));
                upsert_count++;
            }

            // 変更のないシンボルは、既にシンボルテーブルにも関係テーブルにも在るため、何もしない
            // ただし、位置が変わっている場合は table_symbols のみ更新する
            let position_changed_count = 0;
            for (const newSymbol of symbol_notchanges) {
                const oldSymbol = olds.find(old => old.id === newSymbol.id);
                if (oldSymbol && newSymbol.isPositionChanged(oldSymbol)) {
                    this.processes.push(this._db.symbol_update(newSymbol));
                    position_changed_count++;
                }
            }

            this._symbol_all[code.relative_path] = news;

            // 削除シンボルはDBから削除する
            if (symbol_removes.length > 0) {
                this.processes.push(this._db.symbol_delete(symbol_removes));
                this.processes.push(this._db.relationship_deleteSymbols(symbol_removes));
            }

            // 経過表示
            this._log(`symbols ${code.relative_path}: (added ${symbol_additions.length}, updated ${symbol_updates.length}, no changed ${symbol_notchanges.length}, removed ${symbol_removes.length}, position changed ${position_changed_count})`);
        }
        return upsert_count;
    }

    public async fileNotchanges(file_notchanges: codeFiles.File[], progress: () => void): Promise<void> {

        // 変更のないファイルは、シンボルテーブルを読み込む
        for (const code of file_notchanges) {
            try {
                const symbols = await this._db.symbol_query(code.relative_path);
                this._symbol_all[code.relative_path] = symbols;
                this._line_count += symbols[0].lineCount;
                progress();
                this._log(`3/${this._last_phase} Not changed: ${code.relative_path}`);                
            } catch (error) {
                this._error(`3/${this._last_phase} Failed to load symbols for ${code.relative_path}: `, error);
            }
        }
    }

    public fileRemoves(files: string[], progress: () => void): void {
        for (const file of files) {
            this.processes.push(new Promise<void>((resolve, reject) => {
                Promise.allSettled([
                    this._db.relationship_deleteFile(file),
                    this._db.symbol_deleteFile(file),
                    this._db.codeFile_delete(file),
                ]).then(() => {
                    this._log(`4/${this._last_phase} Removed file: ${file}`);
                    progress();
                    resolve();
                }).catch(error => {
                    reject(`4/${this._last_phase} db.symbol_delete(${file}): ${error instanceof Error ? error.message : error}`);
                });
            }));
        }
    }

    public updateRelationships(progress: () => void): void {

        // ファイル更新を追加する
        for (const code_upsert of this._code_upserts) {
            this._line_count += code_upsert.lineCount;

            // 関係を調査する
            this.processes.push(new Promise<void>((resolve, reject) => {
                this._relationships(code_upsert.file, code_upsert.symbols).then(([define_rels, reference_rels]) => {
                    this._relationship_count += reference_rels.length;

                    // データベースを更新する
                    this._update(code_upsert.file, code_upsert.symbols, [...define_rels, ...reference_rels], progress)
                    .then(() => { resolve(); })
                    .catch(error => { reject(error); });
                }).catch(error => {
                    reject(error);
                });
            }));
        }
    }

    public get lineCount(): number {
        return this._line_count;
    }
    public get relationshipCount(): number {
        return this._relationship_count;
    }

    public _relationships(file: codeFiles.File, symbols: SYMBOL.SymbolModel[]):
        Promise<[defines: codeRelationships.Relationship[], references: codeRelationships.Relationship[]]>
    {
        return new Promise<[defines: codeRelationships.Relationship[], references: codeRelationships.Relationship[]]>((resolve, reject) => {
        
            // 定義を検索
            this._db.relationship_queryDefinePath(file.relative_path).then(define_rels => {

                // 関係を調査
                const uri = vscode.Uri.file(path.join(this._ws_folder, file.relative_path));
                codeRelationships.examine(this._ws_folder, uri, symbols, this._symbol_all, 3).then(reference_rels => {
                    this._log(`5/${this._last_phase} Examined relationship: ${file.relative_path} ${reference_rels.length} references`);

                    resolve([define_rels, reference_rels]);
                }).catch(error => {
                    reject(`5/${this._last_phase} Failed to Examine relationships from ${file.relative_path}: ${error instanceof Error ? error.message : error}`);
                });
            }).catch(error => {
                reject(`4/${this._last_phase} Failed to query relationships for ${file.relative_path}: ${error instanceof Error ? error.message : error}`);
            });
        });
    }

    public _update(file: codeFiles.File, symbols: SYMBOL.SymbolModel[], relationships: codeRelationships.Relationship[], progress: () => void): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            // 追加する関係を予め削除する(存在しない場合もある)
            this._db.relationship_delete(relationships).finally(() => {

                // 関係を追加する
                this._db.relationship_inserts(relationships).then(() => {

                    // シンボルをDBに保存する
                    this._db.symbol_inserts(symbols).then(() => {
                        this._log(`6/${this._last_phase} Saved symbol: ${file.relative_path}`);

                        // ファイルを更新または挿入する
                        this._db.codeFile_upsert(file).then(() => {
                            this._log(`7/${this._last_phase} Upserted file: ${file.relative_path}`);
                            progress();
                            resolve();
                        }).catch(error => {
                            reject(`7/${this._last_phase} db.codeFile_upsert(${file.relative_path}): ${error instanceof Error ? error.message : error}`);
                        });
                    }).catch(error => {
                        reject(`6/${this._last_phase} db.symbol_save(${file.relative_path}): ${error instanceof Error ? error.message : error}`);
                    });
                }).catch(error => {
                    reject(`5/${this._last_phase} Failed to insert relationships for ${file.relative_path}: ${error instanceof Error ? error.message : error}`);
                });
            });
        });
    }
}
