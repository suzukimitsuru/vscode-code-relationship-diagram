# 検証記録: シンボル抽出とLSP関係調査の並列実行

- **検証日**: 2026-07-15
- **関連仕様**: [docs/file-difference-queue.md](../../docs/file-difference-queue.md) §6
- **目的**: ファイル差分キューの再設計（関係調査タスクのファイル単位並列化）に先立ち、
  「シンボル抽出（`executeDocumentSymbolProvider`）」と「LSP関係調査（`executeReferenceProvider`）」を
  並列に発行して安全か・実時間が短縮されるかを確認する

---

## 検証方法

`@vscode/test-electron`（VSCodeテストホスト）上で、TypeScript 4ファイルのフィクスチャワークスペースに対し、
同じ6リクエスト（シンボル抽出3件 + 参照検索3件）を2つのモードで発行して比較した。

- **逐次モード**: 6リクエストを1つずつ `await`
- **並列モード**: 6リクエストを `Promise.all` で同時発行

各リクエストの開始/終了時刻を記録し、実時間・処理時間帯の重なり・結果の一致を検証した。3ラウンド実施。

## 実行方法

プロジェクトルートから以下を実行する（初回はVSCode 1.105.0が `.vscode-test/` にダウンロードされる）。

```bash
npx vscode-test --config verification/lsp-parallel/.vscode-test.mjs
```

## フォルダ構成

```text
verification/lsp-parallel/
├── README.md               # 本ファイル（検証記録）
├── .vscode-test.mjs        # テスト設定（このフォルダ基準の相対パスで動作）
├── package.json            # テストホスト用の最小拡張マニフェスト
├── fixture/                # 検証用TypeScriptワークスペース
│   ├── defs.ts             # 定義側: alpha / beta / gamma
│   ├── user1.ts〜user3.ts  # 参照側: defs.ts の関数を呼び出す
│   └── tsconfig.json
└── test/
    └── lsp-parallel.test.js  # 計測テスト本体
```

---

## 検証結果（2026-07-15 実施, macOS arm64, VSCode 1.105.0）

| round | 逐次 | 並列 | 並列時の個別合計 | 並列時の重なり合計 |
| --- | --- | --- | --- | --- |
| 1 | 33.8ms | 4.3ms | 11.6ms | 13.8ms |
| 2 | 6.1ms | 3.2ms | 8.7ms | 11.0ms |
| 3 | 9.7ms | 3.9ms | 10.1ms | 12.0ms |

並列モードのタイムライン（最終round, 相対ms）:

```text
symbol user1.ts      0.0 ->     0.5
symbol user2.ts      0.0 ->     0.5
symbol user3.ts      0.0 ->     0.6
refs   alpha         0.0 ->     1.9
refs   beta          0.1 ->     2.9
refs   gamma         0.1 ->     3.9
```

## 結論

- **並列発行は可能**: エラー・欠落なし。結果（シンボル数・参照数）は逐次実行と完全一致（`assert.deepStrictEqual` で検証）
- **実時間は短縮される**: リクエストが実際に重なって処理され、並列の実時間 < 個別所要時間の合計
- **ただし同一言語サーバー内の意味解析は直列化される**: 参照検索3件の完了時刻は約1msずつ階段状にずれており、
  tsserver 内部でセマンティック要求が順次処理されている。シンボル抽出（構文サーバー）は参照検索と真に並行する
- **含意**: 並列化の利得には言語サーバー側の上限がある。タスク同時実行数の上限（例: 4）は妥当。
  並列化で得るのは主に「往復のオーバーラップ」と「構文系/意味系リクエストの並行」

## 注意事項

- フィクスチャが小規模（4ファイル）かつサーバーがウォームアップ済みのため、絶対値は参考程度。
  実コードベースでは1リクエストあたりの所要時間は大きくなるが、直列化の挙動自体は同じ
- 言語サーバーが異なる言語（例: TypeScript と C）同士なら、意味解析も含めて真に並行する
