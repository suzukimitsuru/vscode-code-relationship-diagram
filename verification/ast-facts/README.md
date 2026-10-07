# AST の事実抽出の検証

`docs/ast-plan.md` Stage 1（Phase A: ローカル事実の抽出）の受け入れ基準

> 自リポジトリ全ファイルで occurrences が保存される / `fqn` がファイル内で一意 /
> パース時間 中央値 < 20ms/ファイル / v1 DB から無停止で移行できる

を、自リポジトリを対象に実測する。

## 実行

```bash
node verification/ast-facts/verify.cjs
```

`yarn verify:facts` でも実行できる。失敗時は終了コード 1 と原因を出力する。

## 何を確かめるか

| # | 確認内容 |
| - | -------- |
| 1 | 拡張機能と同じ規則（`files.associations` 相当 + `.gitignore`）で自リポジトリの TS/JS を列挙する |
| 2 | 全ファイルの事実（定義・import 束縛・参照出現）を `FactsExtractor` で抽出する |
| 3 | 各ファイルの定義の `fqn` がファイル内で重複しない |
| 4 | 事実を DuckDB へ保存して読み戻し、件数が抽出結果と一致する。`facts_version` が記録される |
| 5 | 1ファイルあたりの処理時間（パース + 抽出 + import 解決）の中央値が 20ms 未満 |
| 6 | `exsample-workspace/.vscode/crd.duckdb`（拡張機能が作った実際の v1 DB）を**複製して**移行し、行数が保たれ最新の版数になる |

拡張機能と同じモジュール（`src/extruct/ast` / `src/codeDb` / `src/extruct/codeFiles`）を esbuild でバンドルして使う。
`codeDb` は `bindings/` を「バンドルの親ディレクトリ」から探すため、バンドルは `out/`（gitignore 済み）へ出力する。
`vscode` モジュールは単体テスト用のスタブ（`src/test/mocks/vscode.ts`）に置き換える。

DuckDB は一時ディレクトリに作り、検証後に削除する。リポジトリ内の DB には書き込まない。

## 出力の読み方

```text
files               59 (javascript 8, typescript 51)
saved               59/59 files (occurrences and imports match), facts_version=1 on 59 files
definitions         2146 (exported 126), fqn duplicated in 0 files
imports             305 (in project 169, external 136, unresolved 0)
occurrences         8641
  by kind           inheritance 4, instantiation 351, call 2892, type_reference 726, read 4295, write 373
  by binding        module 2051, local 4804, unbound 830, this/super 956
elapsed (ms/file)   median 1.3, p95 5.9, max 15.9  (parse + extract + resolve imports, 57 files)
  first per grammar javascript 36.3ms (esbuild.js), typescript 68.5ms (src/bindingsAutoSign.ts)
migration v1 -> v2  5ms, rows files/symbols/relationships 3/14/5 -> 3/14/5
AST facts verification: PASSED
```

| 行 | 意味 |
| -- | ---- |
| `imports` | `in project` = ワークスペース内のファイルへ解決、`external` = パッケージ・組込み、`unresolved` = 相対指定だが見つからない |
| `by binding` | 参照出現の根の名前を束縛している場所（`scope_id`）。`module` = import かトップレベルの定義、`local` = 関数内などのローカル、`unbound` = ファイル内に束縛が無い（グローバル・組込み） |
| `elapsed` | 文法ごとの最初の1ファイルを除いた値。最初の1ファイルは文法 WASM の遅延ロードとクエリのコンパイルを含むため `first per grammar` に分けて表示する |

## 言語サーバとの突き合わせ

AST の定義が言語サーバ（tsserver）のシンボルに付くか（`attachAstKeys`）は、言語サーバが無いと測れないため
統合テスト `src/test/astFacts.test.ts`（`yarn test`）で確かめる。
