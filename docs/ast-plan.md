# AST導入計画

CRD の依存抽出を **VSCode LSP 主体から AST（tree-sitter）主体へ移行**するための実装計画。

- 本書は `docs/analysis-plan.md`「計画1: ASTを考慮した関係の種類と強さの調査」の**詳細化および方式改訂**である
- 計画2（複雑性メトリクス）は本書の Stage 1 で構築する AST 基盤をそのまま利用する
- 計画3（描画再設計）は本書が出力する `kind` / `strength` / `confidence` を入力とする

## ロードマップページ

進捗（現在位置・進捗メーター・更新履歴）は `docs/ast-plan.html` で見る。
GitHub は HTML をソースのまま表示するため、以下のいずれかで開く。

| 見方 | URL / 手順 |
| ---- | ---------- |
| ブラウザで表示（推奨） | [htmlpreview で開く](https://htmlpreview.github.io/?https://github.com/suzukimitsuru/vscode-code-relationship-diagram/blob/main/docs/ast-plan.html) |
| 同上（別サービス） | <https://raw.githack.com/suzukimitsuru/vscode-code-relationship-diagram/main/docs/ast-plan.html> |
| ローカル | `open docs/ast-plan.html`（Windows は `start`、Linux は `xdg-open`） |
| ソース | [docs/ast-plan.html](./ast-plan.html) |

> 上記2つは公開リポジトリを前提とした外部サービス経由の表示である。
> GitHub Pages（設定 → Pages で `main` / `docs` を公開）を有効にすれば
> `https://suzukimitsuru.github.io/vscode-code-relationship-diagram/ast-plan.html`
> で直接開けるようになる。本リポジトリでは未設定。

---

## 0. 方式の改訂点（計画1 からの差分）

| 論点 | 計画1（当初案） | 本計画（改訂） |
| ---- | -------------- | -------------- |
| AST の役割 | ReferenceProvider が返した参照位置に**種類を注釈する**補助 | **依存抽出そのものを AST が担う**（LSP は検証・フォールバックへ降格） |
| 抽出の向き | 定義 → 参照（`executeReferenceProvider` で逆引き） | 参照 → 定義（AST で参照出現を網羅 → 名前解決） |
| 種類判定 | 参照位置を包含するノードの祖先を辿る | tree-sitter クエリの**キャプチャ名がそのまま kind** |
| 関係のキー | シンボルID（内容ハッシュ入り） | **fqn（内容ハッシュを含まない完全修飾名）** |
| 精度の表現 | kind + weight | kind + weight + **confidence（解決段階由来の確信度）** |

改訂の理由は §2 の限界と、§5.1 の fan-out 問題にある。

---

## 1. 目的と非目的

### 目的

1. 依存抽出を**言語サーバの起動状態・応答速度から独立**させ、再現性と速度を確保する
2. 関係に **種類（kind）・強さ（strength）・確信度（confidence）** を付与する
3. シンボル本文の変更で関係が失効する現状の設計（fan-out 肥大化）を解消する
4. 計画2（メトリクス）が乗る AST 基盤を同時に整備する

### 非目的

- 型チェッカ相当の完全な名前解決（動的ディスパッチ・DI・リフレクションは原理的に解決不能。§14）
- シンボル抽出（`DocumentSymbolProvider`）の置き換え（§3.3）
- 描画の刷新（計画3 の範囲）

---

## 2. 現状方式と限界

`src/relationship/codeRelationships.ts` の `examine()` は「定義側シンボル → 全参照を逆引き」で動く。

| # | 限界 | 根拠 |
| - | ---- | ---- |
| 1 | 遅い・不安定 | シンボル1個ごとに LSP 往復。`examineWithRetry()` は最大3回 + 1秒 sleep |
| 2 | 参照元シンボルの特定が粗い | `findSymbol()` は範囲を含む最後の一致を線形探索。ネスト時に取り違える |
| 3 | ファイル内依存を捨てている | `ref_path !== def_symbol.path` で自己ファイル参照を除外 |
| 4 | 種類・強さが無い | `Relationship` は (reference, define) のペアのみ |
| 5 | fan-out が過大 | シンボルIDに内容ハッシュを含むため、**本文を1文字変えるだけでID が変わり**、参照元ファイル全体が再調査対象になる（`examine.ts` の `fanout_source_ids`） |
| 6 | 言語サーバ依存 | 拡張未導入の言語は関係ゼロ。コールドスタート時に空を返すためリトライが必要（`extructSymbols()`） |

---

## 3. 方式決定

### 3.1 パーサ: web-tree-sitter（WASM）

| 方式 | 判定 | 理由 |
| ---- | ---- | ---- |
| **web-tree-sitter（WASM）** | **採用** | 多言語・ネイティブビルド不要。duckdb バインディングで既に苦労しているため、プラットフォーム別 `.node` を増やさない事を重視 |
| tree-sitter（ネイティブ binding） | 不採用 | プラットフォーム × Node ABI のビルド・署名が必要（`bindingsAutoSign.ts` と同じ負債の再生産） |
| TypeScript Compiler API | 将来の任意オプション | TS/JS のみだが型情報まで取れる。Stage 3 の型推論精度が不足した場合の強化案として保留 |
| VSCode Semantic Tokens | 不採用 | 構文木が取れない |

### 3.2 役割分担: AST 主・LSP 補助

| 役割 | 現状 | 移行後 |
| ---- | ---- | ------ |
| 参照出現の網羅 | `executeReferenceProvider`（定義→参照） | **tree-sitter** |
| 定義の確定 | 同上 | tree-sitter の多段名前解決 |
| LSP の使途 | 全依存の抽出 | **confidence が閾値未満の出現のみ** `executeDefinitionProvider`（参照→定義、原則1往復で確定） |
| 文法未対応言語 | — | 従来経路にフォールバック（`kind = unknown`） |

向きが逆転する点が重要である。AST 側で参照位置が既知なので、LSP には「この位置の定義はどこか」を聞くだけでよく、全シンボル総当たり + リトライ sleep が不要になる。

### 3.3 シンボル抽出は現状維持

AST からは定義も取れるが、`src/extruct/codeSymbols.ts` の置き換えは**行わない**。既存のID体系・差分分配・多言語カバレッジが動作しているため、AST 由来の定義は「既存シンボルに `fqn` と `export_name` を後付けする対応表」として使い、変更リスクを依存抽出側に閉じ込める。

---

## 4. アーキテクチャ: 3フェーズ

依存抽出を「ローカル事実の抽出」と「グローバル名前解決」に分離する。前者はファイル単位で独立するため既存の並列キューにそのまま乗り、後者は DuckDB の JOIN に落とせる。

```text
Phase A: ローカル解析（ファイル単位・並列・中断可能）  ← 既存 computeUpsert() の位置
  tree-sitter パース1回で以下を同時に取得
    ├ defs         : 定義ノード → fqn / export_name の対応表
    ├ imports      : import/require の束縛表
    ├ occurrences  : 識別子出現（構文文脈・囲む定義付き）
    └ metrics      : （計画2）同一走査で複雑性指標を算出
        ↓ DuckDB へファイル単位で置換書き込み
Phase B: グローバル名前解決（変更分のみ・SQL の JOIN）
    occurrences × imports × defs → (reference_fqn → define_fqn, kind, confidence)
    低 confidence のみ LSP DefinitionProvider で確定
        ↓
Phase C: 集約（VIEW）
    fqn ペアごとに strength = Σ(kind重み × confidence)
        ↓ 表示時に fqn → 現在の symbol_id を join
```

---

## 5. データモデル（スキーマ v2）

### 5.1 fqn の導入（本計画の要）

関係を**内容ハッシュ入りの `id` ではなく `fqn` で保持**する。

- `fqn` の形式: `src/relationship/examine.ts#ExamineTask.computeUpsert`（`path` + `#` + 定義の入れ子名）
- 効果: 関数の中身を書き換えても `fqn` は不変 → **関係が失効しない**。再解決が必要なのは「シグネチャ・export・import が変わったとき」だけになり、§2 の限界5（fan-out 肥大化）が解消する
- 表示時に `table_symbols.fqn` で join して現在の `id` を得る

### 5.2 スキーマ

```sql
CREATE TABLE IF NOT EXISTS table_schema_version (version INTEGER);

-- 既存テーブルへの追加
ALTER TABLE table_symbols ADD COLUMN fqn TEXT;          -- 解決キー（ハッシュを含まない）
ALTER TABLE table_symbols ADD COLUMN export_name TEXT;  -- 非公開なら NULL
CREATE INDEX IF NOT EXISTS idx_symbols_fqn  ON table_symbols(fqn);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON table_symbols(name);

-- import 束縛表
CREATE TABLE IF NOT EXISTS table_imports (
    path          TEXT,
    local_name    TEXT,      -- ファイル内での束縛名
    imported_name TEXT,      -- '*' = namespace, 'default' = default
    module_spec   TEXT,      -- './foo' 等の生の指定子
    resolved_path TEXT,      -- ワークスペース相対パス。未解決なら NULL
    is_external   BOOLEAN
);
CREATE INDEX IF NOT EXISTS idx_imports_path     ON table_imports(path);
CREATE INDEX IF NOT EXISTS idx_imports_resolved ON table_imports(resolved_path);  -- 再解決対象の逆引き

-- 参照出現表
CREATE TABLE IF NOT EXISTS table_occurrences (
    path          TEXT,
    line          INTEGER,
    character     INTEGER,
    root_name     TEXT,      -- a.b.c() の 'a'
    member_path   TEXT,      -- 'b.c'（無ければ NULL）
    kind          INTEGER,   -- RelationshipKind（クエリのキャプチャ名から確定）
    enclosing_fqn TEXT,      -- 出現を囲む最内定義 = 参照元シンボル
    scope_id      INTEGER    -- ローカル束縛判定用
);
CREATE INDEX IF NOT EXISTS idx_occ_path ON table_occurrences(path);
CREATE INDEX IF NOT EXISTS idx_occ_name ON table_occurrences(root_name);

-- 関係（fqn ペア + 種類 + 確信度）
CREATE TABLE IF NOT EXISTS table_relationships_v2 (
    reference_fqn  TEXT,
    define_fqn     TEXT,
    kind           INTEGER DEFAULT 0,
    weight         REAL    DEFAULT 1.0,
    confidence     REAL    DEFAULT 1.0,
    reference_line INTEGER,
    is_intra_file  BOOLEAN DEFAULT FALSE
);

CREATE OR REPLACE VIEW view_relationship_strength AS
SELECT reference_fqn, define_fqn, kind,
       COUNT(*)                  AS occurrence_count,
       SUM(weight * confidence)  AS strength
FROM table_relationships_v2
GROUP BY reference_fqn, define_fqn, kind;
```

**Stage 1 での実装差分**（実物は `src/codeDb.ts` の `MIGRATION_V2`）

| 対象 | 計画からの変更 | 理由 |
| ---- | -------------- | ---- |
| `table_imports` | `export_name`・`line`・`character` 列を追加。再エクスポート（`export { a as b } from`、`export * from`）と副作用 import も1行として保存する（`local_name` は NULL） | Stage 2 の「`export * from` の re-export は2段まで追跡」に必要な情報を Phase A で残すため |
| `table_files` | `facts_version` 列を追加（NULL = 未抽出） | 移行直後の埋め戻しと、抽出規則を変えた時の再抽出に使う（§5.4） |
| `table_relationships_v2` | `reference_fqn` / `define_fqn` の索引を追加 | Stage 2 以降の JOIN と差分更新のため |
| `is_external` | 相対指定で見つからない import は `is_external = FALSE, resolved_path = NULL` | 生成物や削除済みファイルへの import はプロジェクト内の未解決であり、外部ライブラリの集約ノードへ寄せるべきではないため（§7.2） |

**Stage 2 での実装差分（スキーマ v3）**（実物は `src/codeDb.ts` の `MIGRATION_V3`）

| 対象 | 計画からの変更 | 理由 |
| ---- | -------------- | ---- |
| `table_definitions`（新設） | AST の定義を保存する（`path`・`fqn`・`name`・`kind`・`parent_fqn`・`export_name`・名前の位置・行の範囲） | 計画では言語サーバのシンボル（`table_symbols.fqn`）を名前解決の結合先にしていた。シンボルに付く定義は約半分で（Stage 1 の実測）、Stage 4 の「言語サーバ未導入でも関係が出る」とも両立しないため、AST の定義そのものを結合先にした |
| `table_occurrences.binding_fqn` | 根の名前を束縛しているファイル内の定義の `fqn` を追加 | 段1 を Phase A で確定させるため（§6.3） |
| `table_relationships_v2` | 作り直して `reference_path` / `define_path` 列を追加し、`weight` / `confidence` を `REAL` から `DOUBLE` にした | 参照元ファイル単位で置き換えるため。DuckDB の `REAL` は 32 ビットで、0.95 が 0.9499999881 になり strength の和に誤差が乗った。v2 ではこの表に書き込む処理が無いため、作り直しても失う行は無い |
| `table_files.resolved_version` | 名前解決の版数を追加（NULL = 未解決） | どのファイルが未解決かを DB に持ち、途中で終わっても次の機会に続きから解決するため（§9） |

### 5.3 関係の種類と基本重み

計画1 の taxonomy を踏襲する。

| kind | 名称 | 判定（TS のクエリキャプチャ） | 基本重み |
| ---- | ---- | ---------------------------- | -------- |
| 1 | `import` | `import_statement` / `require` 呼び出し | 1 |
| 2 | `inheritance` | `extends_clause` | 10 |
| 3 | `implementation` | `implements_clause` | 8 |
| 4 | `instantiation` | `new_expression` | 5 |
| 5 | `call` | `call_expression` | 3 |
| 6 | `type_reference` | 型注釈・ジェネリクス引数 | 2 |
| 7 | `read` | 識別子の読み取り | 1 |
| 8 | `write` | `assignment_expression` の左辺 | 4 |
| 9 | `decorator` | `decorator` | 5 |
| 0 | `unknown` | 判定不能・LSP フォールバック由来 | 1 |

### 5.4 マイグレーション

1. 起動時に `table_schema_version` を確認（無ければ v1 とみなす）
2. v1 → v2: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` と新規テーブル作成のみ（既存行は保持）。**1トランザクション**で行う（DuckDB 1.3.1 はインデックス付きテーブルへの `ADD COLUMN` も DDL のロールバックもできる事を実測で確認した）
3. 旧 `table_relationships`（id ペア）は**読み取り専用で残す**。`fqn` が未付与のシンボルは旧テーブルの関係を表示に使い、再調査で順次 v2 側へ移る
4. 全ファイル再調査が完了したら旧テーブルを DROP（Stage 4 の完了条件）

**埋め戻し（Stage 1 で追加）**: 移行直後は全シンボルの `fqn` と全ファイルの事実が空になる。
内容の変わっていないファイルは再調査されないため、放置すると永久に埋まらない。
そこで全走査の時に、`facts_version` が `FACTS_VERSION`（`src/extruct/ast/localFacts.ts`）と異なる
AST 対応ファイルを **facts 項目**としてキューに登録し、LSP を使わずに事実だけを抽出する
（シンボルは DB から読んで解決キーを付け直す）。facts 項目は実行中のタスクを中断せず、
同じファイルの upsert / delete が控えていれば破棄される。
抽出規則（`.scm` や `localFacts.ts`）を変えた時は `FACTS_VERSION` を上げれば、同じ仕組みで全ファイルを抽出し直せる。

---

## 6. Phase A: ローカル事実抽出

### 6.1 パーササービス（Stage 0 で実装済み）

`src/extruct/ast/parser.ts` / `src/extruct/ast/resources.ts`

- `web-tree-sitter` の初期化は拡張の起動時に1回（`Parser.init()` の `locateFile` で `dist/wasm/web-tree-sitter.wasm` を指す）
- 言語 WASM は **`language_id` が初めて出現したときに遅延ロード**し、**文法名**でキャッシュ（`typescript` と `typescriptreact` は文法が違うため language id ではなく文法名を鍵にした）
- `Tree` は保持せず、`withTree()` のコールバックを抜けた時点で破棄（メモリ削減）
- 未対応 `language_id` は `null` を返し、呼び出し側が LSP 経路へフォールバック

| API | 用途 |
| --- | ---- |
| `AstParser.create(resources)` | 生成。本体 WASM の初期化を含む |
| `withTree(languageId, source, body)` | 構文木を使う処理。戻り値を返した時点で木は破棄される |
| `captures(languageId, source)` | クエリのキャプチャを素のデータ（名前・文字列・位置・マッチ番号）で返す。Stage 1 の入力になる |
| `astLanguageOf(languageId)` / `AST_LANGUAGES` | 対応言語の定義。言語追加はここと `.scm` の追加で済む |
| `resolveAstResources(extensionPath)` | `<拡張機能のルート>/dist` の `wasm/` と `queries/` を指す |

**実装上の落とし穴**: web-tree-sitter は ESM 版と CJS 版の両方を公開している。ESM 版は
`createRequire(import.meta.url)` で WASM を読むため、esbuild で CJS へバンドルすると
`import.meta.url` が undefined になり `Parser.init()` が失敗する。
`import treeSitter = require('web-tree-sitter')` で読み込むと esbuild が CJS 版を選ぶ。
この前提が崩れていない事は `verification/ast-parser/` が見張る。

### 6.2 クエリ（宣言的な種類判定）

`src/extruct/ast/queries/typescript.scm`（TS / TSX 共用）・`javascript.scm`（JS / JSX 共用）

Stage 0 でキャプチャ名の規約を確定し、Stage 1 で事実の抽出に必要な分を足した。言語間で統一する事。
規約の一覧は `typescript.scm` の先頭にもある。

| キャプチャ名 | 意味 |
| ------------ | ---- |
| `def.<種別>` | 定義。`fqn` / `export_name` の元になる |
| `def.<種別>.signature` | 本体の無い宣言（オーバーロード・宣言ファイル）。同じ親・同じ名前の定義と1つにまとめる |
| `def.node` | 定義ノードを明示する（省略時は名前ノードの親が定義ノード。列挙子のように名前ノード自身が定義の場合に使う） |
| `imp.local` / `imp.imported` | import 束縛のファイル内での名前 / 取り込む名前。**1マッチ = 1束縛**（`import { a as b }` なら1マッチに `b` と `a`） |
| `imp.default` / `imp.namespace` | default import / namespace import（`imp.local` と同じノードに付ける） |
| `imp.export` / `imp.reexport` | 再エクスポートの公開名 / `export * from` の文全体 |
| `imp.module` / `imp.module.bare` | モジュール指定子（`.bare` は束縛の無い import / require。他のマッチが同じ指定子を使っていなければ副作用 import） |
| `imp.require` | `require` の関数名（参照出現から除外するため） |
| `export.statement` / `export.default` | export 文 / export default 文（直下の宣言が export される） |
| `export.local` / `export.name` / `export.default.local` | `export { local as name }`（from 無し）/ `export default <識別子>` |
| `scope` | レキシカルスコープを作るノード（`scope_id` の算出に使う） |
| `bind.<種別>` | 定義以外の束縛（引数・型引数・分割代入・catch・for-of の変数） |
| `ref.<kind>` | 参照出現。`<kind>` がそのまま `RelationshipKind` になる |
| `ref.receiver` | メンバ参照のレシーバ（`a.b()` の `a`、および `this` / `super`） |

`def` / `bind` / `imp` にキャプチャされたノードは参照出現にならない。
tree-sitter のクエリはパターン間に優先順位が無く、同じ識別子を複数のパターンが捉える
（`this.m()` の `m` は呼び出しとメンバ読み取りの両方に一致する）。この場合は
`relationshipKind.ts` の優先順位（inheritance > implementation > decorator > instantiation > call > write > type_reference > read）で1つに絞る。

**Stage 1 で変えた点**

| 変更 | 理由 |
| ---- | ---- |
| `imp.name` / `imp.alias` を `imp.local` / `imp.imported` に置き換え | 旧規約では `import { a as b }` の `a` と `b` が別々のマッチになり、束縛の組を作れなかった。否定フィールド（`!alias`）と1ノードへの二重キャプチャで1マッチ = 1束縛にした |
| `def.export` を `export.*` に置き換え | export は定義ではないため |
| 型名は `(type_identifier) @ref.type_reference` で包括的に捉える | 旧規約は型注釈の直下だけで、`vscode.Position` のような修飾型名（`nested_type_identifier`）・共用体型・配列型・型エイリアスの右辺を取りこぼしていた |
| `ref.read` はメンバ側（`a.b` の `b`）を捉え、オブジェクト側はレシーバにする。値として渡される識別子（引数・戻り値・初期化子・代入の右辺・配列要素・オブジェクトの値）も読み取りにする | メンバの読み取りを `root_name` + `member_path` で表すため。DI の登録やコールバック渡しのような依存を拾うため |
| 型のメンバ（`property_signature` / `method_signature`）はインターフェースと型エイリアスの本体に限る | 戻り値の型 `Promise<{ doc: …, symbols: … }>` のような型リテラルのメンバを定義にすると、同名のローカル変数の `fqn` が `~2` にずれた（自リポジトリの `examine.ts` で発見） |
| `namespace N {}` を定義に追加（`internal_module`） | Stage 0 の `(module …)` は `module Foo {}` / `declare module` 用で、`namespace` を捉えていなかった |
| 列挙子・関数のオーバーロード宣言・抽象メソッドを定義に追加 | 言語サーバのシンボルと対応させるため |

型に関する kind（`type_reference` / `implementation`）は JavaScript の文法に存在しないため
`javascript.scm` では定義しない。文法に無いノード型を書くとクエリのコンパイル自体が失敗する。

以下は方針を示す抜粋（実物は上記2ファイル）。

```scheme
; 定義
(class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(function_declaration name: (identifier) @def.function)
(method_definition name: (property_identifier) @def.method)

; import 束縛 (1マッチ = 1束縛)
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @imp.imported @imp.local !alias)))
  source: (string) @imp.module)
