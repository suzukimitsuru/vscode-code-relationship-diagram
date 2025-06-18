import * as assert from 'assert';
import * as codeFiles from '../codeFiles';
import * as path from 'path';
import { TableData } from 'duckdb';

suite('codeFiles Test Suite', () => {

	test('list test', async () => {
		const files: codeFiles.File[] = [];
		codeFiles.list(path.join(__dirname, '../../src/test/codeFiles.test',), 
			{ "**/*.rs": "rust", "**/*.go": "golang" }, (file: codeFiles.File) => { files.push(file);});
		
		assert.strictEqual(files.length, 2, 'files.length should be 2');
		assert.strictEqual(files[0].relative_path, 'folder1/test1.rs', 'files[0].relative_path should be folder1/test1.rs');
		assert.strictEqual(files[0].language_id, 'rust', 'files[0].language_id should be rust');
		assert.strictEqual(files[0].updated.toISOString(), new Date('2025-05-30T12:49:06.666Z').toISOString(), 'files[0].updated should be 2025-05-30T12:49:06.666Z');

		assert.strictEqual(files[1].relative_path, 'folder2/test2.go', 'files[1].relative_path should be folder2/test2.go');
		assert.strictEqual(files[1].language_id, 'golang', 'files[1].language_id should be golang');
		assert.strictEqual(files[1].updated.toISOString(), new Date('2025-05-30T12:49:31.429Z').toISOString(), 'files[1].updated should be 2025-05-30T12:49:31.429Z');

	});

	test('update test', async () => {
		const list_files: codeFiles.File[] = [
			{relative_path: 'equal', language_id: 'ts', updated: new Date('2023-10-01T12:34:56.123Z')},
			{relative_path: 'add', language_id: 'js', updated: new Date('2023-10-02T12:34:56.123Z')},
			{relative_path: 'update', language_id: 'is', updated: new Date('2023-10-03T12:34:56.123Z')},
		];
		const db_rows: TableData = [
			{relative_path: 'equal', updated_at: new Date('2023-10-01T12:34:56.123Z')},
			{relative_path: 'update', updated_at: new Date('2023-10-02T12:34:56.123Z')},
			{relative_path: 'remove', updated_at: new Date('2023-10-04T12:34:56.123Z')},
		];
		const [upserts, removes] = codeFiles.updates(list_files, db_rows);

		// 追加されたファイルと更新されたファイルの数を確認
		assert.strictEqual(upserts.length, 2, 'upserts.length should be 2');
		// 追加されたファイル
		assert.strictEqual(upserts[0].relative_path, 'add', 'upserts[0].relative_path should be add');
		assert.strictEqual(upserts[0].language_id, 'js', 'upserts[0].language_id should be js');
		assert.strictEqual(upserts[0].updated.toISOString(), new Date('2023-10-02T12:34:56.123Z').toISOString(), 'upserts[0].updated should be 2023-10-02T12:34:56.123');
		// 更新されたファイル
		assert.strictEqual(upserts[1].relative_path, 'update', 'upserts[1].relative_path should be update');
		assert.strictEqual(upserts[1].language_id, 'is', 'upserts[1].language_id should be is');
		assert.strictEqual(upserts[1].updated.toISOString(), new Date('2023-10-03T12:34:56.123Z').toISOString(), 'upserts[1].updated should be 2023-10-03T12:34:56.123');
		// 除外ファイル
		assert.strictEqual(upserts.some(file => file.relative_path === 'equal'), false, 'upserts should not include equal');
		assert.strictEqual(upserts.some(file => file.relative_path === 'remove'), false, 'upserts should not include remove');

		// 削除されたファイルの数を確認
		assert.strictEqual(removes.length, 1, 'removes.length should be 1');
		// 削除されたファイル
		assert.strictEqual(removes[0], 'remove', 'removes[0] should be remove');
		// 除外ファイル
		assert.strictEqual(removes.includes('equal'), false, 'removes should not include equal');
		assert.strictEqual(removes.includes('add'), false, 'removes should not include add');
		assert.strictEqual(removes.includes('update'), false, 'removes should not include update');
	});
});