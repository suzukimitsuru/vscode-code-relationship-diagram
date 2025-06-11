import * as assert from 'assert';
import * as codeFiles from '../codeFiles';
import * as fs from 'fs';
import * as path from 'path';

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
});