(import_statement
  (import_clause (namespace_import (identifier) @imp.local @imp.namespace))
  source: (string) @imp.module)

; 参照出現（キャプチャ名がそのまま kind になる）
(extends_clause value: (identifier) @ref.inheritance)
(implements_clause (type_identifier) @ref.implementation)
(new_expression constructor: (identifier) @ref.instantiation)
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.call))
(type_identifier) @ref.type_reference
(nested_type_identifier module: (identifier) @ref.receiver name: (type_identifier) @ref.type_reference)
(assignment_expression left: (identifier) @ref.write)
(decorator (identifier) @ref.decorator)
```

言語追加は原則 `.scm` の追加だけで済む構成にする（キャプチャ名の規約を言語間で統一）。

### 6.3 抽出する事実（Stage 1 で実装済み・Stage 2 で拡張）

`src/extruct/ast/localFacts.ts`（抽出）・`factsExtractor.ts`（抽出 + import 解決 + 計時）・`relationshipKind.ts`（種類と優先順位）

```ts
interface AstOccurrence {
  line: number; character: number;  // 0起点。桁は UTF-16（VSCode の Position と同じ単位）
  rootName: string;                 // a.b() の 'a'。this / super をレシーバとする場合は 'this' / 'super'
  memberPath: string | null;        // a.b() の 'b'（単純な識別子なら null）
  kind: RelationshipKind;           // クエリのキャプチャ名から確定
  enclosingFqn: string;             // 出現を囲む最内の定義（どの定義にも囲まれていなければ `<path>#`）
  scopeId: number | null;           // 根の名前を束縛しているスコープ（下記）
  bindingFqn: string | null;        // 根の名前を束縛しているファイル内の定義（Stage 2）
}
```

| 事実 | 規則 |
| ---- | ---- |
| `fqn` | `<path>#<入れ子の名前を . で連結>`（例 `src/relationship/examine.ts#ExamineTask.computeUpsert`）。名前に `#` と `.` は現れないため、最後の `#` より前がパス。同じ親・同じ名前の2つ目以降は `~2`, `~3` …（getter / setter、宣言のマージ）。オーバーロード宣言は本体を持つ定義へまとめ、本体が無ければ最初の宣言を残す |
| ファイルの `fqn` | `<path>#`。ファイルのルートシンボルに付け、モジュールスコープの参照出現の `enclosing_fqn` にもなる |
| `export_name` | トップレベルの定義だけに付ける。定義ノードの親か祖父が export 文なら定義名（`export default` なら `'default'`）、`export { a as b }` なら `b`、`export default a` なら `'default'` |
| `enclosing_fqn` | 出現を囲む最内の定義。無名コールバックの中の出現は、その外側の名前付き定義（メソッド等）に集約される |
| `binding_fqn`（Stage 2） | 根の名前を束縛しているファイル内の**定義**の `fqn`。import・定義でない束縛（引数・分割代入の変数など）・ファイル内に束縛の無い名前は NULL。同じスコープで import と定義が同じ名前を束縛する場合（`const fs = require('fs')`）は import を優先して NULL |
| `member_path`（Stage 2） | メンバ参照の連鎖（`A.B.c()`）は根 `A` と経路 `B.c` にまとめる。途中に呼び出しや添字を含む連鎖（`a().b`）は根が定まらないため参照出現にしない |
| `scope_id` | **根の名前を束縛しているスコープ**。`0` = モジュールスコープ（import かトップレベルの定義）、`1` 以上 = ファイル内のローカルスコープ（文書順の番号）、`NULL` = ファイル内に束縛が無い（グローバル・組込み）か根が `this` / `super`。引数が同名の import を隠す場合も正しく区別できる |

