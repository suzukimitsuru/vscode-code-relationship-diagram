import * as assert from 'assert';
import * as codeFiles from '../codeFiles';
import * as fs from 'fs';
import * as path from 'path';

suite('codeFiles Test Suite', () => {

	test('list async test', async () => {
		const codes = await codeFiles.list(path.join(__dirname, '../../src/test/codeFiles.test'), 
			{ "**/*.rs": "rust", "**/*.go": "golang" });
		assert.notStrictEqual(codes, null, 'codes should not be null');
		assert.strictEqual(codes.length, 2, 'codes.length should be 2');

		const language1 = await codes[0];
		assert.strictEqual(language1.length, 1, 'codes1.length should be 1');
		const files1_1 = await language1[0];
		assert.strictEqual(files1_1.relative_path, 'folder1/test1.rs', 'codes1_1.relative_path should be folder1/test1.rs');
		assert.strictEqual(files1_1.language_id, 'rust', 'codes1_1.language_id should be rust');
		assert.strictEqual(files1_1.updated.toISOString(), new Date('2025-05-30T12:49:06.666Z').toISOString(), 'codes1_1.updated should be 2025-05-30T12:49:06.666Z');

		const language2 = await codes[1];
		assert.strictEqual(language2.length, 1, 'codes2.length should be 1');
		const files2_1 = await language2[0];
		assert.strictEqual(files2_1.relative_path, 'folder2/test2.go', 'codes2_1.relative_path should be folder2/test2.go');
		assert.strictEqual(files2_1.language_id, 'golang', 'codes2_1.language_id should be golang');
		assert.strictEqual(files2_1.updated.toISOString(), new Date('2025-05-30T12:49:31.429Z').toISOString(), 'codes2_1.updated should be 2025-05-30T12:49:31.429Z');

	});

	test('list sync test', async () => {
		const files: codeFiles.File[] = [];
		codeFiles.listSync(path.join(__dirname, '../../src/test/codeFiles.test',), 
			{ "**/*.rs": "rust", "**/*.go": "golang" }, (file: codeFiles.File) => { files.push(file);});
		
		assert.strictEqual(files.length, 2, 'files.length should be 2');
		assert.strictEqual(files[0].relative_path, 'folder1/test1.rs', 'codes1_1.relative_path should be folder1/test1.rs');
		assert.strictEqual(files[0].language_id, 'rust', 'codes1_1.language_id should be rust');
		assert.strictEqual(files[0].updated.toISOString(), new Date('2025-05-30T12:49:06.666Z').toISOString(), 'codes1_1.updated should be 2025-05-30T12:49:06.666Z');

		assert.strictEqual(files[1].relative_path, 'folder2/test2.go', 'codes2_1.relative_path should be folder2/test2.go');
		assert.strictEqual(files[1].language_id, 'golang', 'codes2_1.language_id should be golang');
		assert.strictEqual(files[1].updated.toISOString(), new Date('2025-05-30T12:49:31.429Z').toISOString(), 'codes2_1.updated should be 2025-05-30T12:49:31.429Z');

	});
});