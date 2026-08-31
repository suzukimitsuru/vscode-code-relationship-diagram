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
2. v1 → v2: `ALTER TABLE ... ADD COLUMN` と新規テーブル作成のみ（既存行は保持）
3. 旧 `table_relationships`（id ペア）は**読み取り専用で残す**。`fqn` が未付与のシンボルは旧テーブルの関係を表示に使い、再調査で順次 v2 側へ移る
4. 全ファイル再調査が完了したら旧テーブルを DROP（Stage 4 の完了条件）

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

Stage 0 でキャプチャ名の規約を以下に確定した。言語間で統一する事。

| 接頭辞 | 意味 |
| ------ | ---- |
| `def.<種別>` | 定義。`fqn` / `export_name` の元になる |
| `imp.name` / `imp.alias` / `imp.default` / `imp.namespace` | import 束縛のローカル名 |
| `imp.module` / `imp.module.bare` | モジュール指定子（`.bare` は束縛名の無い副作用 import） |
| `ref.<kind>` | 参照出現。`<kind>` がそのまま `RelationshipKind` になる |
| `ref.receiver` | メンバ参照のレシーバ（`a.b()` の `a`、および `this` / `super`） |

型に関する kind（`type_reference` / `implementation`）は JavaScript の文法に存在しないため
`javascript.scm` では定義しない。文法に無いノード型を書くとクエリのコンパイル自体が失敗する。

以下は方針を示す抜粋（実物は上記2ファイル）。

```scheme
; 定義
(class_declaration name: (type_identifier) @def.class)
(interface_declaration name: (type_identifier) @def.interface)
(function_declaration name: (identifier) @def.function)
(method_definition name: (property_identifier) @def.method)

; import 束縛
(import_statement
  (import_clause (named_imports (import_specifier name: (identifier) @imp.name)))
  source: (string) @imp.module)
(import_statement
  (import_clause (namespace_import (identifier) @imp.namespace))
  source: (string) @imp.module)

; 参照出現（キャプチャ名がそのまま kind になる）
(extends_clause value: (identifier) @ref.inheritance)
(implements_clause (type_identifier) @ref.implementation)
(new_expression constructor: (identifier) @ref.instantiation)
(call_expression function: (identifier) @ref.call)
(call_expression function: (member_expression
  object: (identifier) @ref.receiver
  property: (property_identifier) @ref.call))
(type_annotation (type_identifier) @ref.type_reference)
(assignment_expression left: (identifier) @ref.write)
(decorator (identifier) @ref.decorator)
```

言語追加は原則 `.scm` の追加だけで済む構成にする（キャプチャ名の規約を言語間で統一）。

### 6.3 抽出する事実

`src/extruct/ast/localFacts.ts`（新規）

```ts
interface Occurrence {
  path: string;
  line: number; character: number;
  rootName: string;          // a.b.c() の 'a'（単純識別子ならそれ自体）
  memberPath: string | null; // 'b.c'
  kind: RelationshipKind;    // クエリのキャプチャ名から確定
  enclosingFqn: string;      // AST の親を辿って厳密に求める（findSymbol の線形探索を置換）
  scopeId: number;
}
```

`enclosingFqn` を AST の親走査で求める事により、§2 の限界2（参照元シンボルの取り違え）が解消する。

---

## 7. Phase B: 名前解決

### 7.1 多段解決（上位段で当たったら打ち切り）

`src/relationship/resolve.ts`（新規）

| 段 | 解決方法 | confidence | 備考 |
| -- | -------- | ---------- | ---- |
| 1 | **ローカルスコープ束縛** — 同ファイル内の定義・パラメータ・ローカル変数 | 1.0 | `is_intra_file = TRUE` で記録 |
| 2 | **import 束縛** — `root_name` が import 表にあればモジュール解決 → 解決先の export 表を引く | 0.95 | `export * from` の re-export は2段まで追跡 |
| 3 | **レシーバ型の軽量推論** — `this`→囲むクラス、`const a = new Foo()`→`Foo`、パラメータ型注釈 `(a: Foo)`→`Foo`。得た型のメンバ表を継承チェーン込みで引く | 0.8 | メソッド呼び出しの大半をここで拾う |
| 4 | **グローバル名インデックス** — プロジェクト全体で名前が一意なら確定 | 0.6 | |
| 4' | 候補が N 個（N ≤ 閾値、既定4）なら**全候補に conf = 0.5/N** の弱いエッジ。N > 閾値は破棄 | 0.1〜 | 破棄件数をログ出力し閾値調整の材料にする |
| 5 | **未解決** — 外部ライブラリ・組込み | 0 | `is_external` 集約ノードへ寄せる（既定は非表示） |