`scope_id` は計画時点では「ローカル束縛判定用」とだけ決めていた。スコープの解析には構文木が要り、
Phase B（SQL）では計算できないため、Phase A で「根の名前をどこが束縛しているか」まで確定させた。
Stage 2 の SQL は `scope_id = 0` の出現だけを import 表と結合すればよい。

**包含判定の実装**: 1出現ごとに構文木の親を辿ると WASM 境界を何万回も越える。定義とスコープを
区間（開始・終了インデックス）の入れ子構造として持ち、開始位置の二分探索と親への遡りで最内の区間を引く
（構文木のノード範囲は必ず入れ子か素であるため成り立つ）。

**シンボルへの解決キーの付与**（`src/extruct/codeSymbols.ts` の `attachAstKeys()`）: LSP の
`selectionRange.start` と AST の名前ノードの開始位置が一致する定義を付ける（どちらも UTF-16 の桁で数える事を実測で確認）。
一致しなければ、シンボルの範囲内にある同名の定義を付ける。ID と内容ハッシュには影響しない。
本文が同じでも `~N` のずれや export 句の追加で解決キーが変わるため、`computeUpsert()` は位置に加えて解決キーの変化でも
`table_symbols` を更新する。

`enclosingFqn` を構文木の包含関係で求める事により、§2 の限界2（参照元シンボルの取り違え）が解消する。

