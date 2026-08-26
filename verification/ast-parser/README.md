# AST パーサの同梱検証

`docs/ast-plan.md` Stage 0 の受け入れ基準

> `.vsix` を実機インストールして WASM がロードされる

を、配布物と同じ配置（`dist/wasm` / `dist/queries`）で自動確認する。

## 何を確かめるか

| # | 確認内容 |
| - | -------- |
| 1 | `dist/wasm/*.wasm` と `dist/queries/*.scm` が配置されている（各サイズと合計を表示） |
| 2 | `resolveAstResources(extensionPath)` が配布物の配置を指す |
| 3 | esbuild でバンドルした `AstParser` が本体 WASM を `locateFile` 経由でロードできる |
| 4 | TypeScript / TSX / JavaScript を構文エラー無しでパースし、クエリのキャプチャが取れる |
| 5 | 遅延ロードにより、使った言語文法だけがロードされている |
| 6 | 自リポジトリの `src/**/*.ts` を全てパースできる（パース時間の中央値・最大値も表示） |

`.vsix` は `--production`（minify 有効）でビルドされるため、3 と 4 は minify 有無の両方で確認する。

## 既知の限界

- ソースに制御文字（NUL 等）が含まれるファイルは tree-sitter が `ERROR` ノードにする。TypeScript は受け付けるため、検証では WARN として報告し失敗にはしない
  - 現状 `src/relationship/examine.ts` が該当する（関係のキーに NUL を区切り文字として使っている）

`.vsix` に含まれるのは `dist/` 配下だけなので、ここが通れば実機インストール時も同じ経路で動作する。
`.vsix` 自体の同梱確認は `npx vsce ls` で `dist/wasm/**` と `dist/queries/**` が列挙される事を見る。

## 実行

```bash
node esbuild.js                            # dist/ を生成（WASM とクエリのコピーを含む）
node verification/ast-parser/verify.cjs    # 検証
```

失敗時は終了コード 1 と原因を出力する。
