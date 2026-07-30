# Claude Code - プロジェクトコンテキスト

このファイルは、Claude Codeがプロジェクトを理解し、効果的に作業するためのコンテキスト情報を提供します。

---

## プロジェクト概要

**名称**: Code Relationship Diagram
**種類**: VSCode拡張機能
**目的**: コードベース全体のシンボルと関係を分析し、インタラクティブなグラフで可視化

### 主要機能

1. **シンボル抽出**: VSCode APIを使用してコード内のすべてのシンボル（クラス、関数、変数など）を抽出
2. **関係抽出**: シンボル間の依存関係と参照関係を分析
3. **DuckDB保存**: 抽出データを埋め込みデータベースに永続化
4. **円形階層グラフ可視化**（Cosmos.gl GPU加速レンダリング）:
   - BFS深度に基づく同心円レイアウト（エントリポイントを中心に参照先を外周へ配置）
   - ファイルノード / ファイル＋シンボルノードの表示切り替え
   - カスタム力学シミュレーション（Barnes-Hut四分木O(n log n)斥力 + スプリング引力）
   - 保守性スコアによる色分け・Dead code / 循環参照のハイライト
   - BFS深度スライダーによる表示範囲の動的変更
5. **エクスポート**: スタンドアロンHTML形式での出力（VSCode拡張版のみ）

---

## 技術スタック

### コア技術

- **言語**: TypeScript 5.x
- **ランタイム**: Node.js 18/20/22 (VSCode組み込み)
- **フレームワーク**: VSCode Extension API 1.96.x
- **データベース**: DuckDB (埋め込み型SQL)
- **可視化**: Cosmos.gl (GPU加速WebGLレンダラー、`enableSimulation: false` で純粋レンダラーとして使用)
- **レイアウト計算**: BFS同心円配置（事前計算）+ カスタム力学シミュレーション（Barnes-Hut四分木）
- **初期レイアウト補助**: 階層的レイアウト計算 (`hierarchicalLayout.ts`)
- **コミュニティ検出**: Louvain アルゴリズム (graphology-communities-louvain)

### ビルドツール

- **パッケージマネージャー**: npm/yarn
- **コンパイラ**: tsc (TypeScript Compiler)
- **バンドラー**: VSCode Extension Packager (vsce)

### CI/CD

- **GitHub Actions**: マルチプラットフォームバインディングのビルド
- **対象プラットフォーム**: macOS (arm64/x64), Windows (x64), Linux (x64)

---

## アーキテクチャ概要

### ディレクトリ構造

```text
src/
├── extension.ts              # エントリーポイント、コマンド登録
├── codeDb.ts                 # DuckDB操作（CRUD、スキーマ管理）
├── bindingsAutoSign.ts       # macOSバイナリ自動署名
├── logs.ts                   # ログユーティリティ
├── locale.ts                 # ロケール（多言語）サポート
├── distributor.ts            # ファイル変更分類アルゴリズム
├── queue.ts                  # キューデータ構造
├── extruct/
│   ├── codeFiles.ts          # ファイル列挙、.gitignore統合
│   ├── codeSymbols.ts        # シンボル抽出ロジック
│   └── symbol.ts             # SymbolModelデータ型
├── relationship/
│   ├── examine.ts            # 関係抽出メインロジック
│   ├── codeRelationships.ts  # Relationshipモデル
│   ├── cosmosAdapter.ts      # Cosmos.gl形式変換・保守性スコア計算
│   ├── hierarchicalLayout.ts # 初期階層レイアウト計算
│   ├── communityDetection.ts # Louvainコミュニティ検出
│   └── visualization.ts      # Webview管理、グラフ生成
└── webview/
    └── graphView.ts          # グラフUI（TypeScript、Cosmos.gl制御）

templates/
├── loading.html              # ローディング画面
└── graph-view.html           # メインビューテンプレート

bindings/
└── duckdb-*.node             # プラットフォーム別ネイティブバインディング

docs/
├── diagram-specs.md          # 円形階層図 機能仕様・実装仕様
└── circle-diagram.md         # 円形階層図 設計仕様（初版）
```

### データフロー

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
7. cosmosAdapter.convertToCosmosFormat() でCosmos.gl形式に変換
   （保守性スコア・Dead code・エントリポイント判定を含む）
   ↓
8. Louvainコミュニティ検出 (ファイルレベルのみ)
   ↓
9. hierarchicalLayout で初期配置座標を計算
   ↓
10. グラフ要素 → Webviewへチャンク転送 (5000要素/チャンク)
   ↓
11. Webview側: BFSでエントリポイントから深度計算 → 同心円初期座標を設定
   ↓
12. Cosmos.gl で初期座標を使用してレンダリング
   （シミュレーションはユーザーがボタンで起動）
   ↓
