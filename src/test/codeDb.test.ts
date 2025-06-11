import * as assert from 'assert';
import * as codeDb from '../codeDb';

suite('codeDb Test Suite', () => {

    test('codeFile test', async () => {
        // データベースを生成
        const db = new codeDb.Db(':memory:');
        assert.notStrictEqual(db, null, 'db should not be null');
        
        // テーブル作成
        await db.table_create();
        const empty_codes = await db.codeFile_queryAll();
        assert.strictEqual(empty_codes.length, 0, 'codes.length should be 0');

        // コードファイル1の挿入
        await db.codeFile_upsert('test1.txt', new Date('2023-10-01T12:34:56.123Z'));
        const insert_codes1 = await db.codeFile_queryAll();
        assert.strictEqual(insert_codes1.length, 1, 'codes2.length should be 1');
        assert.strictEqual(insert_codes1[0].relative_path, 'test1.txt', 'codes2[0].relative_path should be test.1txt');
        assert.strictEqual(insert_codes1[0].updated_at.toISOString(), new Date('2023-10-01T12:34:56.123Z').toISOString(), 'codes2[0].updated_at should be 2023-10-01T12:34:56.123Z');
        
        // コードファイル1の更新
        await db.codeFile_upsert('test1.txt', new Date('2023-10-02T12:34:56.123Z'));
        const update_codes1 = await db.codeFile_queryAll();
        assert.strictEqual(update_codes1.length, 1, 'codes3.length should be 1');
        assert.strictEqual(update_codes1[0].relative_path, 'test1.txt', 'codes3[0].relative_path should be test1.txt');
        assert.strictEqual(update_codes1[0].updated_at.toISOString(), new Date('2023-10-02T12:34:56.123Z').toISOString(), 'codes3[0].updated_at should be 2023-10-02T12:34:56.123Z');
        
        // コードファイル2の挿入
        await db.codeFile_upsert('test2.txt', new Date('2023-10-03T12:34:56.123Z'));
        const insert_codes2 = await db.codeFile_queryAll();
        assert.strictEqual(insert_codes2.length, 2, 'codes2.length should be 2');
        assert.strictEqual(insert_codes2[0].relative_path, 'test1.txt', 'codes2[0].relative_path should be test1.txt');
        assert.strictEqual(insert_codes2[0].updated_at.toISOString(), new Date('2023-10-02T12:34:56.123Z').toISOString(), 'codes2[0].updated_at should be 2023-10-02T12:34:56.123Z');
        assert.strictEqual(insert_codes2[1].relative_path, 'test2.txt', 'codes2[1].relative_path should be test2.txt');
        assert.strictEqual(insert_codes2[1].updated_at.toISOString(), new Date('2023-10-03T12:34:56.123Z').toISOString(), 'codes2[0].updated_at should be 2023-10-03T12:34:56.123Z');
        
        // コードファイルの問い合わせ
        const query_codes1 = await db.codeFile_query('test1.txt');
        assert.strictEqual(query_codes1.length, 1, 'query_codes1.length should be 1');
        assert.strictEqual(query_codes1[0].relative_path, 'test1.txt', 'query_codes1[0].relative_path should be test1.txt');
        assert.strictEqual(query_codes1[0].updated_at.toISOString(), new Date('2023-10-02T12:34:56.123Z').toISOString(), 'query_codes1[0].updated_at should be 2023-10-01T12:34:56.123Z');
        const query_codes2 = await db.codeFile_query('test2.txt');
        assert.strictEqual(query_codes2.length, 1, 'query_codes2.length should be 1');
        assert.strictEqual(query_codes2[0].relative_path, 'test2.txt', 'query_codes2[0].relative_path should be test1.txt');
        assert.strictEqual(query_codes2[0].updated_at.toISOString(), new Date('2023-10-03T12:34:56.123Z').toISOString(), 'query_codes2[0].updated_at should be 2023-10-03T12:34:56.123Z');

        // データベースを廃棄
        db.dispose();
    });
});