---

## 7. Phase B: 名前解決

### 7.1 多段解決（上位段で当たったら打ち切り）

`src/relationship/resolve.ts`（Stage 2 で段1・段2 を実装済み）

| 段 | 解決方法 | confidence | 備考 |
| -- | -------- | ---------- | ---- |
| 1 | **ローカルスコープ束縛** — 同ファイル内の定義・パラメータ・ローカル変数 | 1.0 | `is_intra_file = TRUE` で記録 |
| 2 | **import 束縛** — `root_name` が import 表にあればモジュール解決 → 解決先の export 表を引く | 0.95 | `export * from` の re-export は2段まで追跡 |
| 3 | **レシーバ型の軽量推論** — `this`→囲むクラス、`const a = new Foo()`→`Foo`、パラメータ型注釈 `(a: Foo)`→`Foo`。得た型のメンバ表を継承チェーン込みで引く | 0.8 | メソッド呼び出しの大半をここで拾う |
| 4 | **グローバル名インデックス** — プロジェクト全体で名前が一意なら確定 | 0.6 | |
| 4' | 候補が N 個（N ≤ 閾値、既定4）なら**全候補に conf = 0.5/N** の弱いエッジ。N > 閾値は破棄 | 0.1〜 | 破棄件数をログ出力し閾値調整の材料にする |
| 5 | **未解決** — 外部ライブラリ・組込み | 0 | `is_external` 集約ノードへ寄せる（既定は非表示） |

`strength = Σ(kind の基本重み × confidence)`。推測由来のエッジは自動的に細い線になる。

**Stage 2 の実装**（段1・段2）

| 規則 | 内容 |
| ---- | ---- |
| 段1 | `binding_fqn` があれば、その定義とメンバの経路を引く。`is_intra_file = TRUE`・confidence 1.0 |
| 段2 | `scope_id = 0` で根の名前が import 束縛なら、import 先の export を引く。再エクスポート（`export * from` / `export { a as b } from` / `export * as ns from` / 自ファイルの別名 export）は**3段**まで辿る（計画の2段では `index.ts` を2つ挟む構成を辿れないため）。confidence 0.95 |
| メンバの経路 | 名前空間（モジュール）なら export 名、定義なら入れ子の定義（`<fqn>.<名前>`）として1段ずつ引き、定義が無ければその手前で止まる（インスタンスのメンバは Stage 3）。**途中で通過した定義にも `read` の関係を出す**（`Cls.create()` は `Cls` も参照している。LSP も両方を参照として返す） |
| モジュール単位 | import 先のファイルは分かるが export 名の定義が見つからない（`export default` の無名関数など）場合は、ファイル（`<path>#`）への関係にして confidence を 0.5 に下げる |
| import 文 | 1つの import 束縛・再エクスポート・副作用 import ごとに、ファイル（`<path>#`）から取り込んだ定義・モジュールへの `import` 関係を出す |
| 関係にしないもの | 自分自身・自分の内側の定義への参照（再帰・自分のローカル変数）、定義でないローカル束縛、`this` / `super`（Stage 3）、ファイル内に束縛の無い名前（Stage 3 の段4/5）、プロジェクト外・解決できない import。件数は理由ごとに数え、ログと精度検証のレポートに出す |

### 7.2 モジュール解決

`src/extruct/ast/moduleResolver.ts`（Stage 1 で実装済み）。ファイルシステムへの問い合わせは差し替え可能（単体テストはメモリ上で行う）。

1. 相対指定 → `path.resolve` + 拡張子候補（`.ts / .tsx / .d.ts / .mts / .cts / .js / .jsx / .mjs / .cjs`）+ `index.*`。ESM 形式の TS が書く `./a.js` は `./a.ts` として探す
2. 非相対指定 → 最寄りの `tsconfig.json` / `jsconfig.json`（ワークスペースのルートまで遡る）の `paths` / `baseUrl` でワークスペース内へ写せればプロジェクト内。設定ファイルは JSONC（コメント・末尾カンマ）として読み、相対パスの `extends` を辿る
3. 写せない非相対指定・`node:` → `is_external = true`。**`node_modules` は探索しない**（プロジェクト外である事さえ分かればよいため）
4. 相対指定で見つからない → `is_external = false, resolved_path = NULL`（計画では `is_external = true`。§5.2 の実装差分を参照）
5. 解決先がワークスペースの外 → `is_external = true, resolved_path = NULL`

### 7.3 SQL による解決（Stage 2 で方式を変更）

> **Stage 2 では採用しなかった。** 解決は TypeScript（`src/relationship/resolve.ts`）で行い、DuckDB は事実の読み込みと
> 結果の保存に使う。メンバの連鎖 `Relationship.FileDifference.QueueProcessor` は「名前空間 import → `export * as`
> → モジュール → `export *` → 定義」のように**モジュールと定義の解決が交互に現れ**、段ごとに引き方が変わる。
> これを SQL の JOIN と再帰 CTE で表すと読み解けない規模になるため。Stage 3 の型推論も TypeScript で書く前提に揃えた。
> 計画の懸念だった直列区間の長さは、50 ファイルずつ区切ってコミットと交互に実行する事で抑えている（§9）。
> 以下は当初の案として残す。

