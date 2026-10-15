# 主経路の切替の検証

`docs/ast-plan.md` Stage 4 の検証ハーネス。受け入れ基準

> 自リポジトリの `examineRelationships` 実行時間が現行比 ≤ 50% / 言語サーバ未導入の状態でも TS/JS の関係が出る / 旧経路へのロールバックが動く

を、自リポジトリを対象に実測する。結果は [report.md](./report.md) と [no-lsp.md](./no-lsp.md)（生成物。手で編集しない）。

## 実行

```bash
yarn verify:switch
```

テストをコンパイルし（`compile-tests`）、`dist/` を作り（`esbuild.js`）、VS Code の拡張機能ホストで2回実行する。

| ラベル（`.vscode-test.mjs`） | ファイル | VS Code の起動 | 出力 |
| ---------------------------- | -------- | -------------- | ---- |
| `switch` | `src/test/astSwitch.verify.ts` | 通常 | `report.md`、調査に使った DB は `out/verify-switch/` |
| `nolsp` | `src/test/astNoLsp.verify.ts` | `--disable-extension=vscode.typescript-language-features`（tsserver を起動しない） | `no-lsp.md`、DB は `out/verify-no-lsp/` |

LSP の参照検索を全シンボルに対して2回（初回の LSP の経路・ロールバック）行うため 10 分ほどかかる。基準を下回ると失敗し、終了コードが 0 以外になる。

**実行中にリポジトリの TS/JS を編集しない事**（`verification/ast-accuracy/` と同じ理由）。

## 何をしているか

### `switch`

1. 言語サーバ（tsserver）がプロジェクトを読み終えるまで待つ。どちらの経路もシンボルの抽出に言語サーバを使うため、起動の時間を比較に含めない
2. 空の DB を2つ作り、自リポジトリの TS/JS を拡張機能と同じ差分キュー（`QueueProcessor`）で調べる
   - AST の経路（設定 `codeRelationshipDiagram.ast.enabled = true`）: シンボルの抽出 + 事実の抽出 → 名前解決 → 確信度 0.7 未満の LSP による確定
   - LSP の経路（`false`。Stage 3 までの動作）: シンボルの抽出 + LSP の参照検索 + 事実の抽出 → 名前解決
3. 全走査でキューに積んでから、キューが空になって名前解決（と LSP による確定）を終えるまでの時間を比べる
4. AST の経路で調べた DB を `ast.enabled = false` で全走査し（ロールバック）、さらに `true` で全走査する（再切り替え）。
   内容が変わっていなくても、記録した調査経路（`table_files.relationship_mode`）が設定と異なるファイルは調べ直される
5. 図に表示する関係（`queryDiagramRelationships()`。拡張機能の `showDiagram` と同じ読み方）を調査ごとに読み、
   LSP 由来・AST 由来の件数と、図のファイル間の線（参照元ファイル → 定義ファイル）を比べる

| 確かめる事 | 基準 |
| ---------- | ---- |
| 時間 | AST の経路 ≤ LSP の経路 × 50% |
| 経路ごとの図の関係 | AST の経路は AST 由来だけ、LSP の経路は LSP 由来だけ（自リポジトリは TS/JS だけのため） |
| ロールバック | 全ファイルを調べ直し、図の関係が LSP 由来だけになる。ファイル間の線が初回の LSP の経路と 95% 以上一致する（共通部分 / 和集合。LSP の参照検索は実行ごとに揺れるため完全一致にしない） |
| 再切り替え | 全ファイルを調べ直し、図の関係が AST 由来だけになる。ファイル間の線が初回の AST の経路と 95% 以上一致する |

### `nolsp`

TypeScript の言語機能を無効にした VS Code で、自リポジトリを AST の経路と LSP の経路で調べる。

| 確かめる事 | 基準 |
| ---------- | ---- |
| 言語サーバが無い | `vscode.typescript-language-features` が無効で、ルートシンボル（ファイル）以外のシンボルが抽出されない |
| AST の経路 | 図にファイル間の線が出る（言語サーバのシンボルが無いため、関係はファイル同士の線になる） |
| LSP の経路 | 図の関係が 0 件（比較のため） |
