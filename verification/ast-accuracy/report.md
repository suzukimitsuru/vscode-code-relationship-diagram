# 名前解決の精度検証レポート

`yarn verify:accuracy` が生成する（手で編集しない）。自リポジトリを拡張機能と同じ差分キューで調べ、
LSP 由来の関係（`table_relationships`）を正解として AST 由来の関係（`table_relationships_v2`）を突き合わせた結果。
比較の方法は `verification/ast-accuracy/README.md` を参照。

- 生成日時: 2026-10-07T16:12:28.388Z
- VS Code: 1.141.0
- 名前解決の版数: Stage 2（段1 ファイル内の定義 + 段2 import）
- 対象: 64 ファイル（処理 64）、シンボル 5,537（解決キー付き 2,512）
- 所要時間: 283 秒（LSP の参照検索を含む）

## 結果

| 指標 | 値 | 備考 |
| ---- | -- | ---- |
| **import 由来の関係の再現率** | **100.0%（465 / 465）** | Stage 2 の受け入れ基準（≥ 95%）。LSP の関係のうち定義がトップレベルのもの |
| ファイル単位の再現率 | 96.5%（139 / 144） | 参照元ファイル → 定義ファイル |
| ファイル単位の適合率 | 83.7%（139 / 166） | |
| シンボル単位の再現率（全て） | 31.0%（512 / 1,653） | メンバの参照（`db.query()` のようなインスタンス経由）を含む。Stage 3 の型推論の対象 |
| シンボル単位の適合率 | 96.1%（512 / 533） | AST のファイル間の関係のうち LSP にもあるもの |

LSP 由来の関係 7,433 件のうち、比較から除いたもの:

- 定義側が名前付きの宣言でない（構造的な参照）: 5,380 件。オブジェクトリテラルのメンバ・無名コールバックなど。
  TypeScript の構造的な型付けにより、インターフェースのプロパティへの参照が、それを満たすオブジェクトリテラルのメンバへの参照として記録される
- シンボルが解決キーに辿り着けない: 0 件

## AST 由来の関係の内訳

| 種類 | 件数 |
| ---- | ---- |
| read | 1,612 |
| call | 1,103 |
| type_reference | 522 |
| import | 219 |
| instantiation | 110 |
| write | 47 |
| inheritance | 2 |
| implementation | 1 |
| （合計） | 3,616（うちファイル内 2,723） |

## 解決の内訳（参照出現）

| 区分 | 件数 | 意味 |
| ---- | ---- | ---- |
| 段1 ファイル内の定義 | 2,698 | |
| 段2 import | 613 | うちモジュール単位 3（export 名の定義が見つからない） |
| import 文 | 219 | ファイル → 取り込んだ定義・モジュール |
| 自分自身・内側への参照 | 2,489 | 関係にしない |
| 定義でないローカル束縛 | 3,083 | 引数・分割代入の変数など。関係にしない |
| this / super | 1,010 | Stage 3（レシーバ型の推論） |
| ファイル内に束縛が無い | 925 | グローバル・組込み。Stage 3（段4/5） |
| プロジェクト外への import | 1,356 | |
| 解決できない import | 0 | |

## LSP のみが見つけた import 由来の関係（0 件）

なし

## LSP のみが見つけたファイルの組（5 件）

インスタンス経由のメンバ参照や、インターフェースを満たすオブジェクトリテラル（文脈による型付け）による依存は、Stage 3 の型推論の対象。

| 参照元ファイル | 定義ファイル |
| -------------- | ------------ |
| `src/codeDb.unit.test.ts` | `src/extruct/ast/localFacts.ts` |
| `src/codeDb.unit.test.ts` | `src/extruct/ast/moduleResolver.ts` |
| `src/relationship/fileDifference/queue.unit.test.ts` | `src/relationship/fileDifference/item.ts` |
| `src/test/astAccuracy.verify.ts` | `src/relationship/fileDifference/item.ts` |
| `src/test/astFacts.test.ts` | `src/extruct/symbol.ts` |

## AST のみが見つけたファイルの組（27 件）

LSP の経路が記録しない依存を含む: 再エクスポート（`export * from`）と、まとめ役の index への名前空間 import（LSP は元の定義のファイルへ帰属させる）、
言語サーバが扱わないファイル（JSON・tsconfig の対象外・`.mjs`）、LSP の参照検索の取りこぼし。

| 参照元ファイル | 定義ファイル | 関係の種類 |
| -------------- | ------------ | ---------- |
| `src/bindingsAutoSign.unit.test.ts` | `src/bindingsAutoSign.ts` | import, call |
| `src/codeDb.ts` | `src/bindingsAutoSign.ts` | import, call |
| `src/extension.ts` | `src/extruct/ast/index.ts` | import |
| `src/extension.ts` | `src/relationship/index.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/factsExtractor.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/localFacts.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/moduleResolver.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/parser.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/relationshipKind.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/resources.ts` | import |
| `src/locale.ts` | `package.nls.ja.json` | import, read |
| `src/locale.ts` | `package.nls.json` | import, read |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/item.ts` | import |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/queue.ts` | import |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/symbolCache.ts` | import |
| `src/relationship/index.ts` | `src/relationship/examine.ts` | import |
| `src/relationship/index.ts` | `src/relationship/fileDifference/index.ts` | import |
| `src/relationship/index.ts` | `src/relationship/visualization.ts` | import |
| `src/test/astAccuracy.verify.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/astFacts.test.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/astParser.test.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/setup/astAssets.mjs` | `scripts/ast-assets.mjs` | import, call |
| `verification/lsp-parallel/fixture/user1.ts` | `verification/lsp-parallel/fixture/defs.ts` | import, call |
| `verification/lsp-parallel/fixture/user2.ts` | `verification/lsp-parallel/fixture/defs.ts` | import, call |
| `verification/lsp-parallel/fixture/user2.ts` | `verification/lsp-parallel/fixture/user1.ts` | import, call |
| `verification/lsp-parallel/fixture/user3.ts` | `verification/lsp-parallel/fixture/defs.ts` | import, call |
| `verification/lsp-parallel/fixture/user3.ts` | `verification/lsp-parallel/fixture/user2.ts` | import, call |