当初の案: 解決はほぼ JOIN であるため TypeScript のループではなく DuckDB に投げる。直列コミット区間が「INSERT + 数本の JOIN」に縮む。

```sql
-- 段2: import 経由
CREATE OR REPLACE VIEW view_resolve_import AS
SELECT o.path, o.line, o.enclosing_fqn AS reference_fqn,
       d.fqn AS define_fqn, o.kind, 0.95 AS confidence
FROM table_occurrences o
JOIN table_imports i ON i.path = o.path AND i.local_name = o.root_name
JOIN table_symbols d ON d.path = i.resolved_path
                    AND d.export_name = COALESCE(NULLIF(o.member_path, ''), i.imported_name);

-- 段4: 一意名（段1〜3 で解決済みの出現を除いた残りに適用）
CREATE OR REPLACE VIEW view_resolve_unique AS
SELECT o.path, o.line, o.enclosing_fqn, s.fqn, o.kind, 0.6 AS confidence
FROM table_occurrences o
JOIN (SELECT name, ANY_VALUE(fqn) AS fqn FROM table_symbols
      GROUP BY name HAVING COUNT(*) = 1) s
  ON s.name = COALESCE(NULLIF(o.member_path, ''), o.root_name);
```

### 7.4 LSP による確定

confidence < 閾値（既定 0.7）の出現に限り `executeDefinitionProvider` を呼び、返った定義位置を `fqn` に解決できたら confidence を 1.0 に置き換える。設定 `crd.ast.lspVerification` で無効化可能（オフライン・高速モード）。

---

## 8. Phase C: 集約と描画への受け渡し

- `view_relationship_strength` を `cosmosAdapter` から読み、`kind` を色・`strength` を幅（log スケール）に割り当てる
- `is_intra_file` の関係は既定で非表示（トグルで表示）。ファイル1個へズームしたときのみ有効化する運用を想定
- 計画3 のバンドリング・集約エッジはこのビューをそのまま入力にできる

---

## 9. 差分更新との統合

`docs/file-difference-queue.md` のキューにそのまま乗る。ファイル X が変更されたとき:

1. **Phase A を X のみ再実行** — `table_occurrences` / `table_imports` / defs を `path = X` で全置換
2. **X の再解決**
3. **X の export 表が変化した場合のみ**、`SELECT DISTINCT path FROM table_imports WHERE resolved_path = X` で影響ファイルを特定して再解決（現状の fan-out より狭く正確）
4. **段4 に依存した解決**は、追加・削除された名前を含む出現だけ `root_name` インデックスで拾って再解決

**Stage 2 の実装**: 1〜3 を次の形で実装した（4 は Stage 3）。

- 事実を置き換える・削除する時に、X と「X を import しているファイル」の `table_files.resolved_version` を NULL に戻す（同じトランザクション）。export 表が変わったかは比べず、事実が変われば常に戻す（比較の手間より再解決の方が安いため）
- キューが空になった時点で、`facts_version = FACTS_VERSION` かつ `resolved_version` が `RESOLVE_VERSION` と異なるファイルを集め、50 ファイルずつ**コミットと同じ直列区間**で解決して、参照元ファイル単位で `table_relationships_v2` を置き換える。読み込みから保存までの間に他ファイルの事実が変わらないよう、区間ごとに読み直す
- どのファイルが未解決かは DB が持つため、途中で VS Code を閉じても、次の全走査で（変更が無くても）続きから解決する
- 解決規則を変えた時は `RESOLVE_VERSION`（`src/relationship/resolve.ts`）を上げれば、全ファイルを解決し直す
- **既知の限界**: X より前に抽出したファイルが X を相対 import していて、その時点で X が無かった（`resolved_path = NULL`）場合、X が作られても import 側は再解決されない（import 側の事実を抽出し直すまで）

---

## 10. ビルドと配布（WASM）

| 項目 | 対応 |
| ---- | ---- |
| `tree-sitter.wasm` と言語 WASM | `esbuild.js` にコピー処理を追加し `dist/wasm/` へ配置。バンドルはしない |
| 言語 WASM の入手元 | `@vscode/tree-sitter-wasm`（devDependency）。tree-sitter-cli 0.25 系でビルド済みで TS/TSX/JS に加え Python/Go/Java/C# も含むため、Stage 6 の言語追加もパッケージ追加なしで済む |
| クエリ(`.scm`) | 同じく `dist/queries/` へコピーし、実行時に読んでコンパイルする |
| 参照方法 | `path.join(__dirname, 'wasm', ...)` で実行時ロード（`bindings/` と同じ流儀） |
| パッケージ | `.vscodeignore` で `dist/wasm/**` を含める。`vsce package` 後に同梱を確認 |
| サイズ | **実測 3.3MB**（本体 197KB + TypeScript 1,381KB + TSX 1,412KB + JavaScript 402KB）。言語追加ごとに増えるため**遅延ロード必須**。総サイズを CHANGELOG に記録 |
| 外部化 | `external: ['vscode', 'duckdb']` に倣い、web-tree-sitter は bundle 対象（JS 部分は小さい）。ただし **CJS 版を選ばせる必要がある**（§6.1 の落とし穴） |
| 除外 | `scripts/**` と `verification/**` はビルド時にしか使わないため `.vscodeignore` で除外する |

---

## 11. 精度検証

**Stage 4（切替）の前に、AST 結果と現行 LSP 結果を突き合わせる検証モードを必ず挟む。**

**Stage 2 で実装済み**: `yarn verify:accuracy`（`src/test/astAccuracy.verify.ts`・突き合わせは `src/relationship/accuracy.ts`）。
自リポジトリを拡張機能と同じ差分キュー（LSP の関係調査 + AST の事実抽出 + 名前解決）で調べ、
`verification/ast-accuracy/report.md` を書き出す。比較の方法は `verification/ast-accuracy/README.md`。

- 両者を**言語サーバのシンボルに付いた `fqn`** へ揃えて比べる（AST のローカル変数・LSP の無名コールバックは、シンボルのある最も近い祖先へ）
- LSP の関係のうち**定義側が名前付きの宣言でないもの**（オブジェクトリテラルのメンバ・無名コールバック）は比較から除く。
  TypeScript の構造的な型付けにより、インターフェースのプロパティへの参照が、それを満たすオブジェクトリテラルのメンバへの
  参照として記録される（本番コード → テストのオブジェクトリテラル のような、依存ではない関係）。自リポジトリでは LSP の関係の 7 割強がこれだった
- `exsample-workspace/` は C のみで AST 未対応のため対象外。confidence 閾値ごとの集計は段3以降（confidence が 1.0 / 0.95 / 0.5 以外の値を取るようになってから）に足す
- 置き場所: `verification/ast-accuracy/`（既存の `verification/lsp-parallel/` に倣う）
- 対象: 本リポジトリ自身 + `exsample-workspace/`
- 出力レポート:

| 指標 | 意味 |
| ---- | ---- |
| LSP のみ検出（取りこぼし） | AST が落とした関係。段別の内訳を出す |
| AST のみ検出 | 誤検出、または LSP の取りこぼし（要サンプル目視） |
| 一致率 / 再現率 / 適合率 | confidence 閾値ごとに算出 |
| 段別解決内訳 | 段1〜5 それぞれの解決件数と割合 |
| 処理時間 | ファイルあたりのパース時間・全体の examine 時間 |

このレポートで **confidence 閾値と段4' の候補数閾値を実測で決める**。

---

## 12. 段階計画

各 Stage は独立してリリース可能で、途中段階でも既存機能（現行の描画・保守性スコア）は動作を維持する。

