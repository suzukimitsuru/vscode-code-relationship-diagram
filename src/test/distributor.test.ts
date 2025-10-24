import * as vscode from 'vscode';
import * as assert from 'assert';
import * as codeFiles from '../codeFiles';
import * as SYMBOL from '../symbol';
import { RowData } from 'duckdb';
import { distribute } from '../distributor';

suite('distributor Test Suite', () => {

    test('distribute codeFiles.File', () => {
        const extructeds: codeFiles.File[] = [
            {relative_path: 'equal', language_id: 'ts', updated: new Date('2023-10-01T12:34:56.123Z')},
            {relative_path: 'add', language_id: 'js', updated: new Date('2023-10-02T12:34:56.123Z')},
            {relative_path: 'update', language_id: 'is', updated: new Date('2023-10-03T12:34:56.123Z')},
        ];
        const db_rows: RowData[] = [
            {relative_path: 'equal', updated_at: new Date('2023-10-01T12:34:56.123Z')},
            {relative_path: 'update', updated_at: new Date('2023-10-02T12:34:56.123Z')},
            {relative_path: 'remove', updated_at: new Date('2023-10-04T12:34:56.123Z')},
        ];
        const [additions, updates, notchanges, removes] = distribute<RowData, codeFiles.File>(db_rows, extructeds,
            (oldItem) => oldItem?.relative_path ?? '',
            (newItem) => newItem.relative_path,
            (oldItem, newItem) => newItem.relative_path === oldItem.relative_path,
            (oldItem, newItem) => newItem.updated.getTime() !== oldItem?.updated_at?.getTime()  
        );

        // 追加されたファイルを確認
        assert.strictEqual(additions.length, 1, 'additions.length should be 1');
        assert.strictEqual(additions[0].relative_path, 'add', 'additions[0].relative_path should be add');
        assert.strictEqual(additions[0].language_id, 'js', 'additions[0].language_id should be js');
        assert.strictEqual(additions[0].updated.toISOString(), new Date('2023-10-02T12:34:56.123Z').toISOString(), 'additions[0].updated should be 2023-10-02T12:34:56.123');
        // 除外ファイル
        assert.strictEqual(additions.some(file => file.relative_path === 'equal'), false, 'additions should not include equal');
        assert.strictEqual(additions.some(file => file.relative_path === 'remove'), false, 'additions should not include remove');

        // 更新されたファイルを確認
        assert.strictEqual(updates.length, 1, 'updates.length should be 1');
        assert.strictEqual(updates[0].relative_path, 'update', 'updates[0].relative_path should be update');
        assert.strictEqual(updates[0].language_id, 'is', 'updates[0].language_id should be is');
        assert.strictEqual(updates[0].updated.toISOString(), new Date('2023-10-03T12:34:56.123Z').toISOString(), 'updates[0].updated should be 2023-10-03T12:34:56.123');
        // 除外ファイル
        assert.strictEqual(updates.some(file => file.relative_path === 'equal'), false, 'updates should not include equal');
        assert.strictEqual(updates.some(file => file.relative_path === 'remove'), false, 'updates should not include remove');

        // 変更のないファイルを確認
        assert.strictEqual(notchanges.length, 1, 'notchanges.length should be 1');
        assert.strictEqual(notchanges[0].relative_path, 'equal', 'notchanges[0].relative_path should be equal');
        assert.strictEqual(notchanges[0].language_id, 'ts', 'notchanges[0].language_id should be ts');
        assert.strictEqual(notchanges[0].updated.toISOString(), new Date('2023-10-01T12:34:56.123Z').toISOString(), 'notchanges[0].updated should be 2023-10-01T12:34:56.123');

        // 削除されたファイルを確認
        assert.strictEqual(removes.length, 1, 'removes.length should be 1');
        // 削除されたファイル
        assert.strictEqual(removes[0], 'remove', 'removes[0] should be remove');
        // 除外ファイル
        assert.strictEqual(removes.includes('equal'), false, 'removes should not include equal');
        assert.strictEqual(removes.includes('add'), false, 'removes should not include add');
        assert.strictEqual(removes.includes('update'), false, 'removes should not include update');
    });

    test('distribute SYMBOL.SymbolModel', () => {
        const olds: SYMBOL.SymbolModel[] = [
            new SYMBOL.SymbolModel('file.ts',         'equal',  vscode.SymbolKind.File,     'path',
                new vscode.Position(0, 0), new vscode.Position(10, 0), new vscode.Position(20, 0), Buffer.from([0x00]), null),
            new SYMBOL.SymbolModel('file.ts/update',  'update', vscode.SymbolKind.Class,    'path',
                new vscode.Position(0, 0), new vscode.Position(10, 0), new vscode.Position(5, 0), Buffer.from([0x01]), 'file.ts'),
            new SYMBOL.SymbolModel('file.ts/remove',  'remove', vscode.SymbolKind.Method,   'path',
                new vscode.Position(0, 0), new vscode.Position(10, 0), new vscode.Position(10, 0), Buffer.from([0x00]), 'file.ts'),
        ];
        const news: SYMBOL.SymbolModel[] = [
            new SYMBOL.SymbolModel('file.ts',         'equal',  vscode.SymbolKind.File,     'path',
                new vscode.Position(0, 0), new vscode.Position(0, 0), new vscode.Position(20, 0), Buffer.from([0x00])),
            new SYMBOL.SymbolModel('file.ts/add',     'add',    vscode.SymbolKind.Enum,     'path',
                new vscode.Position(0, 0), new vscode.Position(1, 0), new vscode.Position(5, 0), Buffer.from([0x00]), 'file.ts'),
            new SYMBOL.SymbolModel('file.ts/update',  'update', vscode.SymbolKind.Class,    'path',
                new vscode.Position(0, 0), new vscode.Position(6, 0), new vscode.Position(10, 0), Buffer.from([0x00]), 'file.ts'),
        ];
        const [additions, updates, notchanges, removes] = distribute<SYMBOL.SymbolModel, SYMBOL.SymbolModel>(olds, news,
            (oldItem) => oldItem.id,
            (newItem) => newItem.id,
            (oldItem, newItem) => newItem.id === oldItem.id,
            (oldItem, newItem) => !newItem.hash.equals(oldItem.hash)  
        );

        // 追加されたファイルを確認
        assert.strictEqual(additions.length, 1, 'additions.length should be 1');
        assert.strictEqual(additions[0].name, 'add', 'additions[0].name should be add');
        // 除外ファイル
        assert.strictEqual(additions.some(symbol => symbol.name === 'equal'), false, 'additions should not include equal');
        assert.strictEqual(additions.some(symbol => symbol.name === 'remove'), false, 'additions should not include remove');

        // 更新されたファイルを確認
        assert.strictEqual(updates.length, 1, 'upserts.length should be 1');
        assert.strictEqual(updates[0].name, 'update', 'upserts[0].relative_path should be update');
        // 除外ファイル
        assert.strictEqual(updates.some(symbol => symbol.name === 'equal'), false, 'updates should not include equal');
        assert.strictEqual(updates.some(symbol => symbol.name === 'remove'), false, 'updates should not include remove');

        // 変更のないファイルを確認
        assert.strictEqual(notchanges.length, 1, 'notchanges.length should be 1');
        assert.strictEqual(notchanges[0].name, 'equal', 'notchanges[0].name should be equal');

        // 削除されたファイルを確認
        assert.strictEqual(removes.length, 1, 'removes.length should be 1');
        // 削除されたファイル
        assert.strictEqual(removes[0], 'file.ts/remove', 'removes[0] should be remove');
        // 除外ファイル
        assert.strictEqual(removes.includes('file.ts'),        false, 'removes should not include file.ts(equal)');
        assert.strictEqual(removes.includes('file.ts/add'),    false, 'removes should not include file.ts/add');
        assert.strictEqual(removes.includes('file.ts/update'), false, 'removes should not include file.ts/update');
    });
});
