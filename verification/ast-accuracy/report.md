# 名前解決の精度検証レポート

`yarn verify:accuracy` が生成する（手で編集しない）。自リポジトリを拡張機能と同じ差分キューで調べ、
LSP 由来の関係（`table_relationships`）を正解として AST 由来の関係（`table_relationships_v2`）を突き合わせた結果。
値は、確信度が閾値（0.7）未満の関係を LSP の定義の問い合わせで確定した後のもの（Stage 4 の既定の動作）。確定する前の値は「LSP による確定」の節に出す。
比較の方法は `verification/ast-accuracy/README.md` を参照。

- 生成日時: 2026-10-15T18:16:00.605Z
- VS Code: 1.142.0
- 名前解決: 段1 ファイル内の定義・段2 import・段3 型推論・段4 一意名・段4' 曖昧候補、確信度 0.7 未満は LSP で確定
- 対象: 70 ファイル（処理 70）、シンボル 6,852（解決キー付き 3,261）
- 所要時間: 312 秒（LSP の参照検索を含む）

## 結果

| 指標 | 値 | 備考 |
| ---- | -- | ---- |
| **import 由来の関係の再現率** | **99.5%（640 / 643）** | Stage 2 の受け入れ基準（≥ 95%）。LSP の関係のうち定義がトップレベルのもの |
| **シンボル単位の再現率（確信度 ≥ 0.7）** | **92.5%（1,737 / 1,877）** | Stage 3 の受け入れ基準（≥ 90%） |
| **シンボル単位の適合率（確信度 ≥ 0.7）** | **99.2%（1,737 / 1,751）** | Stage 3 の受け入れ基準（≥ 90%） |
| ファイル単位の再現率 | 96.9%（189 / 195） | 参照元ファイル → 定義ファイル |
| ファイル単位の適合率 | 74.1%（189 / 255） | |

### 確信度の閾値ごと（シンボル単位）

| 確信度 | 再現率 | 適合率 |
| ------ | ------ | ------ |
| ≥ 0 | 92.8%（1,741 / 1,877） | 94.8%（1,741 / 1,836） |
| ≥ 0.5 | 92.6%（1,739 / 1,877） | 98.3%（1,739 / 1,769） |
| ≥ 0.7 | 92.5%（1,737 / 1,877） | 99.2%（1,737 / 1,751） |
| ≥ 0.9 | 44.8%（841 / 1,877） | 98.4%（841 / 855） |

### 解決の段ごとの適合率（関係の組の最大の確信度で分類）

| 段 | 適合率 |
| -- | ------ |
| 段1 ファイル内の定義（1.0） | －（ファイル間の関係なし） |
| LSP で確定（0.99） | 100.0%（47 / 47） |
| 段2 import（0.95） | 98.3%（794 / 808） |
| 段3 型推論（0.8） | 100.0%（896 / 896） |
| 段4 一意名（0.6） | 13.3%（2 / 15） |
| 段4' 曖昧候補・モジュール単位（≤ 0.5） | 2.9%（2 / 70） |

### LSP による確定（docs/ast-plan.md §7.4）

確信度 0.7 未満の関係を、参照出現の位置 × 定義の名前ごとに言語サーバへ問い合わせ（264 回）、409 件を消して 106 件を確信度 0.99 で加えた。

| 結果 | 件数 | 意味 |
| ---- | ---- | ---- |
| 候補を確定 | 102 | 返った定義が候補のどれか |
| 置き換え | 5 | 返った定義が候補に無い |
| 消した | 119 | 定義がプロジェクトの外（組込み・パッケージ） |
| 答え無し | 38 | 言語サーバが定義を返さなかった（関係はそのまま） |
| 位置が見つからない | 24 | ソース中に名前が見つからず問い合わせなかった |

| 確信度 | 再現率（確定前） | 適合率（確定前） | 再現率（確定後） | 適合率（確定後） |
| ------ | ---------------- | ---------------- | ---------------- | ---------------- |
| ≥ 0 | 92.8%（1,741 / 1,877） | 89.6%（1,741 / 1,944） | 92.8%（1,741 / 1,877） | 94.8%（1,741 / 1,836） |
| ≥ 0.5 | 92.3%（1,732 / 1,877） | 96.9%（1,732 / 1,788） | 92.6%（1,739 / 1,877） | 98.3%（1,739 / 1,769） |
| ≥ 0.7 | 90.6%（1,701 / 1,877） | 99.2%（1,701 / 1,715） | 92.5%（1,737 / 1,877） | 99.2%（1,737 / 1,751） |
| ≥ 0.9 | 42.3%（794 / 1,877） | 98.3%（794 / 808） | 44.8%（841 / 1,877） | 98.4%（841 / 855） |

