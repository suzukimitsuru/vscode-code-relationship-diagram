# AST パーサの同梱検証

`docs/ast-plan.md` Stage 0 の受け入れ基準

> `.vsix` を実機インストールして WASM がロードされる

を、配布物と同じ配置（`dist/wasm` / `dist/queries`）で自動確認する。

`.vsix` に含まれるのは `dist/` 配下だけであり、拡張機能は
`resolveAstResources(context.extensionPath)` で `<拡張機能のルート>/dist` を指す。
つまり検証スクリプトが使う配置とインストール後の配置は同一なので、ここが通れば
実機でも同じ経路で動作する。

## 実行

```bash
node esbuild.js                            # dist/ を生成（WASM とクエリのコピーを含む）
node verification/ast-parser/verify.cjs    # 検証
```

`yarn verify:ast` で両方まとめて実行できる。失敗時は終了コード 1 と原因を出力する。

## 何を確かめるか

| # | 確認内容 |
| - | -------- |
| 1 | `dist/wasm/*.wasm` と `dist/queries/*.scm` が配置されている（各サイズと合計を表示） |
| 2 | `dist/extension.js` が ESM 版の web-tree-sitter を巻き込んでいない（`import.meta` を含まない） |
| 3 | esbuild でバンドルした `AstParser` が本体 WASM を `locateFile` 経由でロードできる |
| 4 | TypeScript / TSX / JavaScript を構文エラー無しでパースし、クエリのキャプチャが取れる |
| 5 | 遅延ロードにより、使った言語文法だけがロードされている |
| 6 | 自リポジトリの `src/**/*.ts` を全てパースできる（パース時間の中央値・最大値も表示） |

`.vsix` は `--production`（minify 有効）でビルドされるため、3〜5 は minify 有無の両方で確認する。

### 2 が要る理由

web-tree-sitter は ESM 版と CJS 版の両方を公開している。ESM 版は
`createRequire(import.meta.url)` で WASM を読むため、CJS へバンドルすると
`import.meta.url` が undefined になり `Parser.init()` が失敗する。
`src/extruct/ast/parser.ts` は `import = require` で読み込む事で esbuild に
CJS 版を選ばせている。この検証はその前提が崩れていない事を見張る。

## `.vsix` への同梱確認

```bash
npx vsce ls
```

以下が列挙されれば同梱されている（`.vscodeignore` の対象外である事の確認）。

```text
dist/extension.js
dist/webview/graphView.js
dist/wasm/web-tree-sitter.wasm
dist/wasm/tree-sitter-typescript.wasm
dist/wasm/tree-sitter-tsx.wasm
dist/wasm/tree-sitter-javascript.wasm
dist/queries/typescript.scm
dist/queries/javascript.scm
```

## 既知の限界

- ソースに制御文字（NUL 等）を含むファイルは tree-sitter が `ERROR` ノードにする。
  TypeScript は受け付けるため、検証では WARN として報告し失敗にはしない
  - 現状 `src/relationship/examine.ts` が該当する（関係のキーに NUL を区切り文字として使っている）
