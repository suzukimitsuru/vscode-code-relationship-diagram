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
4. **階層構造グラフ可視化**:
   - 4レベルのノード表示切り替え（Directory Only / Directory + File / File Only / File + Symbol）
   - Dagreレイアウトによる階層的な配置
   - データセットサイズに応じた適応型機能制限
5. **エクスポート**: スタンドアロンHTML形式での出力（VSCode拡張版のみ）

---

## 技術スタック

### コア技術

- **言語**: TypeScript 5.x
- **ランタイム**: Node.js 18/20/22 (VSCode組み込み)
- **フレームワーク**: VSCode Extension API 1.96.x
- **データベース**: DuckDB (埋め込み型SQL)
- **可視化**: Cytoscape.js 3.26.x
- **レイアウト計算**: Dagre 0.8.5 (拡張機能側で実行)

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

```
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
│   ├── dagreLayout.ts        # Dagreレイアウト計算（拡張機能側）
│   └── visualization.ts      # Webview管理、グラフ生成
└── webview/
    └── graphView.ts          # グラフUI（TypeScript、Cytoscape制御）

templates/
├── loading.html              # ローディング画面
└── graph-view.html           # メインビューテンプレート

bindings/
└── duckdb-*.node             # プラットフォーム別ネイティブバインディング
```

### データフロー

```
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
8. Dagreレイアウト計算 (拡張機能側/Node.js) ← NEW!
   ↓
9. レイアウト座標 + グラフ要素 → Webviewへチャンク転送 (5000要素/チャンク)
   ↓
10. Cytoscape.jsで事前計算された座標を使用してレンダリング (presetレイアウト)
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

### 4. 拡張機能側でのDagreレイアウト計算（v0.1.30～）

**課題**: Webview側でのDagreレイアウト計算がUIをフリーズさせる

**解決策**: 拡張機能側（Node.js環境）でDagreレイアウトを事前計算
- レイアウト計算をNode.jsのメインスレッドで実行
- 計算された座標をWebviewに送信
- Webviewは`preset`レイアウトで座標を適用するのみ

**利点**:
- UIフリーズの完全解消
- メモリ制限の緩和（Webview: ~2GB → Node.js: ~4GB+）
- プログレス表示とキャンセル機能の実装が容易
- レイアウトキャッシングが可能

**新しい制限値**:
- **小規模** (≤ 15,000ノード): シンボルレベル詳細表示
- **中規模** (≤ 10,000ノード または ≤ 15,000エッジ): Dagreレイアウト（拡張機能側）
- **大規模** (> 10,000ノード): COSEレイアウト（フォールバック）

**実装**:
- `src/relationship/dagreLayout.ts`: Dagreレイアウト計算ロジック（viewTypeパラメータ削除済み）
- `src/relationship/visualization.ts`: `calculateLayout` メソッド
- `src/webview/graphView.ts`: layoutPositionsメッセージ受信

### 5. 適応型レンダリング

**戦略**: データセットサイズに応じてレンダリング方法を切り替え

- **小規模** (≤ 15,000ノード): 全4レベル使用可能（File + Symbol含む）+ Dagreレイアウト
- **中規模** (15,000 < ノード ≤ 50,000): Directory Only / Directory + File / File Only のみ
- **大規模** (> 50,000ノード): Directory Only / Directory + File / File Only のみ、自動的にFile Onlyに切り替え

**理由**: パフォーマンスと可読性のバランス

**実装**: `src/webview/graphView.ts`

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

- **技術仕様書**: `docs/SPECIFICATIONS.md` - 包括的なアーキテクチャと実装詳細
- **バインディングビルド**: `docs/DUCKDB_BINDINGS.md` - DuckDBネイティブバインディングのビルド手順
- **変更履歴**: `CHANGELOG.md` - バージョンごとの変更内容
- **VSCode拡張機能API**: https://code.visualstudio.com/api
- **Cytoscape.js**: https://js.cytoscape.org/

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

```
<version> <summary>
<type>: <subject>

<body>

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>
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

- **日付**: 2026-01-17
- **バージョン**: 0.1.31
- **作成者**: Claude Code

このファイルはプロジェクトの進化に伴い定期的に更新してください。
