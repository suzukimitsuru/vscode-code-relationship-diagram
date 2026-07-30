/**
 * サンプル検証: 「シンボル抽出(executeDocumentSymbolProvider)」と
 * 「LSP関係調査(executeReferenceProvider)」が並列に処理できるかを計測する。
 *
 * - 逐次モード: 6リクエスト(シンボル抽出3 + 参照検索3)を1つずつ await
 * - 並列モード: 同じ6リクエストを Promise.all で同時発行
 * 各リクエストの開始/終了時刻を記録し、実時間と重なり(オーバーラップ)を比較する。
 */
const assert = require('assert');
const path = require('path');
const vscode = require('vscode');

/** 参照検索の定義位置 (defs.ts 内: alpha/beta/gamma の識別子位置) */
const DEF_POSITIONS = [
    { name: 'alpha', line: 0, character: 16 },
    { name: 'beta', line: 3, character: 16 },
    { name: 'gamma', line: 6, character: 16 },
];
const USER_FILES = ['user1.ts', 'user2.ts', 'user3.ts'];

function wsPath(file) {
    const folder = vscode.workspace.workspaceFolders[0];
    return path.join(folder.uri.fsPath, file);
}

async function extractSymbols(file, events) {
    const uri = vscode.Uri.file(wsPath(file));
    const start = performance.now();
    const doc = await vscode.workspace.openTextDocument(uri);
    const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
    const end = performance.now();
    events.push({ kind: 'symbol', target: file, start, end });
    return symbols ? symbols.length : 0;
}

async function findRefs(defPos, events) {
    const uri = vscode.Uri.file(wsPath('defs.ts'));
    const start = performance.now();
    const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider',
        uri, new vscode.Position(defPos.line, defPos.character));
    const end = performance.now();
    events.push({ kind: 'refs', target: defPos.name, start, end });
    return Array.isArray(locations) ? locations.length : 0;
}

/** 6リクエストのタスク配列を作る(未実行のサンク) */
function buildWorkload(events) {
    return [
        ...USER_FILES.map(file => () => extractSymbols(file, events)),
        ...DEF_POSITIONS.map(pos => () => findRefs(pos, events)),
    ];
}

/** イベント列から重なり合計時間を求める */
function overlapMs(events) {
    let overlap = 0;
    for (let i = 0; i < events.length; i++) {
        for (let j = i + 1; j < events.length; j++) {
            const s = Math.max(events[i].start, events[j].start);
            const e = Math.min(events[i].end, events[j].end);
            if (e > s) { overlap += e - s; }
        }
    }
    return overlap;
}

suite('LSP parallel execution', () => {

    suiteSetup(async function () {
        this.timeout(120000);
        // tsserver のウォームアップ: シンボルと参照が返るまでリトライ
        for (let attempt = 0; attempt < 60; attempt++) {
            const events = [];
            const symbols = await extractSymbols('defs.ts', events).catch(() => 0);
            const refs = await findRefs(DEF_POSITIONS[0], events).catch(() => 0);
            if (symbols > 0 && refs > 1) { return; }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('tsserver warmup failed');
    });

    test('sequential vs parallel', async function () {
        this.timeout(120000);
        const report = [];
        let seqResults = null;
        let parResults = null;

        for (let round = 1; round <= 3; round++) {
            // 逐次モード
            const seqEvents = [];
            const seqStart = performance.now();
            const seq = [];
            for (const task of buildWorkload(seqEvents)) { seq.push(await task()); }
            const seqWall = performance.now() - seqStart;

            // 並列モード
            const parEvents = [];
            const parStart = performance.now();
            const par = await Promise.all(buildWorkload(parEvents).map(task => task()));
            const parWall = performance.now() - parStart;

            const parSum = parEvents.reduce((sum, event) => sum + (event.end - event.start), 0);
            report.push({ round, seqWall, parWall, parSum, parOverlap: overlapMs(parEvents), parEvents });
            seqResults = seq;
            parResults = par;
        }

        console.log('=== 逐次 vs 並列 (シンボル抽出3件 + 参照検索3件) ===');
        for (const r of report) {
            console.log(`round ${r.round}: 逐次 ${r.seqWall.toFixed(1)}ms | ` +
                `並列 ${r.parWall.toFixed(1)}ms (個別合計 ${r.parSum.toFixed(1)}ms, 重なり ${r.parOverlap.toFixed(1)}ms)`);
        }
        const last = report[report.length - 1];
        console.log('--- 並列モードのタイムライン(最終round, 相対ms) ---');
        const base = Math.min(...last.parEvents.map(event => event.start));
        for (const event of last.parEvents.sort((a, b) => a.start - b.start)) {
            console.log(`${event.kind.padEnd(6)} ${event.target.padEnd(9)} ` +
                `${(event.start - base).toFixed(1).padStart(7)} -> ${(event.end - base).toFixed(1).padStart(7)}`);
        }

        // 結果の整合性: 並列でも逐次と同じ結果が得られる事
        assert.deepStrictEqual(parResults, seqResults, '並列と逐次で結果が一致する事');
        // シンボルが取れている事 / 参照が取れている事
        assert.ok(seqResults.slice(0, 3).every(count => count > 0), 'シンボル抽出が成功する事');
        assert.ok(seqResults.slice(3).every(count => count > 1), '参照検索が成功する事');
        // 並列発行でエラー・欠落が無い事は Promise.all 成功で担保
        // 実時間の比較は console 出力で確認(環境依存のため assert しない)
    });
});