LSP 由来の関係 10,710 件のうち、比較から除いたもの:

- 定義側が名前付きの宣言でない（構造的な参照）: 7,843 件。オブジェクトリテラルのメンバ・無名コールバックなど。
  TypeScript の構造的な型付けにより、インターフェースのプロパティへの参照が、それを満たすオブジェクトリテラルのメンバへの参照として記録される
- オブジェクトリテラルのキーによる参照（文脈による型付け）: 558 件。
  `const f: FileFacts = { definitions: … }` や `push({ id })` のキーが、代入先・引数・戻り値の型のプロパティへの参照として記録される。
  参照元にその名前がキーとしてだけ現れるものを数える（Stage 3 で構造的な参照として扱うと決めた）
- シンボルが解決キーに辿り着けない: 0 件

## AST 由来の関係の内訳

| 種類 | 件数 |
| ---- | ---- |
| read | 5,663 |
| call | 2,501 |
| type_reference | 671 |
| import | 285 |
| instantiation | 284 |
| write | 274 |
| inheritance | 2 |
| implementation | 1 |
| （合計） | 9,681（うちファイル内 6,640） |

## 解決の内訳（参照出現）

| 区分 | 件数 | 意味 |
| ---- | ---- | ---- |
| 段1 ファイル内の定義 | 3,753 | |
| 段2 import | 855 | うちモジュール単位 3（export 名の定義が見つからない） |
| 段3 型推論 | 3,015 | this・型注釈・new・戻り値・要素（反復・添字）・分割代入の取り出し元の型からメンバを引いた |
| 段4 一意名 | 146 | 型の分からない値のメンバ・束縛の無い名前を、プロジェクトで1つだけの同名の定義へ |
| 段4' 曖昧候補 | 128 | 同名の定義が2〜4個。各候補へ弱い関係（破棄 74） |
| import 文 | 285 | ファイル → 取り込んだ定義・モジュール |
| 自分自身・内側への参照 | 2,812 | 関係にしない |
| 型の分からないローカルな値のメンバ | 1,499 | 型注釈の無い引数・型の手掛かりの無い変数など。関係にしない |
| this / super | 8 | 囲むクラスかメンバが見つからない |
| ファイル内に束縛が無い | 1,047 | グローバル・組込み（段5 未解決） |
| オブジェクトリテラルのキー | 1,852 | 文脈の型のプロパティへの参照。名前では解決しない |
| プロジェクト外への import | 1,592 | |
| 解決できない import | 0 | |

## LSP のみが見つけた import 由来の関係（3 件）

| 参照元 | 定義 |
| ------ | ---- |
| `esbuild.js#main.copyAstAssets` | `scripts/ast-assets.mjs#copyAstAssets` |
| `src/relationship/examine.ts#ExamineTask.computeUpsert.doc` | `src/test/astFacts.test.ts#doc` |
| `src/relationship/examine.ts#ExamineTask.extructSymbols` | `src/test/astFacts.test.ts#doc` |

## LSP のみが見つけたファイルの組（6 件）

型の手掛かりの無い値のメンバ参照、インターフェースを満たすオブジェクトリテラル（文脈による型付け）による依存、言語サーバがスクリプトのトップレベルの変数を別ファイルの同名の変数と結び付けたものなど。

| 参照元ファイル | 定義ファイル |
| -------------- | ------------ |
| `esbuild.js` | `scripts/ast-assets.mjs` |
| `scripts/ast-assets.mjs` | `esbuild.js` |
| `src/relationship/astRelationships.unit.test.ts` | `src/test/examineWorkspace.ts` |
| `src/relationship/cosmosAdapter.ts` | `src/relationship/hierarchicalLayout.ts` |
| `src/relationship/cosmosAdapter.unit.test.ts` | `src/relationship/hierarchicalLayout.ts` |
| `src/relationship/examine.ts` | `src/test/astFacts.test.ts` |