| Stage | 状態 | 内容 | 受け入れ基準（Done） | 目安 |
| ----- | ---- | ---- | -------------------- | ---- |
| **0** | **完了** | AST 基盤: `web-tree-sitter` 導入、パーササービス、TS/JS 文法、WASM 同梱・遅延ロード | 単体テストで任意の TS/JS をパースできる / `.vsix` を実機インストールして WASM がロードされる / 既存機能に影響なし | 0.3.36 |
| **1** | **完了** | Phase A: defs / imports / occurrences 抽出、`fqn`・`export_name` 付与、スキーマ v2 とマイグレーション、DuckDB へ保存（**まだ関係抽出には使わない**） | 自リポジトリ全ファイルで occurrences が保存される / `fqn` がファイル内で一意 / パース時間 中央値 < 20ms/ファイル / v1 DB から無停止で移行できる | 0.3.37 |
| **2** | **完了** | Phase B 段1〜2（ローカル + import 解決）、`kind` 付与、`table_relationships_v2` への保存。表示は従来関係のまま | import 由来の関係の再現率 ≥ 95%（対 LSP、§11 のレポート） / 検証レポートが CI or スクリプトで再生成できる | 0.3.38 |
| **3** | 未着手 | Phase B 段3〜4'（型推論・一意名・曖昧候補）、confidence、Phase C 集約 VIEW | 関係全体の再現率 ≥ 90%、適合率 ≥ 90%（閾値 0.7 時） / 段別内訳がレポートに出る | 0.3.39 |
| **4** | 未着手 | **主経路の切替**: `examine()` を AST 主体へ。LSP は低 confidence 検証と未対応言語フォールバックに降格。設定 `crd.ast.enabled` で旧経路へ戻せる。旧 `table_relationships` を DROP | 自リポジトリの `examineRelationships` 実行時間が現行比 ≤ 50% / 言語サーバ未導入の状態でも TS/JS の関係が出る / 旧経路へのロールバックが動く | 0.4.0 |
| **5** | 未着手 | 描画反映: kind の色分け・strength の線幅・kind トグル・strength 閾値スライダー・ファイル内依存トグル | グラフ上で継承と import が区別できる / 閾値スライダーで幹線のみ表示できる | 0.4.1 |
| **6** | 未着手 | 言語追加（需要順: Python → Go → Java/C#）。`.scm` とモジュール解決の追加のみで完結 | 追加言語で §11 のレポートが所定値を満たす / WASM は当該言語のファイルが在るときだけロードされる | 0.4.x |

**計画2（メトリクス）は Stage 1 完了後に着手可能**（同じ AST 走査に相乗りする）。計画3 前半（円パッキング + LOD）は本計画と並行して進められる。

### Stage 0 の実装結果（0.3.36 / 2026-08-26）

| 受け入れ基準 | 結果 |
| ------------ | ---- |
| 単体テストで任意の TS/JS をパースできる | **達成**。`src/extruct/ast/parser.unit.test.ts` 18件を含む67件が通過。加えて自リポジトリの `src/**/*.ts` 37件を全てパース（中央値 1.0ms/ファイル・最大 23.8ms） |
| `.vsix` を実機インストールして WASM がロードされる | **同梱まで確認**。`vsce ls` で `dist/wasm/*.wasm`・`dist/queries/*.scm` の同梱を確認し、minify 有無の両方のバンドルで同じ配置からロードしてパースできる事を検証。実機起動の確認は `src/test/astParser.test.ts`（`yarn test`）で行う |
| 既存機能に影響なし | **達成**。`yarn run package` 完走。起動時のパーサ生成は失敗しても警告のみで続行する |

**Stage 1 への申し送り**

- パース時間の中央値は 1.0ms/ファイルで、Stage 1 の基準（中央値 < 20ms/ファイル）に対して十分な余裕がある。ただしこれは**パースのみ**の値で、クエリ実行と事実抽出の時間は含まない
- `captures()` が返す `matchIndex` で同一マッチのキャプチャを束ねられる。`ref.receiver` と `ref.call` の対応付けはこれで行う
- tree-sitter は**ソースに制御文字（NUL 等）を含むファイルを構文エラーにする**。TypeScript は受け付けるため、混入すると該当ファイルの事実が丸ごと落ちる。`verification/ast-parser/` が WARN で検知する
  - 0.3.36 で `src/relationship/examine.ts` の生 NUL を解消済み（関係の一意化キーを `JSON.stringify([a, b])` に変更）
  - 区切り文字が要る箇所では、シンボルIDにパス（タブを含むファイル名も `fast-glob` は列挙する）と言語サーバ由来のシンボル名（C言語では `string_copy(char *, const char *)` のようにシグネチャ全体が入る）が含まれる事を踏まえ、区切りが曖昧にならない形を使う

### Stage 1 の実装結果（0.3.37 / 2026-09-26）

自リポジトリの TS/JS 59 ファイル（拡張機能と同じ `files.associations` 相当 + `.gitignore` で列挙）で実測した。
測定は `verification/ast-facts/`（`yarn verify:facts`）と統合テスト `src/test/astFacts.test.ts`（VS Code 1.105.0 の拡張機能ホスト）による。

| 受け入れ基準 | 結果 |
| ------------ | ---- |
| 自リポジトリ全ファイルで occurrences が保存される | **達成**。59/59 ファイルを DuckDB へ保存し、読み戻した件数（参照出現 8,641・import 305）が抽出結果と一致。全ファイルに `facts_version = 1` が記録された。本番の経路（`computeUpsert` → `commitUpsert`、tsserver のシンボル抽出込み）でも事実と解決キーが保存される事を統合テストで確認 |
| `fqn` がファイル内で一意 | **達成**。定義 2,146（うち export 126）で重複 0 |
| パース時間 中央値 < 20ms/ファイル | **達成**。**中央値 1.3ms**・p95 5.9ms・最大 15.9ms（パース + 抽出 + import 解決。最大は 2,475 行の `graphView.ts`）。文法ごとの最初の1ファイルは WASM の遅延ロードとクエリのコンパイルを含み TS 68.5ms / JS 36.3ms（拡張機能の起動中に1回だけ。実行ごとに数十ms 揺れる） |
| v1 DB から無停止で移行できる | **達成**。拡張機能が作った実際の v1 DB（`exsample-workspace/.vscode/crd.duckdb` の複製）を 5ms で v2 へ移行し、ファイル・シンボル・関係の行数を保った。移行後の未抽出ファイルは facts 項目で LSP を使わずに埋め戻される事を、実ファイル・実 DuckDB・実パーサの結合テストで確認 |

**内訳**（`yarn verify:facts`）

| 項目 | 値 |
| ---- | -- |
| import 束縛 | 305（プロジェクト内へ解決 169・外部 136・相対指定の未解決 0） |
| 参照出現の種類 | read 4,295・call 2,892・type_reference 726・write 373・instantiation 351・inheritance 4 |
| 根の名前の束縛（`scope_id`） | モジュール 2,051・ローカル 4,804・ファイル内に無し 830・this / super 956 |
| 言語サーバのシンボルへの解決キーの付与 | **export された定義 113/113（100%）**。シンボル全体では 1,977/3,764（52.5%） |

シンボル全体の付与率が約半分なのは、tsserver がシンボルとして返すが AST では定義にしていないものが多いためで、
取りこぼしではない事を全件の内訳で確認した: 無名コールバック（`map() callback` 等）535・オブジェクトリテラルの
キー 985（関数値なら Method として 25）・`catch (e)` / `for (const x of …)` / 配列の分割代入の変数 242。
これらの内側の参照出現は、外側の名前付き定義へ集約される。

**Stage 0 の残件**: 「`.vsix` を実機インストールして WASM がロードされる」の実機起動の確認は、今回はじめて
`src/test/astParser.test.ts` を拡張機能ホスト上で実行して確かめた（合格）。

**Stage 2 への申し送り**