13. [オプション] カスタム力学シミュレーション
    Barnes-Hut斥力 + エッジスプリング引力 + 親ファイル引力で収束まで実行
```

---

## 重要な技術的決定

### 1. シンボルID生成戦略

**形式**: `${parentId}/${kind}.${name}@${hash}`

**理由**:

- ファイル移動やリネームに対して安定
- 階層構造を保持
- SHA256ハッシュで内容の一意性を保証

**実装**: `src/extruct/codeSymbols.ts:27`

### 2. Webview初期化ハンドシェイク

**問題**: 初期化前のpostMessageでデータ損失（最初の5000ノード）

**解決策**: 双方向通知プロトコル

- Webview側: 準備完了時に`webviewReady`メッセージ送信
- Extension側: メッセージ受信後にデータ送信開始
- タイムアウト: 10秒

**実装**:

- `src/relationship/visualization.ts:130-143`
- `src/webview/graphView.ts:284-290`

### 3. チャンク化データ転送

**制限**: postMessageは大きなペイロード（30,000以上のノード）で失敗

**解決策**: 5000要素ごとにチャンク分割

- 各チャンクにインデックスと総数を付与
- 50ms間隔で送信（UI応答性維持）
- 完了メッセージで終了を通知

**実装**: `src/relationship/visualization.ts:200-250`

### 4. BFS同心円レイアウト + カスタム力学シミュレーション（v0.2.x～）

**設計思想**: `docs/diagram-specs.md` §2 参照

**初期レイアウト（Webview側で計算）**:

- 全エントリポイントをマルチソースBFSの起点（depth=0）として深度計算
- 深度ごとに同心円リングへ均等配置（`RING_SPACING = 220px`）
- リング容量超過時はサブリングへ被参照数の昇順で振り分け
- シンボルノードは公開シンボルを起点にBFSで親ファイル周囲へ階層配置

**カスタム力学シミュレーション**（ユーザー起動、`enableSimulation: false`）:

- **Barnes-Hut四分木**でO(n log n)斥力計算（θ=1.2）
- 全ノード（固定含む）を斥力源としてツリーに含め、シンボルのすり抜けを防止
- エッジ幅比例スプリング引力 + シンボル→親ファイル引力
- 全ノード速度二乗和が閾値以下で自動収束

**実装**:

- `src/relationship/cosmosAdapter.ts`: ノード・リンクデータ変換
- `src/webview/graphView.ts`: BFS計算 `computeBfsDepths()` / `computeRadialPositions()` / `simulationTick()`

### 5. Cosmos.gl 純粋レンダラー利用

**設計**: Cosmos.glを内蔵シミュレーションなしの純粋WebGLレンダラーとして使用

- `enableSimulation: false` でCosmos.glのシミュレーションループを無効化
- 座標は `setPointPositions()` で外部から毎フレーム更新
- カスタム `requestAnimationFrame` ループで座標更新 → `render()` を呼び出し
- `setLinkArrows()` で参照方向の矢印を設定
- `setLinkWidths()` でエッジ幅を参照数に比例して設定

**理由**: 内蔵シミュレーションでは径方向スプリング等の独自力モデルが実現できないため

### 6. DuckDBバインディング動的ロード

**課題**: プラットフォーム × Node.jsバージョンごとに異なるネイティブバインディング

**解決策**:

- `/bindings`ディレクトリに事前コンパイル済み`.node`ファイル
- 実行時に最適なバージョンを選択
- macOSでは自動コード署名

**実装**: `src/codeDb.ts:13-52`

---

## 開発ガイドライン

### コーディング規約

1. **TypeScript厳格モード**: すべての型を明示
2. **エラーハンドリング**: `Promise.allSettled()`で失敗を許容、ログ記録
3. **非同期処理**: 必ず`async/await`を使用
4. **命名規則**:
   - ファイル: camelCase (`codeSymbols.ts`)
   - クラス: PascalCase (`SymbolModel`)
   - 関数: camelCase (`extractSymbols()`)
   - データベース: snake_case (`table_symbols`)

### ファイル操作のルール

1. **読み込み前提**: 編集前に必ず`Read`ツールでファイルを読む
2. **既存ファイル優先**: 新規作成よりも既存ファイルの編集を優先
3. **最小限の変更**: 要求された箇所のみを修正、過剰な最適化は避ける

### データベース操作

1. **トランザクション**: 複数行の変更は必ず`BEGIN/COMMIT`で囲む
2. **プリペアドステートメント**: SQLインジェクション防止のため使用
3. **インデックス**: クエリパフォーマンスのために適切なインデックスを維持

### Webview開発

1. **セキュリティ**: CSP（Content Security Policy）を遵守
2. **postMessage**: 必ず型定義されたメッセージ形式を使用
3. **スタンドアロン対応**: `IS_STANDALONE`フラグで動作を分岐
4. **プレースホルダーパターン**: `EXPORT_BUTTON_PLACEHOLDER`でスタンドアロン版/VSCode版の機能差を実現
   - スタンドアロン版: 空文字列（エクスポートボタンなし）
   - VSCode版: HTMLエクスポートボタンのHTML

---

## よくある作業パターン

### 新機能追加の流れ

1. **仕様確認**: `docs/SPECIFICATIONS.md`で既存アーキテクチャを確認
2. **影響範囲調査**: 関連ファイルを特定（`Glob`/`Grep`ツール）
3. **データモデル変更**: 必要に応じてスキーマ更新
4. **実装**: コア機能 → UI → テスト
5. **ドキュメント更新**: `SPECIFICATIONS.md`と`CHANGELOG.md`を更新

### デバッグ手順

1. **拡張機能ログ**: VSCode開発者ツール → Console
2. **Webviewログ**: Webview Developer Tools → Console（`webviewReady`メッセージを確認）
3. **データベース検証**: `.vscode/crd.duckdb`をSQLiteツールで直接確認
4. **ブレークポイント**: `.vscode/launch.json`でデバッグ設定済み

### バインディング更新

1. GitHub Actionsワークフローを実行
2. 生成された`.node`ファイルを`/bindings`にコミット
3. macOS署名が必要な場合は`bindingsAutoSign.ts`を確認

---

## テストとビルド

### ローカル開発

```bash
# 依存関係インストール
npm install

