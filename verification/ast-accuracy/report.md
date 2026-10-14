# 名前解決の精度検証レポート

`yarn verify:accuracy` が生成する（手で編集しない）。自リポジトリを拡張機能と同じ差分キューで調べ、
LSP 由来の関係（`table_relationships`）を正解として AST 由来の関係（`table_relationships_v2`）を突き合わせた結果。
比較の方法は `verification/ast-accuracy/README.md` を参照。

- 生成日時: 2026-10-08T13:42:50.468Z
- VS Code: 1.141.0
- 名前解決: 段1 ファイル内の定義・段2 import・段3 型推論・段4 一意名・段4' 曖昧候補
- 対象: 64 ファイル（処理 64）、シンボル 6,211（解決キー付き 2,950）
- 所要時間: 299 秒（LSP の参照検索を含む）

## 結果

| 指標 | 値 | 備考 |
| ---- | -- | ---- |
| **import 由来の関係の再現率** | **99.6%（513 / 515）** | Stage 2 の受け入れ基準（≥ 95%）。LSP の関係のうち定義がトップレベルのもの |
| **シンボル単位の再現率（確信度 ≥ 0.7）** | **92.3%（1,433 / 1,552）** | Stage 3 の受け入れ基準（≥ 90%） |
| **シンボル単位の適合率（確信度 ≥ 0.7）** | **98.8%（1,433 / 1,451）** | Stage 3 の受け入れ基準（≥ 90%） |
| ファイル単位の再現率 | 97.3%（142 / 146） | 参照元ファイル → 定義ファイル |
| ファイル単位の適合率 | 60.4%（142 / 235） | |

### 確信度の閾値ごと（シンボル単位）

| 確信度 | 再現率 | 適合率 |
| ------ | ------ | ------ |
| ≥ 0 | 94.2%（1,462 / 1,552） | 87.4%（1,462 / 1,673） |
| ≥ 0.5 | 93.8%（1,455 / 1,552） | 95.8%（1,455 / 1,518） |
| ≥ 0.7 | 92.3%（1,433 / 1,552） | 98.8%（1,433 / 1,451） |
| ≥ 0.9 | 41.7%（647 / 1,552） | 97.3%（647 / 665） |

### 解決の段ごとの適合率（関係の組の最大の確信度で分類）

| 段 | 適合率 |
| -- | ------ |
| 段1 ファイル内の定義（1.0） | －（ファイル間の関係なし） |
| 段2 import（0.95） | 97.3%（647 / 665） |
| 段3 型推論（0.8） | 100.0%（786 / 786） |
| 段4 一意名（0.6） | 34.4%（22 / 64） |
| 段4' 曖昧候補・モジュール単位（≤ 0.5） | 4.4%（7 / 158） |

LSP 由来の関係 8,239 件のうち、比較から除いたもの:

- 定義側が名前付きの宣言でない（構造的な参照）: 5,930 件。オブジェクトリテラルのメンバ・無名コールバックなど。
  TypeScript の構造的な型付けにより、インターフェースのプロパティへの参照が、それを満たすオブジェクトリテラルのメンバへの参照として記録される
- オブジェクトリテラルのキーによる参照（文脈による型付け）: 439 件。
  `const f: FileFacts = { definitions: … }` や `push({ id })` のキーが、代入先・引数・戻り値の型のプロパティへの参照として記録される。
  参照元にその名前がキーとしてだけ現れるものを数える（Stage 3 で構造的な参照として扱うと決めた）
- シンボルが解決キーに辿り着けない: 0 件

## AST 由来の関係の内訳

| 種類 | 件数 |
| ---- | ---- |
| read | 5,178 |
| call | 2,151 |
| type_reference | 597 |
| write | 293 |
| instantiation | 225 |
| import | 222 |
| inheritance | 2 |
| implementation | 1 |
| （合計） | 8,669（うちファイル内 5,957） |

## 解決の内訳（参照出現）

| 区分 | 件数 | 意味 |
| ---- | ---- | ---- |
| 段1 ファイル内の定義 | 3,264 | |
| 段2 import | 688 | うちモジュール単位 3（export 名の定義が見つからない） |
| 段3 型推論 | 2,709 | this・型注釈・new・戻り値・要素（反復・添字）・分割代入の取り出し元の型からメンバを引いた |
| 段4 一意名 | 135 | 型の分からない値のメンバ・束縛の無い名前を、プロジェクトで1つだけの同名の定義へ |
| 段4' 曖昧候補 | 128 | 同名の定義が2〜4個。各候補へ弱い関係（破棄 65） |
| import 文 | 222 | ファイル → 取り込んだ定義・モジュール |
| 自分自身・内側への参照 | 2,728 | 関係にしない |
| 型の分からないローカルな値のメンバ | 1,381 | 型注釈の無い引数・型の手掛かりの無い変数など。関係にしない |
| this / super | 4 | 囲むクラスかメンバが見つからない |
| ファイル内に束縛が無い | 997 | グローバル・組込み（段5 未解決） |
| オブジェクトリテラルのキー | 1,601 | 文脈の型のプロパティへの参照。名前では解決しない |
| プロジェクト外への import | 1,442 | |
| 解決できない import | 0 | |

## LSP のみが見つけた import 由来の関係（2 件）