- 名前解決は `scope_id` で分岐できる: `0` なら import 表 → トップレベルの定義（`<path>#<root>`）の順、`1` 以上ならローカル束縛なので `enclosing_fqn` から親へ遡って `<fqn>.<root>` を探し、定義で無ければ（引数・分割代入の変数など）関係にしない、`NULL` なら段4/5
- `const fs = require('fs')` は import 束縛であると同時に変数の定義にもなる。`scope_id = 0` の出現は **import 表を先に引く**事
- 再エクスポートは `table_imports` に `local_name = NULL` で入っている（`export_name` = 公開名、`imported_name = '*'` かつ `export_name = '*'` なら `export * from`）
- 捉えていない参照: JSX のコンポーネント（`typescript.scm` は TS 文法と共用のため JSX のノードを書けない。TSX 用のクエリを分けて足す）、式中の素の識別子の読み取り（二項演算・条件など）、`module.exports` / `export =` による export、名前空間の内側の export（`export_name` はトップレベルだけ）
- 1つの定義を複数の名前で export した場合（`export { a, a as b }`）は最初の名前だけが `export_name` に入る
- facts 項目（埋め戻し）はファイルを UTF-8 として読む。upsert の経路は VSCode の TextDocument（エンコーディング設定に従う）を使う。UTF-8 以外の TS/JS では埋め戻しの位置がずれうる（次の upsert で直る）
- `yarn test` は `@vscode/test-electron` 2.5.2 が VS Code 1.131 以降の実行ファイル名（`Electron` → `Code`）に対応していないため起動できない。今回は `./node_modules/.bin/vscode-test --code-version 1.105.0` で実行した（別タスクで対応）

### Stage 2 の実装結果（0.3.38 / 2026-10-08）

自リポジトリの TS/JS 64 ファイルを、拡張機能と同じ差分キュー（LSP による従来の関係調査 + AST の事実抽出 + 名前解決）で
調べて実測した（`yarn verify:accuracy`、VS Code 1.141.0、283 秒）。生成されたレポートは `verification/ast-accuracy/report.md`。

| 受け入れ基準 | 結果 |
| ------------ | ---- |
| import 由来の関係の再現率 ≥ 95%（対 LSP） | **達成。100.0%（465 / 465）**。LSP の関係のうち定義がトップレベル（import した名前・名前空間の export・その静的メンバで引ける範囲）のもの |
| 検証レポートが CI or スクリプトで再生成できる | **達成**。`yarn verify:accuracy` が `verification/ast-accuracy/report.md` を書き出し、基準を下回ると失敗する。調査に使った DB は `out/verify-accuracy/` に残る |

**その他の指標**

| 指標 | 値 | 読み方 |
| ---- | -- | ---- |
| ファイル単位の再現率 | 96.5%（139 / 144） | LSP のみの 5 組は全て、インスタンス経由のメンバ参照か、インターフェースを満たすオブジェクトリテラル（文脈による型付け）による依存。Stage 3 の対象 |
| ファイル単位の適合率 | 83.7%（139 / 166） | AST のみの 27 組は LSP の経路が記録しない依存: 再エクスポート（`export * from`）とまとめ役の `index.ts` への名前空間 import（LSP は元の定義のファイルへ帰属させる）、言語サーバが扱わないファイル（JSON・tsconfig の対象外・`.mjs`）、LSP の参照検索の取りこぼし（`codeDb.ts` → `bindingsAutoSign.ts` の `autoSignBinary()` 呼び出し等） |
| シンボル単位の再現率（全て） | 31.0%（512 / 1,653） | メンバの参照の大半はインスタンス経由（`db.query()`）で、値の型が分からないと引けない。Stage 3 の主な改善対象 |
| シンボル単位の適合率 | 96.1%（512 / 533） | |

| AST の関係 | 件数 |
| ---------- | ---- |
| 合計 | 3,616（うちファイル内 2,723） |
| 種類 | read 1,612・call 1,103・type_reference 522・import 219・instantiation 110・write 47・inheritance 2・implementation 1 |
| 解決の内訳（参照出現） | 段1 2,698・段2 613（うちモジュール単位 3）・自分自身/内側 2,489・定義でないローカル束縛 3,083・this / super 1,010・ファイル内に束縛無し 925・プロジェクト外 1,356・解決できない import 0 |

**計測の前提を正した点**: 最初の計測では import 由来の再現率が 21.6% だった。原因は比較の方法と Phase A の不足で、
名前解決そのものの誤りではなかった。

1. LSP の関係（7,433 件）の 7 割強（5,380 件）は、定義側が名前付きの宣言でない**構造的な参照**だった（§11）。
   定義側を外側の名前付き定義まで遡らせて数えていたため、「本番コード → テストのオブジェクトリテラル」のような
   依存ではない関係を import 由来として数えていた。比較から除き、件数をレポートに出す
2. `Ast.AstParser.create()` を LSP は `AstParser` と `create` の2つの参照として返すが、AST は連鎖の末端だけを関係にしていた。
   途中で通過した定義にも `read` の関係を出すようにした（§7.1）
3. コンストラクタ引数のプロパティ（`constructor(public readonly file: File)`）が定義になっておらず、引数の型注釈の参照元が
   コンストラクタになっていた（LSP はプロパティを参照元にする）。クラスのメンバとして定義するようにした（§6.2）
4. `export default localeMap` のように既に export している定義を別名で export すると、別名が失われていた。
   自ファイルからの再エクスポートとして記録するようにした（§6.2）

**既存の不具合の修正**: 計測の途中で、**シンボル ID の衝突で 64 ファイル中 27 ファイルの保存が丸ごと失敗していた**事が分かった
（同じ親の下に種類・名前・本文が全て同じ兄弟があると ID が衝突し、`table_symbols` の主キー違反になる。0.1 系からの不具合）。
2つ目以降に文書順の番号 `~2` … を付けて直した（`src/extruct/codeSymbols.ts`）。

**Stage 3 への申し送り**

- 段3（レシーバ型の推論）の対象は、`this` / `super` をレシーバとする参照 1,010 件と、引数・ローカル変数をレシーバとするメンバ参照
  （「定義でないローカル束縛」3,083 件と「段1 で定義が見つかったがメンバで止まった」もの）。引数の型注釈（`table_occurrences` の
  type_reference と `enclosing_fqn`）と、`const a = new Foo()` の初期化子から型を引く
- 段4（一意名）の対象は「ファイル内に束縛が無い」925 件。大半は `console` / `Promise` / `JSON` などの組込みで、プロジェクト内の
  定義と同名の物だけが候補になる。組込みの名前の除外リストが要る
- シンボル単位の再現率（31.0%）が Stage 3 の主な指標になる。計画の基準（再現率・適合率 ≥ 90%）を測る分母は、
  構造的な参照を除いた LSP の関係 1,653 件
- 「LSP のみ」の 5 組は文脈による型付け（インターフェースを満たすオブジェクトリテラル）を含む。これは段3 の型推論でも
  引けない可能性が高い。Stage 3 の基準を決める時に、構造的な参照と同様に扱うか判断する
- 確信度が 1.0 / 0.95 / 0.5 以外の値を取るようになったら、精度検証に confidence 閾値ごとの集計を足す（§11）
- 名前解決はキューが空になった時点でしか走らないため、`showDiagram` を全走査の途中で開くと v2 の関係が古い。Stage 4 で表示に使う時に
  考慮する

### 設定項目（`package.json` の `contributes.configuration`）

| 設定 | 既定 | 用途 |
| ---- | ---- | ---- |
| `crd.ast.enabled` | `true`（Stage 4 以降） | 旧 LSP 経路へのロールバック |
| `crd.ast.lspVerification` | `true` | 低 confidence の LSP 確定を行うか |
| `crd.ast.confidenceThreshold` | `0.7` | LSP 確定を起動する閾値 |
| `crd.ast.maxAmbiguousCandidates` | `4` | 段4' の候補数上限 |
| `crd.graph.showIntraFile` | `false` | ファイル内依存の表示 |

---

## 13. 作業分解（WBS）