# コンパイル
npm run compile

# 拡張機能デバッグ
# F5キーを押すか、VSCodeのデバッグビューから"Extension"を実行
```

### パッケージング

```bash
# .vsixファイル生成
npx vsce package

# インストール
code --install-extension code-relationship-diagram-0.1.31.vsix
```

### デバッグ設定

`.vscode/launch.json`に以下の設定が含まれています：

- **Extension**: 拡張機能のデバッグ実行
- **Extension Tests**: テストの実行（未実装の場合はスキップ）

---

## トラブルシューティング

### ノードが表示されない

**原因**: Webview初期化タイミングの問題

**確認**:

1. Webview Consoleで`webviewReady`メッセージがログされているか
2. `Received nodes chunk X/Y`のログでチャンク1が欠落していないか
3. ノード総数がデータベースと一致しているか

**解決**: `src/relationship/visualization.ts`のハンドシェイクロジックを確認

### DuckDBバインディングエラー

**原因**: プラットフォーム/Node.jsバージョンに対応するバインディングがない

**確認**:

```bash
ls bindings/
# duckdb-{platform}-{arch}-v{version}.node が存在するか確認
```

**解決**: GitHub Actionsでバインディングを再ビルド、またはローカルでビルド

### パフォーマンス低下

**原因**: 大規模コードベース（10,000+ファイル）での処理

**対策**:

1. `.gitignore`で不要なディレクトリを除外
2. ファイルレベルビューのみを使用
3. VSCodeのインデキシング完了を待つ

---

## 参考ドキュメント

- **円形階層図 機能・実装仕様**: `docs/diagram-specs.md` - 現行ビューの機能仕様と実装値
- **円形階層図 設計仕様（初版）**: `docs/circle-diagram.md` - 設計の背景と調査結果
- **変更履歴**: `CHANGELOG.md` - バージョンごとの変更内容
- **VSCode拡張機能API**: <https://code.visualstudio.com/api>
- **Cosmos.gl**: <https://github.com/cosmosgl/graph>

---

## 注意事項

### セキュリティ

- SQLインジェクション: プリペアドステートメント必須
- XSS: Webviewでのユーザー入力サニタイズ
- パストラバーサル: ファイルパスの検証

### パフォーマンス

- 5000ノード以上: 適応型レンダリングに自動切り替え
- チャンク送信: UI応答性維持のため50ms間隔
- データベースインデックス: クエリ最適化のため必須

### 互換性

- VSCode: 1.96.0以上
- Node.js: 18/20/22 (ABI 108/115/127)
- プラットフォーム: macOS (arm64/x64), Windows (x64), Linux (x64)

---

## バージョン管理

### コミットメッセージ形式

```text
<version> <summary>
<type>: <subject>

<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Type**:

- `feat`: 新機能
- `fix`: バグ修正
- `docs`: ドキュメント変更
- `refactor`: リファクタリング
- `perf`: パフォーマンス改善
- `test`: テスト追加・修正

### ブランチ戦略

- `main`: 安定版、プロダクションリリース
- `feature/*`: 新機能開発
- `fix/*`: バグ修正
- `refactor/*`: リファクタリング

---

## 最終更新

- **日付**: 2026-07-31
- **バージョン**: 0.3.35
- **作成者**: Claude Code

このファイルはプロジェクトの進化に伴い定期的に更新してください。