`strength = Σ(kind の基本重み × confidence)`。推測由来のエッジは自動的に細い線になる。

### 7.2 モジュール解決

`src/extruct/ast/moduleResolver.ts`（新規）。言語ごとに差し替え可能なインターフェースとする。

1. 相対指定 → `path.resolve` + 拡張子候補（`.ts / .tsx / .d.ts / .js / index.*`）
2. `tsconfig.json` の `paths` / `baseUrl` エイリアス
3. `node_modules` にヒット → `is_external = true`
4. 未解決 → `is_external = true, resolved_path = NULL`

### 7.3 SQL による解決

解決はほぼ JOIN であるため TypeScript のループではなく DuckDB に投げる。直列コミット区間が「INSERT + 数本の JOIN」に縮む。

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
| **1** | 未着手 | Phase A: defs / imports / occurrences 抽出、`fqn`・`export_name` 付与、スキーマ v2 とマイグレーション、DuckDB へ保存（**まだ関係抽出には使わない**） | 自リポジトリ全ファイルで occurrences が保存される / `fqn` がファイル内で一意 / パース時間 中央値 < 20ms/ファイル / v1 DB から無停止で移行できる | 0.3.37 |
| **2** | 未着手 | Phase B 段1〜2（ローカル + import 解決）、`kind` 付与、`table_relationships_v2` への保存。表示は従来関係のまま | import 由来の関係の再現率 ≥ 95%（対 LSP、§11 のレポート） / 検証レポートが CI or スクリプトで再生成できる | 0.3.38 |
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
| 4 | ローカル事実抽出（defs / imports / occurrences を1走査） | `src/extruct/ast/localFacts.ts`（新規） | 1 | 未着手 |
| 5 | モジュール解決（相対 / tsconfig paths / node_modules） | `src/extruct/ast/moduleResolver.ts`（新規） | 1 | 未着手 |
| 6 | スキーマ v2・マイグレーション・保存API | `src/codeDb.ts` | 1 | 未着手 |
| 7 | `fqn` / `export_name` の付与（AST defs と既存シンボルの照合） | `src/extruct/codeSymbols.ts` | 1 | 未着手 |
| 8 | 解決オーケストレータ（段1〜5・confidence） | `src/relationship/resolve.ts`（新規） | 2-3 | 未着手 |
| 9 | 解決 VIEW 群・集約 VIEW | `src/codeDb.ts` | 2-3 | 未着手 |
| 10 | 精度検証ハーネスとレポート | `verification/ast-accuracy/`（新規） | 2 | 未着手 |
| 11 | `computeUpsert()` を Phase A + B 呼び出しへ差し替え、LSP 降格 | `src/relationship/examine.ts`, `src/relationship/codeRelationships.ts` | 4 | 未着手 |
| 12 | 設定項目の追加とロールバック経路 | `package.json`, `src/extension.ts` | 4 | 未着手 |
| 13 | kind / strength / intra-file の描画 | `src/relationship/cosmosAdapter.ts`, `src/webview/graphView.ts` | 5 | 未着手 |
| 14 | 言語追加 | `src/extruct/ast/queries/` | 6 | 未着手 |

### テスト方針

- 単体テスト（vitest, `*.unit.test.ts`）: クエリ結果 → Occurrence 変換、モジュール解決、各解決段のロジック、fqn 生成。**VSCode API に依存しない純関数として切り出す**（既存の `distributor` / `queue` と同じ構成）
- 統合テスト（`@vscode/test-electron`）: 差分更新でのファイル置換・再解決・マイグレーション
- 回帰: §11 の検証レポートを Stage ごとに更新して比較
- 同梱検証: `verification/ast-parser/`（`yarn verify:ast`）で、配布物と同じ配置（`dist/wasm` / `dist/queries`）から WASM がロードされパースできる事を確認する

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
| `docs/ast-plan.html` の `PLAN_STATE` | `stages[].status` / `updated` / `nextAction` / `log`。他は自動で追従する |
| `CHANGELOG.md` | 利用者から見た変更。同梱サイズなど数値も記録する |

計画そのもの（Stage 1 以降の設計）は、実装で妥当性が崩れた時にだけ書き換える。
崩れていない予定を実績のように書かない事。

---

## 最終更新

- **日付**: 2026-08-26
- **バージョン**: 0.3.36（Stage 0 完了時点）
- **作成者**: Claude Code
