# Code Relationship Diagram - 実装仕様書

バージョン: 0.1.32
最終更新: 2026-01-23

---

## 目次

1. [アーキテクチャ概要](#1-アーキテクチャ概要)
2. [拡張機能エントリーポイント](#2-拡張機能エントリーポイント)
3. [コア機能実装](#3-コア機能実装)
4. [データベース層](#4-データベース層)
5. [可視化システム実装](#5-可視化システム実装)
6. [マルチプラットフォーム対応](#6-マルチプラットフォーム対応)
7. [パフォーマンス最適化](#7-パフォーマンス最適化)
8. [付録](#付録)

---

## 1. アーキテクチャ概要

### 1.1 ディレクトリ構造

```text
src/
├── extension.ts              # エントリーポイント、コマンド登録
├── codeDb.ts                 # DuckDB操作（CRUD、スキーマ管理）
├── bindingsAutoSign.ts       # macOSバイナリ自動署名
├── extruct/
│   ├── codeFiles.ts          # ファイル列挙、.gitignore統合
│   ├── codeSymbols.ts        # シンボル抽出ロジック
│   ├── symbol.ts             # SymbolModelデータ型
│   ├── distributor.ts        # ファイル変更分類アルゴリズム
│   ├── intervalProcess.ts    # 非同期処理キュー
│   └── queue.ts              # キューデータ構造
├── relationship/
│   ├── examine.ts            # 関係抽出メインロジック
│   ├── codeRelationships.ts  # Relationshipモデル
│   ├── ciseLayout.ts         # CiSEレイアウト計算 + 階層的座標導出
│   ├── communityDetection.ts # Louvainコミュニティ検出
│   └── visualization.ts      # Webview管理、グラフ生成
└── webview/
    └── graphView.ts          # グラフUI（TypeScript、Cytoscape制御）

templates/
├── loading.html              # ローディング画面
└── graph-view.html           # メインビューテンプレート

bindings/
└── duckdb-*.node             # プラットフォーム別ネイティブバインディング
```

### 1.2 データフロー

```text
1. ユーザーがexamineRelationshipsコマンド実行
   ↓
2. ファイル列挙 → 変更分類 (additions/updates/no-changes/removes)
   ↓
3. シンボル抽出 (VSCode DocumentSymbolProvider)
   ↓
4. 関係抽出 (VSCode DefinitionProvider)
   ↓
5. DuckDBへ保存
   ↓
6. showDiagramコマンド → データベースから読み込み
   ↓
7. グラフ要素生成
   ↓
8. Louvainコミュニティ検出 (ファイルレベルのみ)
   ↓
9. CiSEレイアウト計算 (ファイルレベルのみ, 拡張機能側)
   ↓
10. 階層的座標導出 (全4レベル: dir-only, dir-file, file-only, file-symbol)
   ↓
11. 全レベル座標 + グラフ要素 → Webviewへチャンク転送 (5000要素/チャンク)
   ↓
12. Cytoscape.jsで事前計算された座標を使用してレンダリング (presetレイアウト)
```

---

## 2. 拡張機能エントリーポイント

### 2.1 起動ライフサイクル (`extension.ts`)

```typescript
activate(context: ExtensionContext) {
  1. パッケージメタデータの読み込み (version, name)
  2. ワークスペースフォルダとベース名の決定
  3. 設定からファイル関連付けを読み込み
  4. ステータスバー進捗インジケータの初期化
  5. コマンドの登録 (examineRelationships, showDiagram)
  6. 各関連付けパターンのファイル監視をセットアップ
}
```

### 2.2 コマンド実装

#### a) `examineRelationships`

**フロー**:

```typescript
1. .vscode/crd.duckdb でDuckDBを初期化
2. ファイル関連付けに一致するファイルを列挙
3. ファイルを分類: 追加、更新、変更なし、削除
4. 各カテゴリを処理:
   - 追加: 新規ファイルからシンボルを抽出
   - 更新: 変更されたシンボルを再抽出・更新
   - 変更なし: データベースキャッシュから読み込み
   - 削除: データベースから削除
5. VSCodeのインデキシング完了を待機 (最大10回リトライ)
6. すべてのシンボルの関係を抽出
7. クリーンアップとデータベース接続の破棄
```

**進捗追跡**:

- ファイル一覧: 0-33%
- シンボル抽出: 33-66%
- 関係抽出: 66-99%
- 完了: 100%

#### b) `showDiagram`

**フロー**:

```typescript
1. データベースファイルの存在を確認
2. データベースからすべてのシンボルを読み込み
3. データベースからすべての関係を読み込み
4. Visualizationインスタンスを作成
5. ローディング画面を表示
6. グラフデータをチャンクで送信 (5000要素/チャンク)
7. 最終的なマルチビューwebviewをレンダリング
```

### 2.3 ファイル監視

**パターンごとのFileSystemWatcher**:

```typescript
onDidCreate(uri):
  - .gitignoreパターンと照合
  - 作成イベントをログ (情報提供のみ)

onDidDelete(uri):
  - 削除イベントをログ

onDidChange(uri):
  - コンパイルエラーをチェック
  - ERRORレベルの診断がない場合のみ処理
  - 変更イベントをログ
```

**注意**: 現在のバージョンはイベントをログするのみで、更新には手動での再検査が必要です。

---

## 3. コア機能実装

### 3.1 シンボル抽出 (`extruct/codeSymbols.ts`)

#### a) 処理フロー

```typescript
1. vscode.executeDocumentSymbolProvider(document)を実行
2. ドキュメントのルートFileシンボルを作成
3. DocumentSymbolsから階層を再帰的に構築:
   - 各シンボルの一意なIDを生成
   - シンボルコンテンツからハッシュを計算
   - 親子関係をリンク
4. フラット化されたシンボル配列を返す
```

#### b) シンボルモデル (`extruct/symbol.ts`)

```typescript
class SymbolModel {
  id: string              // 複合: ${parentId}/${kind}.${name}@${hash}
  parentId: string | null // 階層的な親
  kind: number            // VSCode SymbolKind (0-25, -1 はディレクトリ)
  name: string            // シンボル名
  path: string            // 相対ファイルパス
  define: Position        // 定義位置
  start: Position         // 選択開始
  end: Position           // 選択終了
  hash: string            // シンボルコンテンツのSHA256 (hex)
  children: SymbolModel[] // 子シンボル
}
```

**ID生成戦略**:

```text
形式: ${parentId}/${kind}.${name}@${hash}

例:
- ファイル: "src/main.ts"
- クラス: "src/main.ts/4.MyClass@abc123def456..."
- メソッド: "src/main.ts/4.MyClass@abc123.../5.getData@def456..."

利点:
- 名前変更に強い (ハッシュは変更される)
- 階層構造が可視的
- 一意な識別
```

**実装**: `src/extruct/codeSymbols.ts:27`

#### c) ハッシュ計算

```typescript
import crypto from 'crypto'

// ドキュメントからシンボルテキストを抽出
const text = document.getText(range)

// SHA256ハッシュ
const hash = crypto.createHash('sha256')
  .update(text, 'utf8')
  .digest('hex')
```

### 3.2 関係抽出 (`relationship/examine.ts`)

#### a) 処理フロー

```typescript
ワークスペース内の各シンボルについて:
  1. symbol.define 位置を取得
  2. vscode.executeDefinitionProvider(document, position)を実行
  3. 他のファイルのみに結果をフィルタ
  4. 抽出されたシンボルで一致するSymbolModelを検索
  5. Relationshipを作成: 参照シンボル -> 定義シンボル
  6. データベースに保存
```

#### b) 関係モデル (`relationship/codeRelationships.ts`)

```typescript
class Relationship {
  reference: SymbolLocation  // 参照が発生する場所
  define: SymbolLocation     // シンボルが定義される場所
}

class SymbolLocation {
  id: string          // シンボルID
  path: string        // ファイルパス
  startLine: number   // 参照行
  startCharacter: number
}
```

**方向**: 参照 → 定義の一方向

- 例: `FileA`が`FileB`から`ClassB`をインポートする場合
  - 参照: `FileA` (import文)
  - 定義: `FileB` (ClassB定義)

### 3.3 ファイル分類 (`extruct/distributor.ts`)

**Distributorアルゴリズム**:

```typescript
distribute<OLD, NEW>(
  olds: OLD[],
  news: NEW[],
  oldKey: (old) => string,
  newKey: (new) => string,
  exists: (old, new) => boolean,
  changed: (old, new) => boolean
): [additions, updates, notchanges, removes]
```

**分類**:

- **Additions (追加)**: `news`に存在し`olds`に存在しないアイテム
- **Updates (更新)**: 両方に存在するが`changed()`がtrueを返すアイテム
- **No-changes (変更なし)**: 両方に存在し`changed()`がfalseを返すアイテム
- **Removes (削除)**: `olds`に存在し`news`に存在しないアイテム

**ファイルでの使用例**:

```typescript
const [additions, updates, notchanges, removes] = distribute(
  dbFiles,
  diskFiles,
  (f) => f.relative_path,
  (f) => f.relative_path,
  (old, new) => old.relative_path === new.relative_path,
  (old, new) => old.updated_at !== new.updated_at
)
```

### 3.4 非同期処理 (`extruct/intervalProcess.ts`)

**IntervalProcessクラス**:

```typescript
class IntervalProcess {
  private queue: Queue<Promise<any>>

  distribute(
    additions: T[],
    updates: T[],
    notchanges: T[],
    addProcess: (item) => Promise<any>,
    updateProcess: (item) => Promise<any>,
    notchangeProcess: (item) => Promise<any>,
    statusBar: StatusBar
  ): void {
    // 3つのフェーズに作業を分配
    // 進捗を追跡: (processed/total) * 100
    // ステータスバーをETAで更新
  }

  async processes(): Promise<PromiseSettledResult<any>[]> {
    // キューに入れられたすべてのpromiseを実行
    // fulfilledとrejectedの両方の結果を返す
  }
}
```

**進捗計算**:

```typescript
percentage = (processed / total) * 100
elapsed_ms = performance.now() - start_time
rest_sec = (elapsed_ms / percentage) * (total - processed) / 1000
eta = formatTime(rest_sec) // HH:MM:SS
```

---

## 4. データベース層

### 4.1 DuckDB統合 (`codeDb.ts`)

#### a) 動的バインディング読み込み

**問題**: 異なるプラットフォームとNode.jsバージョンには異なるネイティブバインディングが必要

**解決策**: 動的選択と読み込み

```typescript
1. プラットフォームを検出: process.platform (darwin/win32/linux)
2. アーキテクチャを検出: process.arch (x64/arm64)
3. 利用可能なバインディングをリスト: /bindings/duckdb-{platform}-{arch}-v*.node
4. ファイル名からバージョンをパース
5. 現在のNode.jsメジャーバージョン以下で最も近いバージョンを選択
6. macOSのみ: バイナリを自動署名 (codesign -s -)
7. モジュールをrequireして返す
```

**サポート構成**:

- macOS: arm64, x64
- Windows: x64
- Linux: x64
- Node.js: 18, 20, 22 (ABI 108, 115, 127)

**実装**: `src/codeDb.ts:13-52`

### 4.2 スキーマ

#### a) テーブル: `table_files`

```sql
CREATE TABLE IF NOT EXISTS table_files (
  relative_path TEXT PRIMARY KEY,
  language_id TEXT,
  updated_at TIMESTAMP
);
CREATE INDEX idx_files_updated_at ON table_files(updated_at);
```

**目的**: 変更タイムスタンプ付きですべてのコードファイルを追跡

#### b) テーブル: `table_symbols`

```sql
CREATE TABLE IF NOT EXISTS table_symbols (
  id TEXT PRIMARY KEY,
  parent_id TEXT,
  name TEXT,
  kind INTEGER,
  path TEXT,
  define_line INTEGER,
  define_character INTEGER,
  start_line INTEGER,
  start_character INTEGER,
  end_line INTEGER,
  end_character INTEGER,
  hash TEXT
);
CREATE INDEX idx_symbols_parent_id ON table_symbols(parent_id);
CREATE INDEX idx_symbols_path ON table_symbols(path);
```

**目的**: 位置情報付きですべてのコードシンボルを保存

#### c) テーブル: `table_relationships`

```sql
CREATE TABLE IF NOT EXISTS table_relationships (
  reference_id TEXT,
  define_id TEXT
);
CREATE INDEX idx_relationships_reference_id ON table_relationships(reference_id);
CREATE INDEX idx_relationships_define_id ON table_relationships(define_id);
```

**目的**: シンボル間の関係を保存

### 4.3 コア操作

#### a) シンボル操作

**バッチ挿入**:

```typescript
symbol_inserts(symbols: SymbolModel[]): void
  - プレースホルダー付きプリペアドステートメント
  - すべてのシンボルを単一トランザクションで
```

**更新**:

```typescript
symbol_update(symbol: SymbolModel): void
  - 位置とプロパティを更新
  - 同じIDを維持
```

**削除**:

```typescript
symbol_delete(ids: string[]): void
  - IDリストで削除

symbol_deleteFile(path: string): void
  - ファイル内のすべてのシンボルを削除 (カスケード)
```

**クエリ**:

```typescript
symbol_query(path: string): SymbolModel[]
  - 単一ファイルのシンボルを読み込み
  - フラット配列 (階層なし)

symbol_queryAll(): SymbolModel[]
  - すべてのシンボルを読み込み
  - 親子関係を再構築
```

**階層再構築**:

```typescript
1. 行からすべてのSymbolModelインスタンスを作成
2. ID→シンボルマップを構築
3. 2回目のパス: parentIdを介して親に子をリンク
4. メモリ内階層を持つシンボル配列を返す
```

#### b) 関係操作

**バッチ挿入**:

```typescript
relationship_inserts(relationships: Relationship[]): void
  - reference_id, define_idのペアを挿入
  - 単一トランザクション
```

**削除**:

```typescript
relationship_deleteFile(path: string): void
  - 参照または定義がファイル内にある関係を削除

relationship_deleteSymbols(ids: string[]): void
  - 参照または定義がIDリストにある関係を削除

relationship_deletePairs(pairs: [string, string][]): void
  - 特定の参照-定義ペアを削除
```

**クエリ**:

```typescript
relationship_queryAll(): Relationship[]
  - シンボルテーブルと2回LEFT JOIN
  - 位置情報を持つ完全なRelationshipオブジェクトを再構築

relationship_definePath(path: string): Relationship[]
  - 定義ファイルパスでフィルタ
```

**複雑なJoinパターン**:

```sql
SELECT
  r.reference_id, s_ref.path AS reference_path, s_ref.start_line,
  r.define_id, s_def.path AS define_path, s_def.start_line
FROM table_relationships r
LEFT JOIN table_symbols s_ref ON r.reference_id = s_ref.id
LEFT JOIN table_symbols s_def ON r.define_id = s_def.id
```

---

## 5. 可視化システム実装

### 5.1 アーキテクチャ (`relationship/visualization.ts`)

#### a) 初期化フロー

```text
showDiagram(symbols, relationships):
  1. WebviewPanelを作成 (ViewColumn.One, retain context)
  2. メッセージハンドラをセットアップ:
     - webviewReady: 初期化完了を通知
     - openFile: ファイル/行へ移動
     - exportHTML: スタンドアロンHTMLを作成
     - allLevelPositions: 全レベル座標を受信
  3. loading.htmlテンプレートを表示
  4. symbols/relationshipsからグラフ要素を作成
  5. Louvainコミュニティ検出 (ファイルレベルのみ)
  6. CiSEレイアウト計算 (ファイルレベルのみ)
  7. 階層的座標導出 (全4レベル)
  8. graph-view.htmlのプレースホルダーを置換
  9. webview HTMLを送信
  10. webviewReadyメッセージを待機 (最大10秒タイムアウト)
  11. グラフデータをチャンクで送信 (5000要素/チャンク)
  12. 全レベル座標を送信 (allLevelPositions)
  13. 完了メッセージを送信
```

#### b) Webview初期化ハンドシェイク

**問題**: webviewの準備前にpostMessageを送信するとデータ損失

**解決策**: 双方向初期化プロトコル

```typescript
// 拡張機能側
let webviewReadyResolve
const webviewReadyPromise = new Promise(resolve => {
  webviewReadyResolve = resolve
})

// メッセージハンドラ
case 'webviewReady':
  webviewReadyResolve()
  break

// データ送信前
await Promise.race([
  webviewReadyPromise,
  new Promise((_, reject) =>
    setTimeout(() => reject('timeout'), 10000)
  )
])

// Webview側 (graphView.ts)
if (!window.IS_STANDALONE && vscode) {
  vscode.postMessage({ type: 'webviewReady' })
}
```

**実装**:
- `src/relationship/visualization.ts:130-143`
- `src/webview/graphView.ts:284-290`

### 5.2 グラフ要素の作成

#### a) ファイルレベルグラフ

**ノード**:

```typescript
{
  data: {
    id: symbol.id,           // ファイルパス
    label: basename(path),   // ファイル名のみ
    kind: 0,                 // SymbolKind.File
    path: symbol.path,
    symbolCount: countChildren(symbol) // サイジング用
  }
}
```

**エッジ**:

```typescript
// ファイルペアごとに関係を集約
for each relationship:
  key = `${ref.path}|||${def.path}`
  count[key]++
  details[key].push({
    referenceSymbolName, defineSymbolName,
    referenceLine, defineLine,
    referencePath, definePath
  })

// エッジを作成
{
  data: {
    id: `file-relation-${source}-${target}`,
    source: sourceFileId,
    target: targetFileId,
    relationshipType: 'file-relationship',
    relationshipCount: count,
    relationshipDetails: details[]
  }
}
```

#### b) シンボルレベルグラフ

**ノード**: すべてのシンボル (files + classes + methods + ...)

```typescript
{
  data: {
    id: symbol.id,
    label: symbol.name,
    kind: symbol.kind,
    path: symbol.path,
    line: symbol.define.line,
    parent: symbol.parentId  // 階層ビュー用
  }
}
```

**エッジ**: シンボル間の直接関係

```typescript
{
  data: {
    id: `symbol-relation-${ref.id}-${def.id}`,
    source: ref.id,
    target: def.id,
    relationshipType: 'symbol-relationship'
  }
}
```

### 5.3 チャンク化データ転送

**理由**: 大きなグラフ (30,000以上のノード) はpostMessageサイズ制限を超える

**実装**:

```typescript
const CHUNK_SIZE = 5000

// ノードを送信
for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
  await panel.webview.postMessage({
    type: 'graphData',
    dataType: 'nodes',
    chunk: nodes.slice(i, i + CHUNK_SIZE),
    chunkIndex: Math.floor(i / CHUNK_SIZE),
    totalChunks: Math.ceil(nodes.length / CHUNK_SIZE),
    isLastChunk: i + CHUNK_SIZE >= nodes.length
  })
  await sleep(50) // UI更新を許可
}

// エッジを送信 (同じパターン)
// ...

// 完了を送信
await panel.webview.postMessage({
  type: 'graphDataComplete',
  totalNodes: nodes.length,
  totalEdges: edges.length
})
```

**実装**: `src/relationship/visualization.ts:200-250`

**Webview受信**:

```typescript
let allNodes = []
let allEdges = []

window.addEventListener('message', event => {
  if (event.data.type === 'graphData') {
    const { dataType, chunk } = event.data
    if (dataType === 'nodes') {
      allNodes.push(...chunk)
    } else {
      allEdges.push(...chunk)
    }
  } else if (event.data.type === 'graphDataComplete') {
    // すべてのデータ受信、ビューを初期化
    initializeView('file-deps')
  }
})
```

### 5.4 ディレクトリグループ化実装

**目的**: ディレクトリ構造でファイルを視覚的に整理

**実装**:

```typescript
// 1. ディレクトリツリーを構築
function buildDirectoryTree(filePaths: string[]):
  Map<dirPath, parentDirPath> {

  for each filePath:
    parts = filePath.split('/')
    parts.pop()  // ファイル名を削除

    for each directory level:
      currentPath = join(parts[0..i])
      if not in map:
        map.set(currentPath, parentPath)
}

// 2. ディレクトリノードを作成
directoryNodes = []
for each (dirPath, parent) in tree:
  directoryNodes.push({
    data: {
      id: `dir:${dirPath}`,
      label: basename(dirPath),
      kind: -1,  // 特別: ディレクトリ
      parent: parent ? `dir:${parent}` : null
    }
  })

// 3. ファイルノードに親を更新
for each fileNode:
  dirPath = dirname(fileNode.path)
  fileNode.data.parent = `dir:${dirPath}`

// 4. Cytoscapeが複合ノードをレンダリング
// ファイルはディレクトリ内に視覚的にグループ化される
```

**実装**: `src/webview/graphView.ts`

### 5.5 テンプレートシステム

**プレースホルダー置換** (`replacePlaceholders()`):

```typescript
const replacements = {
  // ライブラリ
  'CYTOSCAPE_URI_PLACEHOLDER':
    isStandalone ? 'https://unpkg.com/...' : webview.asWebviewUri(...),

  // テーマ色
  'BACKGROUND_COLOR_PLACEHOLDER':
    isDarkTheme ? '#1e1e1e' : '#ffffff',
  'CONTROLS_COLOR_PLACEHOLDER':
    isDarkTheme ? '#cccccc' : '#333333',

  // データ
  'ELEMENTS_PLACEHOLDER':
    JSON.stringify([...nodes, ...edges]),

  // UIコンポーネント
  'EXPORT_BUTTON_PLACEHOLDER':
    createExportButton(isStandalone),

  // ワークスペース名
  'WORKSPACE_NAME_PLACEHOLDER':
    workspaceName
}

for (const [placeholder, value] of Object.entries(replacements)) {
  result = result.replace(new RegExp(placeholder, 'g'), value)
}
```

**エクスポートボタン**:

```typescript
function createExportButton(isStandalone) {
  if (isStandalone) {
    // スタンドアロン版ではエクスポートボタンなし
    return ''
  } else {
    // VSCode拡張版ではHTMLエクスポートボタン
    return `<button onclick="exportHTML()" title="Export HTML">
            <i class="fa fa-floppy-o" aria-hidden="true"></i>
        </button>`
  }
}
```

**EXPORT_BUTTON_PLACEHOLDERパターン**: スタンドアロン版ではボタンを一切表示しないため、JavaScriptでの表示/非表示切り替えではなく、テンプレート置換時に空文字列を返すことで対応。これにより、スタンドアロン版で一瞬ボタンが表示される問題を回避しています。

### 5.6 スタンドアロンHTMLエクスポート

#### a) アーキテクチャ

**目的**: VSCodeなしで動作する完全に自己完結したHTMLファイルを生成

**実装フロー**:

```text
exportStandaloneHTML():
  1. ファイル保存ダイアログを表示 (拡張子: .html)
  2. ユーザーが保存先を選択
  3. データファイル (.data.js) を生成 → writeDataJsFileInChunks()
  4. HTMLファイルを生成 → テンプレート + プレースホルダー置換
  5. 両ファイルを保存: {filename}.html, {filename}.crd.data.js
  6. オプション: ブラウザで開く
```

**実装**: `src/relationship/visualization.ts:664-769`

#### b) データファイル生成 (ストリーム書き込み)

**問題**: 大規模プロジェクト (例: tockプロジェクト) では `JSON.stringify()` が "Invalid string length" エラーをスローする

**原因**: V8エンジンの文字列長制限 (~512MB-1GB)

**解決策**: ストリーム書き込みを使用して、データを一度に1ノード/エッジずつ書き込む

```typescript
async writeDataJsFileInChunks(filepath: string, data: { nodes, edges }) {
  const writeStream = fs.createWriteStream(filepath, { encoding: 'utf8' })

  // JavaScriptファイルヘッダー
  writeStream.write('// Graph data for standalone HTML\n')
  writeStream.write('window.GRAPH_DATA = {\n  "nodes": [\n')

  // ノードを1つずつ書き込み
  for (let i = 0; i < data.nodes.length; i++) {
    const nodeJson = JSON.stringify(data.nodes[i])
    writeStream.write('    ' + nodeJson + (i < data.nodes.length - 1 ? ',\n' : '\n'))

    // 1000ノードごとにログ出力 (進捗追跡)
    if (i > 0 && i % 1000 === 0) {
      this.logs.log(`Writing nodes: ${i}/${data.nodes.length}`)
    }
  }

  writeStream.write('  ],\n  "edges": [\n')

  // エッジを1つずつ書き込み
  for (let i = 0; i < data.edges.length; i++) {
    const edgeJson = JSON.stringify(data.edges[i])
    writeStream.write('    ' + edgeJson + (i < data.edges.length - 1 ? ',\n' : '\n'))
  }

  writeStream.write('  ]\n};\n')
  writeStream.end()
}
```

**主な利点**:
- メモリ使用量が一定 (データサイズに依存しない)
- V8の文字列長制限を回避
- 大規模プロジェクト (数万ノード) でも動作

**ファイル形式**: JavaScriptファイル (`.data.js`)、JSONファイルではない

**理由**: ブラウザの `file://` プロトコルでJSONファイルを `fetch()` するとCORSエラーが発生するため

**実装**: `src/relationship/visualization.ts:771-832`

#### c) 動的データ読み込み

**スタンドアロンHTML側の実装** (`src/webview/graphView.ts`):

```typescript
async function loadExternalDataJs(dataJsUri: string) {
  // 動的にscriptタグを作成して読み込む
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = dataJsUri
    script.async = true

    script.onload = () => resolve()
    script.onerror = (error) => reject(new Error('Failed to load data file'))

    document.head.appendChild(script)
  })

  // window.GRAPH_DATAが設定されているか確認
  if (window.GRAPH_DATA && window.GRAPH_DATA.nodes && window.GRAPH_DATA.edges) {
    allNodes = window.GRAPH_DATA.nodes
    allEdges = window.GRAPH_DATA.edges
    isDataLoaded = true

    // ビューを初期化
    await initView()
  }
}
```

**主な利点**:
- CORS問題を回避 (JavaScriptファイルは `file://` プロトコルで動作)
- 初期HTMLロードの高速化 (データは後から読み込まれる)
- ブラウザのキャッシュを活用可能

**実装**: `src/webview/graphView.ts`

#### d) 経過表示の実装

**Webview → Extension通信**:

スタンドアロンHTMLではないモード (VSCode内) で、エクスポート中の経過を表示:

```typescript
// Webview側 (graphView.ts)
function exportHTML() {
  showProgress()
  updateProgress(10, 'Preparing HTML export...')

  vscode.postMessage({
    type: 'exportHTML',
    data: { nodes: allNodes, edges: allEdges }
  })

  updateProgress(50, 'Waiting for file save...')
}

// メッセージハンドラ
case 'exportHTMLProgress':
  updateProgress(message.percent, message.message)
  break
case 'exportHTMLComplete':
  updateProgress(100, 'Export complete!')
  break
```

**Extension → Webview通信**:

```typescript
// Extension側 (visualization.ts)
async exportStandaloneHTML(filename: string, data: { nodes, edges }) {
  await this.updateExportProgress(60, 'Opening file save dialog...')

  const saveUri = await vscode.window.showSaveDialog({...})

  if (saveUri) {
    await this.updateExportProgress(70, 'Writing data file...')
    await this.writeDataJsFileInChunks(dataJsPath, data)

    await this.updateExportProgress(90, 'Writing HTML file...')
    await vscode.workspace.fs.writeFile(saveUri, Buffer.from(html_text, 'utf8'))

    await this.notifyExportComplete()
  }
}

async updateExportProgress(percent: number, message: string) {
  if (this.panel) {
    await this.panel.webview.postMessage({
      type: 'exportHTMLProgress',
      percent: percent,
      message: message
    })
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
```

**実装**:
- Webview側: `src/webview/graphView.ts`
- Extension側: `src/relationship/visualization.ts`

---

## 6. マルチプラットフォーム対応

### 6.1 DuckDBネイティブバインディング

**課題**: DuckDBはプラットフォーム固有およびNode.jsバージョン固有のネイティブバインディングが必要

**解決策**: 事前コンパイル済みバインディング + 動的読み込み

#### a) サポートプラットフォーム

| プラットフォーム | アーキテクチャ | Node.jsバージョン |
|------------------|----------------|-------------------|
| macOS            | arm64, x64     | 18, 20, 22        |
| Windows          | x64            | 18, 20            |
| Linux            | x64            | 18, 20, 22        |

**注意**: Windows Node.js 22/23は互換性の問題によりサポートされていません

#### b) バインディング選択アルゴリズム

```typescript
function loadDuckDBBindings() {
  1. プラットフォームとアーキテクチャを検出
     platform = process.platform  // 'darwin', 'win32', 'linux'
     arch = process.arch          // 'x64', 'arm64'

  2. /bindingsディレクトリ内の利用可能なバインディングをリスト
     パターン: duckdb-{platform}-{arch}-v*.node
     例: duckdb-darwin-arm64-v20.node

  3. ファイル名からバージョンをパース
     メジャーバージョン番号を抽出 (18, 20, 22)

  4. 最適な一致を選択
     現在のNode.jsメジャーバージョン以下で最も近いバージョンを検索
     一致なし: 利用可能な最高バージョンを使用 (フォールバック)

  5. バインディングパスを構築
     path = join(__dirname, '../bindings', filename)

  6. プラットフォーム固有の処理
     macOSの場合: バイナリを自動署名 (下記参照)

  7. モジュールをrequireして返す
     return require(path)
}
```

#### c) 選択例

```text
現在の環境: macOS arm64, Node.js 20.x
利用可能なバインディング:
  - duckdb-darwin-arm64-v18.node
  - duckdb-darwin-arm64-v20.node
  - duckdb-darwin-arm64-v22.node

選択: duckdb-darwin-arm64-v20.node (完全一致)
```

```text
現在の環境: Windows x64, Node.js 23.x
利用可能なバインディング:
  - duckdb-win32-x64-v18.node
  - duckdb-win32-x64-v20.node

選択: duckdb-win32-x64-v20.node (最高バージョンへフォールバック)
```

### 6.2 macOSコード署名 (`bindingsAutoSign.ts`)

**理由**: macOS GatekeeperがM1/M2 Macで署名されていないバイナリの実行を防ぐ

**実装**:

```typescript
export async function autoSignBinary(binPath: string):
  Promise<boolean> {

  // すでに署名されているか確認
  const checkCmd = `codesign -v "${binPath}" 2>&1`
  const checkResult = execSync(checkCmd, { encoding: 'utf8' })

  if (checkResult.includes('valid on disk')) {
    console.log('Binary already signed')
    return true
  }

  // アドホック署名で署名
  const signCmd = `codesign -s - -f "${binPath}"`
  execSync(signCmd, { encoding: 'utf8' })

  // 署名を検証
  const verifyCmd = `codesign -v "${binPath}"`
  execSync(verifyCmd, { encoding: 'utf8' })

  console.log('Binary signed successfully')
  return true
}
```

**アドホック署名** (`-s -`):

- 開発者証明書なしで自己署名
- ローカル実行に十分
- IDを検証しない (配布用ではない)

**エラー処理**:

```typescript
try {
  autoSignBinary(bindingPath)
} catch (error) {
  console.warn('Failed to sign binary, may not work on M1/M2 Macs')
  console.warn(error)
  // とにかく続行、動作するかもしれない
}
```

### 6.3 GitHub Actionsビルドプロセス

**ワークフロー**: `.github/workflows/build-duckdb-binaries.yml`

**マトリックス戦略**:

```yaml
matrix:
  os: [ubuntu-latest, macos-13, macos-14, windows-latest]
  node-version: [18, 20, 22]
  exclude:
    - os: windows-latest
      node-version: 22
    - os: windows-latest
      node-version: 23
```

**ビルドステップ**:

```yaml
1. リポジトリをチェックアウト
2. Node.jsをセットアップ (指定されたバージョン)
3. ソースからduckdbをインストール
   npm install duckdb --build-from-source
4. ネイティブバインディング (.nodeファイル) を抽出
5. 標準形式に名前変更
   duckdb-{platform}-{arch}-v{major}.node
6. macOSのみ: バイナリをコード署名
   codesign -s - -f binding.node
7. GitHubにアーティファクトをアップロード
8. 最終ジョブですべてのアーティファクトをダウンロード
9. /bindings配下のリポジトリにコミット
```

**出力ファイル**:

```text
bindings/
├── duckdb-darwin-arm64-v18.node
├── duckdb-darwin-arm64-v20.node
├── duckdb-darwin-arm64-v22.node
├── duckdb-darwin-x64-v18.node
├── duckdb-darwin-x64-v20.node
├── duckdb-darwin-x64-v22.node
├── duckdb-linux-x64-v18.node
├── duckdb-linux-x64-v20.node
├── duckdb-linux-x64-v22.node
├── duckdb-win32-x64-v18.node
└── duckdb-win32-x64-v20.node
```

---

## 7. パフォーマンス最適化

### 7.1 チャンク化処理

#### a) ファイル処理

**問題**: 数千のファイルを処理するとVSCodeが圧倒される

**解決策**: 進捗追跡付きキューベース分配

```typescript
class IntervalProcess {
  distribute(additions, updates, notchanges, ...) {
    const total = additions.length + updates.length + notchanges.length
    const phaseSize = total / 3

    // フェーズ1: 追加 (0-33%)
    for (const item of additions) {
      queue.enqueue(addProcess(item))
      updateProgress((processed / phaseSize) * 33)
    }

    // フェーズ2: 更新 (33-66%)
    for (const item of updates) {
      queue.enqueue(updateProcess(item))
      updateProgress(33 + (processed / phaseSize) * 33)
    }

    // フェーズ3: 変更なし (66-99%)
    for (const item of notchanges) {
      queue.enqueue(notchangeProcess(item))
      updateProgress(66 + (processed / phaseSize) * 33)
    }
  }
}
```

#### b) グラフデータ転送

**問題**: 大きなグラフ (30,000以上のノード) は単一のpostMessage制限を超える

**解決策**: 非同期反復を伴う5000要素チャンク

```typescript
const CHUNK_SIZE = 5000

for (let i = 0; i < nodes.length; i += CHUNK_SIZE) {
  await panel.webview.postMessage({
    type: 'graphData',
    dataType: 'nodes',
    chunk: nodes.slice(i, i + CHUNK_SIZE),
    chunkIndex: i / CHUNK_SIZE,
    totalChunks: Math.ceil(nodes.length / CHUNK_SIZE)
  })

  // UIイベントループの処理を許可
  await new Promise(resolve => setTimeout(resolve, 50))
}
```

**利点**:

- メッセージサイズ制限を回避
- 転送中の進捗フィードバックを提供
- UIをレスポンシブに保つ

### 7.2 データベースインデックス

**作成されたインデックス**:

```sql
-- ファイル
CREATE INDEX idx_files_updated_at ON table_files(updated_at);

-- シンボル
CREATE INDEX idx_symbols_parent_id ON table_symbols(parent_id);
CREATE INDEX idx_symbols_path ON table_symbols(path);

-- 関係
CREATE INDEX idx_relationships_reference_id ON table_relationships(reference_id);
CREATE INDEX idx_relationships_define_id ON table_relationships(define_id);
```

**クエリ最適化**:

高速パスクエリ:

```sql
-- 単一ファイルのシンボルを読み込み
SELECT * FROM table_symbols WHERE path = ?
-- idx_symbols_pathを使用

-- 定義による関係を読み込み
SELECT * FROM table_relationships r
LEFT JOIN table_symbols s ON r.define_id = s.id
WHERE s.path = ?
-- idx_relationships_define_id + idx_symbols_pathを使用
```

**バッチ操作**:

```typescript
// 複数挿入用の単一トランザクション
db.exec('BEGIN TRANSACTION')
for (const symbol of symbols) {
  stmt.run(symbol.id, symbol.name, ...)
}
db.exec('COMMIT')
```

### 7.3 適応型レンダリング

**戦略**: 大規模データセットの複雑さを軽減

#### a) 4レベルのノード表示切り替え

```typescript
// ノードレベルの定義
type NodeLevel = 'dir-only' | 'dir-file' | 'file-only' | 'file-symbol'

// データセットサイズに応じた制限
const SMALL_LIMIT = 15000
const MEDIUM_LIMIT = 50000

if (allNodes.length <= SMALL_LIMIT) {
  // 小規模: 全4レベル使用可能
  availableLevels = ['dir-only', 'dir-file', 'file-only', 'file-symbol']
} else if (allNodes.length <= MEDIUM_LIMIT) {
  // 中規模: file-symbol以外
  availableLevels = ['dir-only', 'dir-file', 'file-only']
} else {
  // 大規模: file-symbol以外、自動的にfile-onlyに切り替え
  availableLevels = ['dir-only', 'dir-file', 'file-only']
  currentLevel = 'file-only'
}
```

#### b) ノードレベルごとの要素生成

```typescript
function createElements(nodeLevel: NodeLevel) {
  switch (nodeLevel) {
    case 'dir-only':
      // ディレクトリノードのみ、エッジは集約
      return { nodes: directoryNodes, edges: aggregatedEdges }
    case 'dir-file':
      // ディレクトリ + ファイル、階層構造
      return { nodes: [...directoryNodes, ...fileNodes], edges: fileEdges }
    case 'file-only':
      // ファイルノードのみ
      return { nodes: fileNodes, edges: fileEdges }
    case 'file-symbol':
      // ファイル + シンボル、詳細表示
      return { nodes: [...fileNodes, ...symbolNodes], edges: symbolEdges }
  }
}
```

**利点**:

- ユーザーが表示レベルを選択可能
- 大規模コードベースでもパフォーマンスを維持
- Directory Onlyで全体構造を把握、File + Symbolで詳細分析

### 7.4 階層的レイアウト導出（v0.1.32～）

**問題**: 大規模プロジェクト（39,000+ノード）でのCiSEレイアウト計算がタイムアウト

**解決策**: ファイルレベルのみCiSE計算し、他レベルは座標を導出

```text
階層的導出アプローチ:
1. ファイルノードのみでCiSEレイアウトを計算（計算量大幅削減）
2. 他の3レベルはファイル座標から導出:
   - dir-only: ディレクトリ座標 = 含まれるファイルの重心
   - dir-file: ディレクトリ（重心） + ファイル（計算済み）
   - file-only: ファイル座標をそのまま使用
   - file-symbol: シンボルは親ファイルの周囲に円形配置
```

**実装（v0.1.32～）**:

```typescript
// src/relationship/ciseLayout.ts

// 全レベルの座標を導出
export function deriveAllLevelPositions(
    filePositions: LayoutPosition[],
    allNodes: any[],
    logs: Logs
): AllLevelPositions {
    // ファイル座標をMapに変換
    const filePositionMap = new Map<string, {x: number, y: number}>();
    filePositions.forEach(pos => {
        filePositionMap.set(pos.id, { x: pos.x, y: pos.y });
    });

    // ノードを分類
    const fileNodes = allNodes.filter(n => n.data.kind === 0);
    const symbolNodes = allNodes.filter(n => n.data.kind > 0);

    // 1. ディレクトリ座標を導出（重心計算）
    const dirPositions = deriveDirectoryPositions(fileNodes, filePositionMap);

    // 2. シンボル座標を導出（親ファイル周囲に円形配置）
    const symbolPositions = deriveSymbolPositions(symbolNodes, filePositionMap);

    return {
        'dir-only': dirPositions,
        'dir-file': [...dirPositions, ...filePositions],
        'file-only': filePositions,
        'file-symbol': [...filePositions, ...symbolPositions]
    };
}

// ディレクトリ座標の導出（含まれるファイルの重心）
function deriveDirectoryPositions(fileNodes, filePositionMap): LayoutPosition[] {
    const dirToFiles = new Map<string, string[]>();

    // ディレクトリごとにファイルをグループ化
    fileNodes.forEach(node => {
        const parts = node.data.path.split('/');
        parts.pop(); // ファイル名を除去

        for (let i = 1; i <= parts.length; i++) {
            const dirPath = parts.slice(0, i).join('/');
            const dirId = `dir:${dirPath}`;
            if (!dirToFiles.has(dirId)) {
                dirToFiles.set(dirId, []);
            }
            dirToFiles.get(dirId).push(node.data.id);
        }
    });

    // 各ディレクトリの重心を計算
    const positions: LayoutPosition[] = [];
    dirToFiles.forEach((fileIds, dirId) => {
        let sumX = 0, sumY = 0, count = 0;
        fileIds.forEach(fileId => {
            const pos = filePositionMap.get(fileId);
            if (pos) {
                sumX += pos.x; sumY += pos.y; count++;
            }
        });
        if (count > 0) {
            positions.push({ id: dirId, x: sumX / count, y: sumY / count });
        }
    });

    return positions;
}

// シンボル座標の導出（親ファイル周囲に円形配置）
function deriveSymbolPositions(symbolNodes, filePositionMap): LayoutPosition[] {
    const fileToSymbols = new Map<string, any[]>();

    // 親ファイルごとにシンボルをグループ化
    symbolNodes.forEach(node => {
        const parentId = node.data.parent;
        if (parentId) {
            if (!fileToSymbols.has(parentId)) {
                fileToSymbols.set(parentId, []);
            }
            fileToSymbols.get(parentId).push(node);
        }
    });

    const positions: LayoutPosition[] = [];
    const BASE_RADIUS = 50;
    const RADIUS_PER_SYMBOL = 5;

    fileToSymbols.forEach((symbols, parentId) => {
        const parentPos = filePositionMap.get(parentId);
        if (!parentPos) return;

        const radius = BASE_RADIUS + symbols.length * RADIUS_PER_SYMBOL;
        symbols.forEach((symbol, index) => {
            const angle = (2 * Math.PI * index) / symbols.length;
            positions.push({
                id: symbol.data.id,
                x: parentPos.x + radius * Math.cos(angle),
                y: parentPos.y + radius * Math.sin(angle)
            });
        });
    });

    return positions;
}
```

**WebView側での使用**:

```typescript
// src/webview/graphView.ts

// 全レベル座標の受信
if (message.type === 'allLevelPositions') {
    const { positions } = message;
    const levels = ['dir-only', 'dir-file', 'file-only', 'file-symbol'];

    levels.forEach(level => {
        if (positions[level]) {
            const positionMap = new Map<string, {x: number, y: number}>();
            positions[level].forEach(pos => {
                positionMap.set(pos.id, { x: pos.x, y: pos.y });
            });
            layoutPositions.set(level, positionMap);
        }
    });
}

// レベル切り替え時
function getCommunityLayout(): any {
    const currentLevel = nodeLevel || 'file-only';
    const levelPositions = layoutPositions.get(currentLevel);

    if (levelPositions && levelPositions.size > 0) {
        return {
            name: 'preset',
            positions: (node) => levelPositions.get(node.id()) || { x: 0, y: 0 }
        };
    }

    // フォールバック: CiSE/COSEで再計算
    return communityClusterArray.length > 0
        ? { name: 'cise', clusters: communityClusterArray }
        : { name: 'cose' };
}
```

**利点**:
- **大規模プロジェクト対応**: 39,000ノード → 1,072ファイルのみ計算
- **全4レベルで瞬時切り替え**: 事前計算された座標を使用
- **HTMLエクスポート後も全レベル対応**: スタンドアロンで動作
- **レベル間で一貫したレイアウト**: ノードが飛ばない

**パフォーマンス比較**:

| データセット | 旧実装（全ノード計算） | 新実装（階層的導出） |
|------------|---------------------|---------------------|
| 1,072ファイル + 38,296シンボル | タイムアウト | 2-3秒 |
| レベル切り替え | 再計算必要 | 瞬時（0.1秒未満） |
| HTMLエクスポート | 1レベルのみ | 全4レベル対応 |

### 7.5 メモリ管理

#### a) シンボルキャッシュ

**戦略**: 操作間で抽出されたシンボルを再利用

```typescript
// 検査中のグローバルキャッシュ
const _symbol_all = new Map<string, SymbolModel>()

// 抽出されたシンボルをキャッシュ
_symbol_all.set(filePath, extractedSymbols)

// 関係構築時に再利用
const symbols = _symbol_all.get(filePath)
```

**利点**:

- シンボルの再抽出を回避
- VSCode API呼び出しを削減
- より高速な関係抽出

#### b) Promise Settlement

**パターン**: `Promise.all()`の代わりに`Promise.allSettled()`

```typescript
const promises = files.map(file => extractRelationships(file))
const results = await Promise.allSettled(promises)

// 成功と失敗の両方を処理
for (const result of results) {
  if (result.status === 'fulfilled') {
    // 成功した抽出を処理
  } else {
    // エラーをログし、他のファイルを続行
    console.error(result.reason)
  }
}
```

**利点**:

- 1つのファイル失敗がプロセス全体を停止しない
- デバッグ用にすべてのエラーを収集
- エラーがあっても最大のデータ抽出

### 7.6 キューの遅延削除

**キュー実装**:

```typescript
class Queue<T> {
  private items = new Map<number, T>()
  private head = 0
  private tail = 0

  enqueue(item: T): void {
    this.items.set(this.tail++, item)
  }

  dequeue(): T | undefined {
    if (this.isEmpty()) return undefined

    const item = this.items.get(this.head)
    this.items.delete(this.head++)

    // インデックスをリセットするための遅延クリーンアップ
    if (this.isEmpty()) {
      this.head = 0
      this.tail = 0
    }

    return item
  }
}
```

**利点**:

- O(1) enqueueとdequeue
- 空の時の自動クリーンアップ
- 大きなキューでメモリ効率的

---

## 付録

### 付録A: 主要アルゴリズム

#### A.1 シンボルID生成

```text
入力: 親シンボル, DocumentSymbol, ドキュメントテキスト
出力: 一意なシンボルID

アルゴリズム:
  1. rangeを使用してドキュメントからシンボルテキストを抽出
  2. テキストのSHA256ハッシュを計算
  3. ルートファイルシンボルの場合:
       id = ファイルパス
     それ以外:
       id = ${parent.id}/${kind}.${name}@${hash}
  4. idを返す

例:
  ファイル: "src/main.ts"
  ファイル内のクラス: "src/main.ts/4.MyClass@abc123def..."
  クラス内のメソッド: "src/main.ts/4.MyClass@abc.../5.getData@def456..."
```

#### A.2 ファイル分配

```text
入力: 古いファイル (DB), 新しいファイル (ディスク)
出力: 追加, 更新, 変更なし, 削除

アルゴリズム:
  1. マップを作成: oldMap[path] = file, newMap[path] = file
  2. 各新しいファイルについて:
       oldMapにない場合: additions.push(file)
       タイムスタンプが変更されている場合: updates.push(file)
       それ以外: no-changes.push(file)
  3. 各古いファイルについて:
       newMapにない場合: removes.push(file)
  4. [additions, updates, no-changes, removes]を返す
```

#### A.3 階層再構築

```text
入力: データベースからのフラットなシンボル配列
出力: 親子リンクを持つシンボル配列

アルゴリズム:
  1. symbolMapを作成: id -> SymbolModel
  2. クエリ結果の各行について:
       行からSymbolModelを作成
       symbolMap[row.id] = symbol
       symbols.push(symbol)
  3. symbolsの各シンボルについて:
       symbol.parentIdが存在する場合:
         parent = symbolMap[symbol.parentId]
         parent.children.push(symbol)
  4. symbolsを返す
```

#### A.4 関係抽出

```text
入力: シンボル, ドキュメント, すべてのシンボル
出力: relationships[]

アルゴリズム:
  1. position = symbol.define
  2. locations = vscode.executeDefinitionProvider(document, position)
  3. locationsの各locationについて:
       location.uri != document.uriの場合:  // 異なるファイル
         targetPath = relative(workspace, location.uri)
         targetLine = location.range.start.line

         // 一致するシンボルを検索
         targetSymbol = findSymbol(allSymbols, targetPath, targetLine)

         targetSymbolが存在する場合:
           relationship = new Relationship(
             reference: シンボルの位置,
             define: targetSymbolの位置
           )
           relationships.push(relationship)
  4. relationshipsを返す
```

### 付録B: Cytoscape.jsレイアウトパラメータ

#### B.1 COSEレイアウト (ファイル依存関係ビュー)

```typescript
{
  name: 'cose',
  nodeRepulsion: 150000 + symbolCount * 8000,
  idealEdgeLength: 450 - relationshipCount * 15,
  edgeElasticity: 80 + relationshipCount * 15,
  gravity: 25,
  numIter: 2000,
  animate: false
}
```

**パラメータ説明**:
- `nodeRepulsion`: ノード間の反発力 (大きいほど離れる)
- `idealEdgeLength`: エッジの理想的な長さ
- `edgeElasticity`: エッジの弾性 (関係の密度に応じて調整)
- `gravity`: 中心への引力
- `numIter`: レイアウト計算の反復回数

#### B.2 CiSEレイアウト (コミュニティ構造グラフ)

```typescript
// 拡張機能側 (ciseLayout.ts) で計算
{
  name: 'cise',
  clusters: communityClusterArray,  // Louvainで検出されたクラスタ
  animate: false,
  fit: true,
  padding: 50,
  nodeSeparation: 12.5,
  idealInterClusterEdgeLengthCoefficient: 1.8,
  allowNodesInsideCircle: false,
  maxRatioOfNodesInsideCircle: 0.1,
  springCoeff: 0.45,
  nodeRepulsion: 4500,
  gravity: 0.25,
  gravityRange: 3.8
}

// Webview側では preset レイアウトで座標を適用
{
  name: 'preset',
  positions: (node) => layoutPositions.get(currentLevel).get(node.id())
}
```

**パラメータ説明**:
- `clusters`: コミュニティごとにグループ化されたノードIDの配列
- `nodeSeparation`: クラスタ内のノード間隔
- `idealInterClusterEdgeLengthCoefficient`: クラスタ間エッジの理想長係数
- `springCoeff`: スプリング係数（弾性）
- `nodeRepulsion`: ノード間反発力
- `gravity`: 中心への重力
- `gravityRange`: 重力の影響範囲

### 付録C: VSCode SymbolKind色マッピング

```typescript
function getSymbolKindColor(kind: number): string {
  switch(kind) {
    case -1: return '#8faadc'  // ディレクトリ (青灰色)
    case 0:  return '#519aba'  // ファイル (青)
    case 1:  return '#75beff'  // モジュール (シアン)
    case 2:  return '#ffcc00'  // 名前空間 (黄色)
    case 3:  return '#75beff'  // パッケージ (シアン)
    case 4:  return '#ee9d28'  // クラス (オレンジ)
    case 5:  return '#b180d7'  // メソッド (紫)
    case 6:  return '#75beff'  // プロパティ (シアン)
    case 7:  return '#75beff'  // フィールド (シアン)
    case 8:  return '#ee9d28'  // コンストラクタ (オレンジ)
    case 9:  return '#ee9d28'  // 列挙型 (オレンジ)
    case 10: return '#75beff'  // インターフェース (シアン)
    case 11: return '#b180d7'  // 関数 (紫)
    case 12: return '#75beff'  // 変数 (シアン)
    case 13: return '#ffffff'  // 定数 (白)
    case 14: return '#cccccc'  // 文字列 (灰色)
    case 15: return '#cccccc'  // 数値 (灰色)
    case 16: return '#cccccc'  // ブール (灰色)
    case 17: return '#cccccc'  // 配列 (灰色)
    case 18: return '#ee9d28'  // オブジェクト (オレンジ)
    case 19: return '#b180d7'  // キー (紫)
    case 20: return '#cccccc'  // Null (灰色)
    case 21: return '#75beff'  // 列挙メンバー (シアン)
    case 22: return '#ee9d28'  // 構造体 (オレンジ)
    case 23: return '#b180d7'  // イベント (紫)
    case 24: return '#b180d7'  // オペレータ (紫)
    case 25: return '#75beff'  // 型パラメータ (シアン)
    default: return '#cccccc'  // 不明 (灰色)
  }
}
```

---

## ドキュメントバージョン履歴

| バージョン | 日付 | 変更内容 |
|-----------|------|----------|
| 1.3 | 2026-01-23 | v0.1.32対応: CiSEレイアウト + 階層的座標導出、Louvainコミュニティ検出、全レベル座標一括送信、dagreLayout.ts削除 |
| 1.2 | 2026-01-17 | v0.1.31対応: ファイル名更新(graphView.ts, graph-view.html)、4レベルノード表示、テンプレート簡略化 |
| 1.1 | 2025-12-29 | § 5.6 スタンドアロンHTMLエクスポート実装詳細を追加 |
| 1.0 | 2025-12-27 | 初回実装仕様書 (SPECIFICATIONS.mdから分割) |

---

**ドキュメント終了**