## AST のみが見つけたファイルの組（66 件）

LSP の経路が記録しない依存を含む: 再エクスポート（`export * from`）と、まとめ役の index への名前空間 import（LSP は元の定義のファイルへ帰属させる）、
言語サーバが扱わないファイル（JSON・tsconfig の対象外・`.mjs`）、LSP の参照検索の取りこぼし。

| 参照元ファイル | 定義ファイル | 関係の種類 |
| -------------- | ------------ | ---------- |
| `src/extension.ts` | `src/extruct/ast/index.ts` | import |
| `src/extension.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/extension.ts` | `src/extruct/symbol.ts` | read |
| `src/extension.ts` | `src/relationship/index.ts` | import |
| `src/extension.ts` | `src/test/astAccuracy.verify.ts` | read |
| `src/extension.ts` | `src/test/astSwitch.verify.ts` | read |
| `src/extension.ts` | `src/test/mocks/vscode.ts` | read |
| `src/extruct/ast/index.ts` | `src/extruct/ast/factsExtractor.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/localFacts.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/moduleResolver.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/parser.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/relationshipKind.ts` | import |
| `src/extruct/ast/index.ts` | `src/extruct/ast/resources.ts` | import |
| `src/extruct/ast/parser.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/extruct/codeSymbols.ts` | `src/relationship/communityDetection.ts` | call |
| `src/extruct/codeSymbols.ts` | `src/relationship/hierarchicalLayout.ts` | call |
| `src/extruct/codeSymbols.ts` | `src/webview/graphView.ts` | call |
| `src/extruct/codeSymbols.unit.test.ts` | `src/test/mocks/vscode.ts` | read |
| `src/locale.ts` | `package.nls.ja.json` | import, read |
| `src/locale.ts` | `package.nls.json` | import, read |
| `src/relationship/astRelationships.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/relationship/astRelationships.ts` | `src/test/mocks/vscode.ts` | read |
| `src/relationship/communityDetection.ts` | `src/webview/graphView.ts` | read |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/item.ts` | import |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/queue.ts` | import |
| `src/relationship/fileDifference/index.ts` | `src/relationship/fileDifference/symbolCache.ts` | import |
| `src/relationship/index.ts` | `src/relationship/astRelationships.ts` | import |
| `src/relationship/index.ts` | `src/relationship/examine.ts` | import |
| `src/relationship/index.ts` | `src/relationship/fileDifference/index.ts` | import |
| `src/relationship/index.ts` | `src/relationship/visualization.ts` | import |
| `src/relationship/lspVerification.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/relationship/lspVerification.ts` | `src/extruct/symbol.ts` | read |
| `src/relationship/lspVerification.ts` | `src/test/mocks/vscode.ts` | read |
| `src/relationship/visualization.ts` | `src/webview/graphView.ts` | read |
| `src/test/astAccuracy.verify.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/astFacts.test.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/astParser.test.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/examineWorkspace.ts` | `src/extruct/ast/index.ts` | import |
| `src/test/setup/astAssets.mjs` | `scripts/ast-assets.mjs` | import, call |
| `src/webview/graphView.ts` | `src/extruct/ast/localFacts.ts` | read |
| `src/webview/graphView.ts` | `src/extruct/ast/parser.ts` | read |
| `src/webview/graphView.ts` | `src/relationship/codeRelationships.ts` | read |
| `src/webview/graphView.ts` | `src/relationship/communityDetection.ts` | read |
| `src/webview/graphView.ts` | `src/relationship/cosmosAdapter.ts` | call |
| `verification/ast-facts/verify.cjs` | `src/extruct/ast/factsExtractor.ts` | call, read |
| `verification/ast-facts/verify.cjs` | `src/extruct/ast/localFacts.ts` | read |
| `verification/ast-facts/verify.cjs` | `src/extruct/ast/moduleResolver.ts` | read |
| `verification/ast-facts/verify.cjs` | `src/extruct/codeFiles.ts` | call, read |
| `verification/ast-facts/verify.cjs` | `src/extruct/symbol.ts` | read |
| `verification/ast-facts/verify.cjs` | `src/relationship/accuracy.ts` | read |