| # | 作業 | 対象ファイル | Stage | 状態 |
| - | ---- | ------------ | ----- | ---- |
| 1 | `web-tree-sitter` 依存追加・WASM コピー・`.vscodeignore` | `package.json`, `esbuild.js`, `scripts/ast-assets.mjs`, `.vscodeignore` | 0 | 完了 |
| 2 | パーササービス（初期化・遅延ロード・クエリ実行） | `src/extruct/ast/parser.ts`, `resources.ts`, `index.ts` | 0 | 完了 |
| 3 | TS/JS クエリ定義 | `src/extruct/ast/queries/typescript.scm`, `javascript.scm` | 0 | 完了 |
| 4 | ローカル事実抽出（defs / imports / occurrences を1走査） | `src/extruct/ast/localFacts.ts`, `factsExtractor.ts`, `relationshipKind.ts`, `queries/*.scm`, `parser.ts`（`withMatches()`） | 1 | 完了 |
| 5 | モジュール解決（相対 / tsconfig paths / node_modules） | `src/extruct/ast/moduleResolver.ts` | 1 | 完了 |
| 6 | スキーマ v2・マイグレーション・保存API | `src/codeDb.ts`、埋め戻し: `src/relationship/examine.ts`, `fileDifference/queue.ts`, `fileDifference/item.ts` | 1 | 完了 |
| 7 | `fqn` / `export_name` の付与（AST defs と既存シンボルの照合） | `src/extruct/codeSymbols.ts`（`attachAstKeys()`）, `src/extruct/symbol.ts` | 1 | 完了 |
| 8 | 解決オーケストレータ（段1〜5・confidence） | `src/relationship/resolve.ts`、差分キューへの組み込み: `src/relationship/fileDifference/queue.ts` | 2-3 | 段1〜2 完了（段3〜5 は Stage 3） |
| 9 | 解決 VIEW 群・集約 VIEW | `src/codeDb.ts`（スキーマ v3・`view_relationship_strength`） | 2-3 | 集約 VIEW は完了。解決 VIEW は採用せず TypeScript で解決（§7.3） |
| 10 | 精度検証ハーネスとレポート | `src/test/astAccuracy.verify.ts`, `src/relationship/accuracy.ts`, `verification/ast-accuracy/`, `.vscode-test.mjs`（`accuracy` ラベル） | 2 | 完了 |
| 11 | `computeUpsert()` を Phase A + B 呼び出しへ差し替え、LSP 降格 | `src/relationship/examine.ts`, `src/relationship/codeRelationships.ts` | 4 | 未着手 |
| 12 | 設定項目の追加とロールバック経路 | `package.json`, `src/extension.ts` | 4 | 未着手 |
| 13 | kind / strength / intra-file の描画 | `src/relationship/cosmosAdapter.ts`, `src/webview/graphView.ts` | 5 | 未着手 |
| 14 | 言語追加 | `src/extruct/ast/queries/` | 6 | 未着手 |

### テスト方針

- 単体テスト（vitest, `*.unit.test.ts`）: クエリ結果 → Occurrence 変換、モジュール解決、各解決段のロジック、fqn 生成。**VSCode API に依存しない純関数として切り出す**（既存の `distributor` / `queue` と同じ構成）
- 統合テスト（`@vscode/test-electron`）: 差分更新でのファイル置換・再解決・マイグレーション
- 回帰: §11 の検証レポートを Stage ごとに更新して比較
- 同梱検証: `verification/ast-parser/`（`yarn verify:ast`）で、配布物と同じ配置（`dist/wasm` / `dist/queries`）から WASM がロードされパースできる事を確認する
- 事実抽出の検証: `verification/ast-facts/`（`yarn verify:facts`）で、Stage 1 の受け入れ基準（全ファイルの保存・`fqn` の一意性・処理時間・実際の v1 DB の移行）を自リポジトリで実測する
- DB の単体テストは実 DuckDB（`bindings/`）を vitest から直接使う。拡張機能が作った実際の v1 DB は**複製してから**移行する（元の DB は git 管理下のため書き込まない）

---

## 14. リスクと対策

| リスク | 影響 | 対策 |
| ---- | ---- | ---- |
| 動的ディスパッチ・DI・リフレクション | 解決不能な依存が残る | 段5 で未解決扱い。LSP 併用でも同じ限界であり後退はしない。未解決率をレポートに明示 |
| 段4（一意名）の誤検出 | 存在しない依存線 | confidence 0.6 に固定し UI で「推測エッジ」トグル。閾値は §11 の実測で決定 |
| 同名メソッド過多で段4' が爆発 | ノイズ・性能低下 | 候補数上限で破棄し、破棄件数をログ出力 |
| WASM サイズ増 | `.vsix` 肥大 | 言語ごと遅延ロード。サイズを CHANGELOG に記録し、閾値超過時は言語を別 extension pack へ分離を検討 |
| tree-sitter の位置と LSP の位置のズレ | 判定不能 | `unknown` にフォールバックし既存動作を維持 |
| 既存 DB の移行失敗 | データ損失 | v1 テーブルは Stage 4 まで DROP しない。移行不能時は再構築を案内 |
| 切替時の精度後退 | 依存が消える | Stage 4 は §11 の基準を満たすまで実施しない。`crd.ast.enabled = false` で即時ロールバック |
| 言語ごとの構文差（クエリ保守） | 言語追加コスト | キャプチャ名の規約を統一し、言語追加を `.scm` + モジュール解決の2点に限定 |

---

## 15. 計画2・3との接続

| 計画 | 本計画からの入力 | 備考 |
| ---- | -------------- | ---- |
| 計画2（複雑性メトリクス） | Stage 1 の AST 走査に相乗り（追加コストは走査1回） | `table_metrics` は `symbol_id` を主キーとするが、`fqn` 経由の参照も可能にしておく |
| 計画3（描画再設計） | `view_relationship_strength`（kind / strength / occurrence_count）、`is_intra_file`、`confidence` | 集約エッジの太さ = 内包エッジの strength 合計。confidence は不透明度に割り当てる案 |

---

## 16. マイルストーン改訂（`docs/analysis-plan.md` §マイルストーン の差し替え）

| バージョン | 内容 | 依存 |
| ---------- | ---- | ---- |
| 0.3.36〜0.3.39 | 本計画 Stage 0〜3: AST 基盤 + Phase A/B + 精度検証 | - |
| 0.4.0 | 本計画 Stage 4: 主経路切替・スキーマ v2 確定 | Stage 3 の精度基準達成 |
| 0.4.1 | 本計画 Stage 5: kind / strength の描画 | 0.4.0 |
| 0.4.x | 計画2: メトリクス計測 + スキーマ v3 + maintenanceScore 置換 | Stage 1 の AST 基盤 |
| 0.5.x | 計画3 前半: 円パッキング + LOD + レンダラー基盤 | 本計画と並行可 |
| 0.6.x | 計画3 後半: kind/strength 描画・フィルタ・ナビゲーション | 0.4.x, 0.5.x |
| 0.7.x | 本計画 Stage 6: 言語追加 + エクスポート反映 | 上記 |

---

## 進捗の記録方法

本書と `docs/ast-plan.html`（ロードマップ）は、Stage が進むたびに更新する。

| 更新先 | 何を書くか |
| ------ | ---------- |
| 本書 §12 の段階計画表 | 当該 Stage の**状態**（未着手 / 着手中 / 完了） |
| 本書 §12 の「Stage N の実装結果」 | 受け入れ基準ごとの**実測値と達否**、次 Stage への申し送り |
| 本書 §13 の WBS | 作業ごとの状態と、実際に作った/変えたファイル |
| 本書の該当節（§5〜§11） | 計画と実装が食い違った点、実装して分かった制約 |
| `docs/ast-plan.html` の `PLAN_STATE` | `stages[].status` / `updated` / `nextAction` / `version` / `log`。現在位置・進捗メーター・版数表示は自動で追従する |
| `CHANGELOG.md` | 利用者から見た変更。同梱サイズなど数値も記録する |

計画そのもの（Stage 1 以降の設計）は、実装で妥当性が崩れた時にだけ書き換える。
崩れていない予定を実績のように書かない事。

---

## 最終更新

- **日付**: 2026-10-08
- **バージョン**: 0.3.38（Stage 2 完了時点）
- **作成者**: Claude Code