| 参照元 | 定義 |
| ------ | ---- |
| `src/relationship/examine.ts#ExamineTask.computeUpsert.doc` | `src/test/astFacts.test.ts#doc` |
| `src/relationship/examine.ts#ExamineTask.extructSymbols` | `src/test/astFacts.test.ts#doc` |

## LSP のみが見つけたファイルの組（4 件）

型の手掛かりの無い値のメンバ参照、インターフェースを満たすオブジェクトリテラル（文脈による型付け）による依存、言語サーバがスクリプトのトップレベルの変数を別ファイルの同名の変数と結び付けたものなど。

| 参照元ファイル | 定義ファイル |
| -------------- | ------------ |
| `scripts/ast-assets.mjs` | `esbuild.js` |
| `src/relationship/cosmosAdapter.ts` | `src/relationship/hierarchicalLayout.ts` |
| `src/relationship/cosmosAdapter.unit.test.ts` | `src/relationship/hierarchicalLayout.ts` |
| `src/relationship/examine.ts` | `src/test/astFacts.test.ts` |

## AST のみが見つけたファイルの組（93 件）

LSP の経路が記録しない依存を含む: 再エクスポート（`export * from`）と、まとめ役の index への名前空間 import（LSP は元の定義のファイルへ帰属させる）、
言語サーバが扱わないファイル（JSON・tsconfig の対象外・`.mjs`）、LSP の参照検索の取りこぼし。

| 参照元ファイル | 定義ファイル | 関係の種類 |
| -------------- | ------------ | ---------- |
| `esbuild.js` | `src/relationship/examine.ts` | read |
| `esbuild.js` | `src/relationship/fileDifference/item.ts` | read |
| `esbuild.js` | `src/test/astAccuracy.verify.ts` | read |
| `esbuild.js` | `src/test/mocks/vscode.ts` | read |
| `src/bindingsAutoSign.unit.test.ts` | `src/bindingsAutoSign.ts` | import, call |
| `src/codeDb.ts` | `src/bindingsAutoSign.ts` | import, call |
| `src/codeDb.ts` | `src/relationship/communityDetection.ts` | read |
| `src/codeDb.ts` | `src/relationship/examine.ts` | read |
| `src/codeDb.ts` | `src/relationship/fileDifference/item.ts` | read |
| `src/codeDb.ts` | `src/test/mocks/vscode.ts` | read |
| `src/extension.ts` | `src/extruct/ast/index.ts` | import |
| `src/extension.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/extension.ts` | `src/extruct/symbol.ts` | read |
| `src/extension.ts` | `src/relationship/index.ts` | import |
| `src/extension.ts` | `src/test/mocks/vscode.ts` | read |
| `src/extension.ts` | `src/webview/graphView.ts` | write |
| `src/extruct/ast/index.ts` | `src/extruct/ast/factsExtractor.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/localFacts.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/moduleResolver.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/parser.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/relationshipKind.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/resources.ts` | import |
| `src/extruct/ast/localFacts.ts` | `src/distributor.unit.test.ts` | read |
| `src/extruct/ast/localFacts.ts` | `src/extruct/symbol.ts` | read |
| `src/extruct/ast/localFacts.ts` | `src/relationship/accuracy.ts` | read |
| `src/extruct/ast/localFacts.ts` | `src/relationship/communityDetection.ts` | read |
| `src/extruct/ast/localFacts.ts` | `src/relationship/resolve.ts` | read |
| `src/extruct/ast/localFacts.ts` | `src/test/mocks/vscode.ts` | read |
| `src/extruct/ast/parser.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/extruct/ast/parser.unit.test.ts` | `src/extruct/ast/factsExtractor.ts` | read |
| `src/extruct/ast/parser.unit.test.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/extruct/codeSymbols.ts` | `src/relationship/communityDetection.ts` | call |
| `src/extruct/codeSymbols.ts` | `src/relationship/hierarchicalLayout.ts` | call |
| `src/extruct/codeSymbols.ts` | `src/webview/graphView.ts` | call |
| `src/extruct/codeSymbols.unit.test.ts` | `src/test/mocks/vscode.ts` | read |
| `src/locale.ts` | `package.nls.ja.json` | import, read |
| `src/locale.ts` | `package.nls.json` | import, read |
| `src/relationship/codeRelationships.ts` | `src/test/mocks/vscode.ts` | call, read |
| `src/relationship/communityDetection.ts` | `src/webview/graphView.ts` | read |
| `src/relationship/cosmosAdapter.ts` | `src/webview/graphView.ts` | read |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/item.ts` | import |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/queue.ts` | import |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/symbolCache.ts` | import |
| `src/relationship/fileDifference/queue.ts` | `src/extruct/codeFiles.ts` | read |
| `src/relationship/fileDifference/queue.ts` | `src/test/astAccuracy.verify.ts` | read |
| `src/relationship/hierarchicalLayout.ts` | `src/webview/graphView.ts` | read, write |
| `src/relationship/index.ts` | `src/relationship/examine.ts` | import |
| `src/relationship/index.ts` | `src/relationship/fileDifference/index.ts` | import |
| `src/relationship/index.ts` | `src/relationship/visualization.ts` | import |
| `src/relationship/resolve.ts` | `src/extruct/symbol.ts` | read |
