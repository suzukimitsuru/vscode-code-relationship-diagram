# Change Log

All notable changes to the "vscode-code-relationship-diagram" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

- [Added] for new features.
- [Changed] for changes in existing functionality.
- [Deprecated] for soon-to-be removed features.
- [Removed] for now removed features.
- [Fixed] for any bug fixes.
- [Security] in case of vulnerabilities.

## [Unreleased]

## [0.2.34] - 2026-03-05

### Added

- **Cosmos.gl GPU加速レンダリングエンジンの統合**
  - `@cosmos.gl/graph` (v2.6.4): GPU加速WebGLグラフレンダリングエンジン
  - `d3-hierarchy` (v3.1.2): 階層的データ構造のサポート
  - `graphology-types` (v0.24.8): graphologyの型定義
  - `src/relationship/cosmosAdapter.ts`: シンボルデータをCosmos.gl形式（Float32Array/Uint32Array）に変換
  - `src/relationship/hierarchicalLayout.ts`: 階層的円パッキングレイアウト計算
    - `calculateHierarchicalLayout()`: ディレクトリ→ファイル→シンボルの階層配置
    - `packNodesInCircle()`: シンボルを親ノード内に円パッキング配置
    - `filterByDirectory()`: ディレクトリ可視性フィルタリング

- **VSCode統合コマンドの追加**
  - `CRD: Zoom to Current File in Graph`: 現在のファイルにグラフをズーム
  - `CRD: Show Related Code in Graph`: 選択範囲の関連コードを表示
  - エディタイベント連携: アクティブエディタ変更・カーソル位置変更時にグラフを同期（300msデバウンス）

- **グラフ表示機能の強化**
  - ノードホバー時の関連リンクハイライト（接続リンクをオレンジ、非関連リンクをフェードアウト）
  - ツールチップ改善: ノードアイコン（📁 ディレクトリ、📄 ファイル、🏛️ クラス等）、References/Referenced by の分離表示
  - スタンドアロンHTMLエクスポート機能（`*.crd.html` + `*.crd.data.js`）

### Changed

- **`src/webview/graphView.ts` を Cosmos.gl ベースに全面書き換え**
  - Cytoscape.js → Cosmos.gl (WebGL) に移行
  - ノードレベル切り替え（dir-only / dir-file / file-only / file-symbol）をCosmos.glで再実装
  - ディレクトリチェックボックスによる可視性制御
- **`templates/graph-view.html`**: CytoscapeスクリプトタグをCosmos.glに置き換え
- **`src/relationship/visualization.ts`**: CiSEレイアウト・ViewType・Cytoscape関連コードを削除してシンプル化
- **`src/extension.ts`**: viewType選択QuickPickを廃止し、常にCosmos.glビューを使用
- **`esbuild.js`**: 別途cosmosViewCtxビルドコンテキストを廃止（graphView.tsに統合）
- **`.vscodeignore`**: cytoscape / cytoscape-dagre をパッケージから除外
- **パッケージ管理**: `yarn.lock` を削除、`package-lock.json` を `.gitignore` に追加してGit管理から除外

### Removed

- **Cytoscape.js の完全廃止**
  - npm パッケージ `cytoscape`, `cytoscape-cise`, `dagre`, `@types/dagre` を削除
  - `src/relationship/ciseLayout.ts`: CiSEレイアウト計算モジュールを削除
- **旧Cosmos専用ビューの削除**（graphView.tsに統合済み）
  - `src/webview/cosmosView.ts` を削除
  - `templates/cosmos-view.html` を削除
- **`codeRelationshipDiagram.viewType` 設定を廃止**（常にCosmos.glを使用）
- **`ViewType` 型** (`'cytoscape' | 'cosmos'`) を visualization.ts から削除

## [0.1.33] - 2026-01-30

### 0.1.33　Fixed

- **Ubuntu起動エラーの修正**
  - `esbuild.js`: npm版`events`パッケージをNode.js組み込み`node:events`にエイリアス
  - `ciseLayout.ts`: Cytoscape.jsの遅延ロード対応（activate時ではなく使用時にロード）
  - graphologyがnpm版eventsを依存として持つ問題を解消

## [0.1.32] - 2026-01-28

### 0.1.32 Added

- **階層的レイアウト導出（Hierarchical Layout Derivation）**
  - ファイルレベルのみでCiSEレイアウトを計算し、他レベルは座標を導出
  - 大規模プロジェクト対応（39,000ノード → 1,072ファイルのみ計算）
  - `ciseLayout.ts`に以下の関数を追加:
    - `deriveAllLevelPositions()`: 全4レベルの座標を導出
    - `deriveDirectoryPositions()`: ディレクトリ座標を重心から計算
    - `deriveSymbolPositions()`: シンボルを親ファイル周囲に円形配置
  - `AllLevelPositions`インターフェース: 4レベル分の座標を格納

- **全レベル座標の一括送信**
  - `allLevelPositions`メッセージタイプを追加
  - 4レベル（dir-only, dir-file, file-only, file-symbol）の座標を一度に送信
  - レベル切り替え時は事前計算された座標を使用（瞬時切り替え）

- **Louvainコミュニティ検出**
  - `communityDetection.ts`: graphology-communities-louvainを使用
  - ファイルレベルのノードでコミュニティを検出
  - CiSEレイアウトのクラスタとして使用

### 0.1.32 Changed

- **レイアウト計算の最適化**
  - 全ノードではなくファイルノードのみでCiSE計算
  - 計算時間の大幅削減（39,000ノード → 1,072ノード）
  - タイムアウト問題の解消

- **WebView座標管理の改善**
  - `layoutPositions`を`Map<viewType, Map<nodeId, {x, y}>>`形式に変更
  - `getCommunityLayout()`が現在の`nodeLevel`に応じた座標を使用
  - 後方互換性のため旧形式（`layoutPositions`単一配列）もサポート

### 0.1.32 Removed

- `docs/LEIDEN_COMMUNITY_DETECTION.md` - 使用しないため削除
- `docs/DUCKDB_BINDINGS.md` - 古い情報のため削除

## [0.1.31] - 2026-01-17

### 0.1.31 Added

- 4レベルのノード表示切り替え機能
  - **Directory Only**: ディレクトリノードのみを表示
  - **Directory + File**: ディレクトリとファイルノードを表示
  - **File Only**: ファイルノードのみを表示
  - **File + Symbol**: ファイルとシンボルノードを表示（最も詳細）
- ディレクトリノード自動生成機能
  - ファイルパスからディレクトリ階層を自動構築
  - 階層的な親子関係の設定
- ディレクトリ間エッジ集約機能
  - ファイル間の関係をディレクトリ間の関係に集約
  - 関係数のカウントと詳細情報の保持
- データセットサイズに応じた適応型機能制限
  - **小規模**（≤ 15,000ノード）: 全4レベル使用可能
  - **中規模**（15,000 < ノード ≤ 50,000）: dir-only, dir-file, file-only のみ
  - **大規模**（> 50,000ノード）: dir-only, dir-file, file-only のみ
  - 大規模データセットでは自動的にfile-onlyに切り替え

### 0.1.31 Changed

- マルチビューからシングルビュー（階層構造のみ）に変更
  - タブナビゲーションを削除
  - ファイル依存関係ビューを削除
  - 階層構造ビューを常に表示
- ファイル名のリネーム
  - `templates/graph-multiview.html` → `templates/graph-view.html`
  - `src/webview/graphMultiview.ts` → `src/webview/graphView.ts`
  - 関連するプレースホルダーと参照を更新
- ノード切り替えUIをドロップダウン形式に変更
  - 以前の "Toggle Directory Grouping" ボタンを削除
  - データセットサイズに応じて選択肢を自動調整
- コードベースの簡略化
  - 関数名のリネーム: `initHierarchyView` → `initView`, `createHierarchyElements` → `createElements`
  - 変数名のリネーム: `hierarchyElements` → `graphElements`, `hierarchyPositions` → `layoutPositions`
  - HTML ID のリネーム: `view-hierarchy` → `view-graph`, `cy-hierarchy` → `cy-graph`, `node-level-hierarchy` → `node-level`
  - `viewType` パラメータの削除（階層ビューのみのため不要）
- エクスポートボタンの配置変更
  - ドロップダウンメニューからシンプルなボタンに変更
  - Fit/Resetボタンの横に配置
  - `EXPORT_BUTTON_PLACEHOLDER` によるスタンドアロン/VSCode版の切り替え
- ノードレベルドロップダウンの幅を160pxから120pxに変更

### 0.1.31 Fixed

- 階層ビューでファイルノードが重なる問題を修正
  - Dagreレイアウト計算時のノードサイズを実際の描画サイズ（300px正方形）に合わせて調整
  - 階層ビュー用のスペーシング（nodeSep: 150px, rankSep: 200px）を最適化
  - ファイルノード間の間隔が適切に確保されるように改善
- スタンドアロンHTMLでエクスポートボタンが一瞬表示される問題を修正
  - `EXPORT_BUTTON_PLACEHOLDER` でスタンドアロン版は空文字列を返すことで解決

### 0.1.31 Removed

- ファイル依存関係ビュー機能
- マルチビュー切り替え機能
- ビューごとのエクスポートメニュー（シンプルなエクスポートボタンに統一）
- PNGエクスポート機能（VSCode Webviewセキュリティ制限により動作せず）
  - `exportPNG` 関数を削除
  - `toggleExportMenu`, `closeExportMenu` 関数を削除
  - エクスポートメニュー関連のCSS（約50行）を削除
- `calculateCallGraphLayout` 関数（呼び出しグラフ用レイアウト計算）
- `calculateEdgePaths` 関数（エッジパス計算）

## 0.1.30 - 2026-01-09

### [Added] 拡張機能側でのDagreレイアウト計算

- **UIフリーズの完全解消**: Node.js環境でのレイアウト計算によりWebview UIフリーズを解消
- **dagreLayout.ts 新規追加**: Dagreレイアウト計算ロジック（286行）
- **プログレス表示**: レイアウト計算の進捗表示とキャンセル機能
- **レイアウトキャッシング**: 計算結果のキャッシュによる再表示の高速化

### [Added] ログ機能の強化

- **logs.ts 新規追加**: 詳細なデバッグログ機能（63行）
- **ファイル出力**: `show_diagram.log` への詳細ログ出力
- **コンソール出力**: 開発時のデバッグ情報表示

### [Added] HTMLエクスポート機能の強化

- スタンドアロンHTMLエクスポート時に `.data.js` ファイルを生成（JavaScriptフォーマット）
- HTMLエクスポート中の経過表示（進捗バーとメッセージ）
- ビュー切り替え時の経過表示
- 包括的なプロジェクトドキュメント（機能仕様書、実装仕様書）を追加

### [Changed] レンダリング戦略の最適化

- **適応型レイアウト選択**:
  - 小規模（≤ 15,000ノード）: シンボルレベル詳細表示 + Dagreレイアウト（拡張機能側）
  - 中規模（≤ 10,000ノード または ≤ 15,000エッジ）: Dagreレイアウト（拡張機能側）
  - 大規模（> 10,000ノード）: COSEレイアウト（フォールバック）
- **Webview処理の軽量化**: 事前計算された座標を適用するのみ（presetレイアウト）
- **チャンク転送の最適化**: レイアウト座標をチャンク分割して転送（5000要素/チャンク）

### [Changed] データ読み込みの改善

- HTMLエクスポートのデータ形式をJSONからJavaScriptに変更
- 動的スクリプト読み込みによるデータ読み込み（初期ロード高速化）
- ストリーム書き込みによる大規模データファイル生成

### [Enhanced] メモリ制限の緩和

- **レイアウト計算メモリ制限の拡大**: Webview ~2GB → Node.js ~4GB+
- **より大規模なプロジェクト対応**: 数万ノードのプロジェクトでも安定動作
- **メモリ使用量の最適化**: 段階的なデータ処理による効率化

### [Fixed] 大規模プロジェクト対応

- 大規模プロジェクト（数万ノード）でのHTMLエクスポート時の "Invalid string length" エラーを修正
- ブラウザでスタンドアロンHTML表示時のCORSエラーを解決
- V8エンジンの文字列長制限を回避（ストリーム書き込み実装）
- Webview側でのDagreレイアウト計算によるUIフリーズを解消

### [Documentation] 開発ドキュメントの充実

- **README.md**: Development セクション追加、.gitignore 設定ガイドを追加
- **FUNCTIONAL_SPECS.md**: 機能仕様書を追加・更新
- **IMPLEMENTATION_SPECS.md**: 実装仕様書を追加・更新
- **SPECIFICATIONS.md**: 仕様書インデックスを追加
- **claude.md**: AI開発コンテキストを追加・更新（v0.1.30技術詳細を含む）
- **DUCKDB_BINDINGS.md**: DuckDBバインディングビルド手順を更新

## 0.1.29 - 2025-12-27

### [Changed] WebViewのTypeScript化

- WebViewスクリプトをJavaScriptからTypeScriptに変換（graphMultiview.ts）
- 型安全性の向上とコード保守性の改善

### [Added] ディレクトリグループ化機能

- 全ビュー（ファイル依存関係、階層構造、呼び出しグラフ）でディレクトリグループ化ボタンを追加
- ファイルをディレクトリ階層で視覚的にグループ化可能
- 大規模プロジェクトでの可読性を向上

### [Fixed] Webview初期化の信頼性向上

- 初期化完了をwebviewReadyメッセージで確実に確認する方式に変更
- 初期化前のデータ送信により最初のチャンク（5000ノード）が失われる問題を解決
- タイムアウト処理（10秒）を追加

### [Fixed] エクスポートメニューの修正

- 各ビューごとに独立したエクスポートメニューを実装
- 階層構造ビューと呼び出しグラフビューでエクスポートボタンが動作しなかった問題を修正

## 0.1.28 - 2025-12-25

- シンボルIDの重複をSymbolKind+ハッシュを追加して解消
- DuckDBのNode.jsバインディングの動的ロードを整備

## 0.1.27 - 2025-12-17

### DuckDB Multi-Platform Support

- **複数環境対応のDuckDBバイナリシステム**
  - Node.js 18/20/22 (ABI 108/115/127) をサポート
  - Linux x64、macOS arm64/x64、Windows x64 対応
  - ランタイムでの自動ABI検出とフォールバック機能
  - GitHub Actions による自動ビルドワークフロー
  - Ubuntu 22.04/Node.js 18.18 での途中停止問題を修正

## 0.1.26 - 2025-12-11

### コード関係調査

- コード関係調査の効率化
- ファイル監視の追加(途中)

### コード関係図表示

- タブ切り替えによるマルチビュー機能の追加
  - File Dependencies
  - Hierarchy
  - Call Graph

## 0.1.24 - 2025-09-25

### 0.1.24 - Language Server Processing Optimization and Progress Enhancement

### 0.1.24 主要な改善点

- **処理効率向上**: 言語サーバー処理の排除
- **進捗表示強化**: 残り時間予測機能付き詳細な進捗表示システム

### [Changed] 言語サーバー処理の排除

- **リトライ機構の改善**
  - 待機時間を1秒固定に統一して処理速度を向上

- **関係抽出の効率化**
  - 言語サーバー処理をコメントアウトし効率化

### [Enhanced] 進捗表示の改善

- **残り時間予測機能**
  - 残り時間予測表示の追加

- **詳細な進捗情報**
  - リトライ回数の可視化によりデバッグ性を向上

### [Technical] 実装詳細

- **型安全性の向上**
  - 関数戻り値の型を明示的にタプルで定義
  - リトライ回数の型安全な処理

- **パフォーマンス改善**
  - 言語サーバー待機時間の最適化
  - 無駄な処理ループの削減

## 0.1.23 - 2025-09-23

### 0.1.23 - Gitignore Integration and Layout Optimization

### 0.1.23 主要な改善点

- **ファイル除外機能**: .gitignoreファイル対応による不要ファイルの自動除外
- **パフォーマンス向上**: ファイル検索対象の最適化と重複処理の削除
- **コード品質向上**: API設計の改善とテストの更新

### [Added] Gitignore統合機能

- **.gitignoreファイル自動読み込み**
  - ワークスペースの`.gitignore`ファイルを自動検出・読み込み
  - 空行とコメント行（`#`で始まる行）を適切に除外
  - エラー処理付きで安全に動作

- **デフォルト除外パターン**
  - `.git/**`, `.vscode/**`, `.DS_Store`を標準で除外
  - 開発時の不要ファイルを自動除外

- **fast-glob統合**
  - `ignore`オプションによる効率的なファイル除外
  - 検索対象ファイル数の大幅削減

### [Enhanced] ファイル検索システムの改善

- **API設計の最適化**
  - `list()`関数に`ignores`パラメータを追加
  - `loadGitignorePatterns()`関数をエクスポートして再利用可能に
  - 関数間の役割分担を明確化

- **テストの更新**
  - `codeFiles.test.ts`を新しいAPI仕様に対応
  - 除外パターンパラメータの追加

### [Fixed] レイアウト処理の最適化

- **重複イベントハンドラの削除**
  - `resetLayout()`関数内の重複する`layoutstop`イベントハンドラを削除
  - Reset Layoutボタン押下時のノード移動重複実行を解消
  - パフォーマンスとユーザーエクスペリエンスの改善

### [Technical] 実装内容

- **ファイル除外の流れ**
  1. 初期化時に`.gitignore`ファイルを読み込み
  2. `files.associations`パターン検索時に除外パターンを適用
  3. 検索結果から不要ファイルを自動除外

- **パフォーマンス効果**
  - `node_modules/`, `.git/`, `dist/`等の大量ファイルを除外
  - 関係図生成時間の短縮
  - メモリ使用量の削減

## 0.1.22 - 2025-09-23

### 0.1.22 - Template System Implementation and Architecture Refactoring

### 0.1.22 主要な改善点

- **アーキテクチャ改善**: HTMLテンプレートシステムの導入
- **アイコンシステム変更**: VSCode Codiconsから Font Awesome 4.7.0への移行
- **UIコンポーネント統一**: プレースホルダーシステムによる設定値集約化
- **コード保守性向上**: 1000行以上のインラインHTMLコードを削除

### [Changed] HTMLテンプレートシステムの導入

- **外部テンプレートファイル対応**
  - HTMLコンテンツ生成をテンプレートファイルベースに変更
  - `loadHtmlTemplate()` メソッドで外部テンプレートファイルを読み込み
  - ローディング画面とメイン画面の両方でテンプレートシステムを採用

- **統一プレースホルダーシステム**
  - `replacePlaceholders()` メソッドでプレースホルダー置き換えを統一化
  - テーマ色、URI、ボタンスタイルなど全設定値を集約管理
  - スタンドアロン版とVSCode版の条件分岐を明確化

### [Changed] アイコンシステムの変更

- **Font Awesome 4.7.0への移行**
  - `@vscode/codicons` の依存関係を削除
  - `font-awesome@4.7.0` を新たに追加
  - エクスポートボタンやUI要素のアイコンをFont Awesomeに統一

- **Webview URIシステムの改善**
  - `webview.asWebviewUri()` による適切なリソース参照
  - スタンドアロン版はCDN、VSCode版はローカルファイルの使い分け

### [Enhanced] UIコンポーネントの改善

- **エクスポート機能の統一**
  - ドロップダウンメニューのアイコンをFont Awesomeに更新
  - HTMLエクスポートとPNGエクスポートの統一インターフェース
  - テーマ対応の強化とボタンスタイルの統一化

- **プラットフォーム対応**
  - `.vscodeignore` の更新（Codicons削除、Font Awesome追加）
  - スタンドアロン版とVSCode版の適切な機能分離

### [Removed] コード削減と最適化

- **大幅なコード削減**
  - `generateLoadingContent()` と `generateWebviewContent()` メソッドを削除
  - インラインHTML生成コード（1000行以上）を削除
  - VSCode Codicons関連のコードと設定を削除

- **依存関係の最適化**
  - 未使用の`@vscode/codicons`パッケージを削除
  - より軽量なFont Awesome 4.7.0に変更

### [Technical] 保守性とパフォーマンス向上

- **テンプレートファイルシステム**
  - HTMLの外部化により保守性を大幅向上
  - プレースホルダーによる設定値の集約化
  - 条件分岐ロジックの明確化

- **ビルドプロセス改善**
  - パッケージサイズの最適化
  - 依存関係の整理と軽量化

## 0.1.21 - 2025-09-19

### 0.1.21 - Advanced Node Selection and Graph Interaction Features

### 0.1.21 主要な改善点

- **直感的操作**: 範囲選択とドラッグ移動による効率的なノード整理
- **精密ナビゲーション**: エッジから直接ソースコードの該当行にジャンプ
- **依存関係可視化**: 参照数ベース階層レイアウトでアーキテクチャ構造の直感的把握
- **統一UI/UX**: 一貫した選択表示とキーボード操作

- **[Added] ノード範囲選択・複数選択機能**
  - Shift+ドラッグによる範囲選択、Shift+クリックによる個別選択
  - 選択ボックスの視覚化と完全含有ノードのみの厳密な選択判定

- **[Added] 複数ノード同時移動機能**
  - 選択ノードのグループドラッグ、相対位置を維持した同期移動
  - 単体ドラッグ時の自動選択状態化

- **[Enhanced] ノード選択の視覚的フィードバック強化**
  - 選択ノードに鮮やかなオレンジ色（#FF6B35）の枠線と光彩効果
  - 単体ドラッグ・範囲選択・個別選択で統一された選択表示

- **[Enhanced] エッジツールチップ機能の大幅改善**
  - G3仕様準拠：タイトルなしツールチップ、表示後の位置固定
  - 参照シンボルの行番号ソート、「参照シンボル → 定義シンボル」形式表示
  - シンボルクリックによる該当ファイル・行への直接ジャンプ機能

- **[Added] G1仕様対応：参照数に基づく階層レイアウト**
  - 初期レイアウト後の段階的ノード再配置（参照数少ない順に上から配置）
  - グリッドベース重なり防止配置、アニメーション付きノード移動

- **[Added] 言語サーバー再構築コマンドの統一管理**
  - `languageConfig.ts`に10言語の専用再構築コマンドを集約
  - `executeRescanCommand()`による統一的なコマンド実行

- **[Fixed] ファイルオープン機能の行番号指定対応**
  - エッジツールチップからの行番号付きファイルジャンプ実装

- **[Changed] 操作性の簡略化**
  - 範囲選択・個別選択のキーをShiftのみに統一
  - 空白部分クリックによる全選択解除機能

- **[Enhanced] UIアセット管理とドキュメント充実**
  - VSCodeアイコンフォントの@vscode/codiconsパッケージ移行
  - README仕様書の充実（G1/G2/G3仕様の詳細化）
  - `languageCongig.ts` → `languageConfig.ts`（タイポ修正）

## 0.1.20 - 2025-09-18

### 0.1.20 - Comprehensive API Terminology Refactoring

- **[Changed] API命名規則の大幅改善**: 「参照関係」から「関係」への用語統一とデータモデルの最適化
  - `codeReferences.ts` → `codeRelationships.ts` にファイル名変更
  - `Reference` クラス → `Relationship` クラスに変更
  - データベーステーブル `table_references` → `table_relationships` に変更
  - Relationship クラスのプロパティ名を意味に応じて最適化:
    - `from` → `reference` (参照元)
    - `to` → `define` (定義先)
  - データベースカラムも対応して変更:
    - `from_id, from_path, from_line` → `reference_id, reference_path, reference_line`
    - `to_id, to_path, to_line` → `define_id, define_path, define_line`
  - 全メソッド名を統一: `reference_insert()` → `relationship_insert()`, `reference_toPath()` → `relationship_definePath()` など
  - 変数名も一貫して更新: `from_refs` → `reference_refs`, `to_refs` → `define_refs` など

- **[Enhanced] READMEの使用方法説明を強化**: ワークスペースファイルの設定例を追加

- **[Enhanced] デバッグ出力とログメッセージの改善**: 新しい用語に合わせて統一

- **[Enhanced] コード可読性の向上**: 意味が明確な変数名・メソッド名への統一により開発・保守性が大幅向上

- **[Technical] バージョン管理の改善**
  - バージョン番号を 0.1.19 → 0.1.20 に更新
  - 拡張機能初期化ログにバージョン情報を追加
  - サンプルワークスペースの更新とテストファイルの改善
  - スクリーンショットの更新

- **[Migration] データベースマイグレーション**
  - 既存のデータベースは自動的に新しいスキーマに移行されます
  - APIの変更により、この拡張機能に依存する外部コードがある場合は更新が必要です

## 0.1.19 - 2025-09-16

### 0.1.19 - Major UI Enhancement and Export Features

- **[Added] HTMLエクスポート機能**
  - コード関係図を完全スタンドアロンのHTMLファイルとして出力可能
  - エクスポートされたHTMLはブラウザで単独動作し、すべての機能を利用可能
  - 現在のデータを埋め込んだ完全なスタンドアロンHTML生成

- **[Added] ドロップダウン式エクスポートメニュー**
  - エクスポートボタンを分割ボタン形式に変更
  - PNG/HTML選択可能なドロップダウンメニューを実装
  - VSCodeスタイルに合わせたUI設計

- **[Added] 関係線ツールチップ機能**
  - エッジ（関係線）ホバー時に詳細な関係情報を表示
  - toSymbolNameでグルーピングした見やすい表示
  - 行番号を削除してより簡潔な表示に改善

- **[Added] ファイルオープン機能**
  - ノードのダブルクリック、右クリック、Ctrl+クリックでファイルを開く
  - 複数の操作方法でアクセシビリティを向上

- **[Changed] generateWebviewContent統合**
  - VSCode用とスタンドアロン用の両方のHTMLを1つの関数で生成
  - コードの重複を排除し保守性を向上
  - 条件分岐によりVSCode API依存を適切に処理

- **[Enhanced] 参照抽出の信頼性向上**
  - リトライ回数パラメータ（60回）を追加
  - シンボル名を含むより詳細なログ出力
  - 言語サーバー負荷軽減のための処理間隔調整

- **[Enhanced] 進捗表示の改善**
  - より詳細な処理状況をステータスバーに表示
  - 言語サーバー待機状況やファイル処理状況を可視化

- **[Fixed] スタンドアロンHTML互換性問題**
  - acquireVsCodeApi()未定義エラーを解決
  - ツールチップ表示問題を修正
  - VSCode API依存部分の条件分岐処理を追加

- **[Fixed] UI表示問題**
  - ダーク/ライトテーマ対応の改善
  - codiconフォントのスタンドアロン版での非表示化
  - メニュー外クリックでの自動クローズ機能

## 0.0.17 - 2025-09-11

### 0.0.17 - Refactored

- **言語サーバー関連モジュールの分離・リファクタリング**
  - `languageServers.ts` → `languageCongig.ts`（言語設定）と`languageServer.ts`（言語サーバー処理）に分割
  - 責任の分離により保守性とコードの可読性を向上
  - モジュール間の依存関係を整理

- **コード参照抽出処理の改善**
  - `codeReferences.ts`の処理ロジックを簡潔化
  - リトライ機能付き参照抽出の最適化
  - エラーハンドリングの強化とログ出力の改善

### 0.0.17 - Fixed

- **Windowsパス処理問題の解決**
  - `extension.ts`でpath.resolve()とpath.normalize()を使用したパス正規化を強化
  - Windows環境でのファイルパス処理の信頼性向上
  - クロスプラットフォーム対応の改善

- **シンボル抽出処理の安定性向上**
  - `codeSymbols.ts`でのドキュメントシンボル抽出処理を改善
  - ファイル名処理とパス分割ロジックの最適化

### 0.0.17 - Enhanced

- **言語サーバー待機機能の導入**
  - `LanguageCompleteWaiter`クラスによる言語サーバー準備完了待機
  - 参照抽出の精度向上と処理の安定化
  - 非同期処理の適切な管理

- **処理フローの最適化**
  - 保存処理の並列実行からシーケンシャル実行への変更
  - データベース操作の信頼性向上
  - メモリ使用量の最適化

## 0.0.15 - 2025-09-09

### 0.0.15 - Added

- **C言語テストワークスペースを追加**
  - `exsample-workspace/`にC言語の参照関係テスト用プロジェクト作成
  - ヘッダーファイル（math_utils.h, string_utils.h）とソースファイル（.c）の相互参照構造
  - VSCode設定ファイル（launch.json, tasks.json, c_cpp_properties.json）完備
  - Makefile、README.mdによる完全なビルド環境

- **言語サーバー機能の信頼性向上**
  - 参照取得の信頼性を高める関数群を追加（`languageServers.ts`）
  - インデックス完了状態の検出機能
  - 言語サーバー完全初期化待機機能
  - 複数情報源による参照完全性チェック

### 0.0.15 - Enhanced

- **デバッグ環境の改善**
  - `launch.json`にテストワークスペース指定のデバッグ設定追加
  - 拡張機能開発時の特定ワークスペース自動オープン機能
  - `.vscodeignore`の最適化

- **ビルド・パッケージプロセス改善**
  - `package.json`のビルドスクリプトにexsample-workspace.zip自動作成を追加
  - 拡張機能配布時にテスト環境も含める仕組み

- **コード参照処理の最適化**
  - `codeReferences.ts`でのエディタ表示・非表示処理改善
  - 言語サーバー負荷軽減のための待機処理追加

## 0.0.14 - 2025-09-04

### 0.0.14 - Fixed

- **シンボルIDの重複問題を解決**
  - `SymbolModel.id`をUUIDベースに戻して主キーの重複を防止
  - データベースの整合性とパフォーマンスの向上
  - シンボル識別の信頼性を改善

### 0.0.14 - Enhanced

- **UIとメディアファイルの更新**
  - 新しいスクリーンショット画像を追加（`CRD-screen-shot.png`）
  - Visual Studioアイコンフォント（codicon）のローカル対応
  - README.mdの内容更新

- **コア機能の最適化**
  - コードファイル処理の改善（`codeFiles.ts`）
  - 参照関係処理の最適化（`codeReferences.ts`）
  - シンボル管理機能の強化（`codeSymbols.ts`）
  - グラフ可視化の改良（`graphVisualization.ts`）
  - 言語サーバー統合の改善（`languageServers.ts`）

## 0.0.13 - 2025-08-28

### 0.0.13 - Fixed

- **シンボルIDの重複問題を解決**
  - `SymbolModel.id`をUUIDに戻して主キーが重複しない様に修正

## 0.0.12 - 2025-08-27

### 0.0.12 - Added

- **100言語対応の汎用言語サーバ サポート**
  - 主要プログラミング言語100種類に対応
  - 言語別最適化された設定（activationDelay, retryDelay）
  - システム言語、Web開発、関数型言語、科学計算等を包括的にサポート

- **言語サーバ処理の分離とモジュール化**
  - `languageServers.ts`として独立モジュール化
  - 再利用性とメンテナンス性の向上
  - 設定の集約管理

### 0.0.12 - Fixed

- **参照検索の精度向上**
  - `selectionRange`使用による正確なシンボル位置特定
  - C言語などでの参照検索失敗問題を解決
  - 言語サーバ準備完了待機機能の実装

- **デバッガサポートの改善**
  - esbuildでのソースマップ生成設定最適化
  - `sourcesContent`を開発時に有効化
  - ブレークポイント停止問題を解決

### 0.0.12 - Enhanced

- **言語サーバ管理機能**
  - 自動アクティベーション機能
  - 準備状態確認（DocumentSymbolProvider、HoverProvider、DefinitionProvider）
  - リトライ機能付き参照取得（最大3回）
  - バッチ処理による負荷分散

- **詳細ログとデバッグ機能**
  - 言語サーバ操作の詳細ログ出力
  - 参照検索プロセスの可視化
  - エラー原因特定の支援機能

### 0.0.12 - Languages Supported

**新規対応言語（50→100言語）:**

- **マークアップ**: TOML, INI
- **シェル**: Bash, Zsh, Fish  
- **データベース**: MySQL, PostgreSQL, SQLite, MongoDB
- **関数型**: Scheme, Racket, Common Lisp
- **システム**: Crystal, Carbon, V, Odin
- **スクリプト**: Tcl, AWK, SED
- **Web**: React, Astro, SolidJS, Ember, Lit, Stencil
- **モバイル**: Xamarin, React Native, Unity
- **設定**: Bazel, Gradle, Ant, Maven, SBT, Ninja, Meson
- **アセンブリ**: NASM, GAS, MASM, ARM, RISC-V, WebAssembly
- **ブロックチェーン**: Vyper, Cairo, Clarity, Cadence
- **科学計算**: Octave, Scilab, Fortran, COBOL, Mathematica, SageMath
- **GPU**: CUDA, OpenCL, HLSL, GLSL, Metal
- **ゲーム**: UnrealScript, ActionScript
- **DSL**: Regex, Graphviz, PlantUML, Mermaid, LaTeX, BibTeX, Gnuplot
- **歴史的**: Pascal, BASIC, Logo, Smalltalk, Forth, Prolog
- **エソテリック**: Brainfuck, Whitespace

## 0.0.9　- 2025-08-07

### 0.0.9　- Added

- ステータスバー進捗表示機能の追加 - initializeコマンドの進捗をリアルタイム表示
- データベーススキーマの改善 - start_character/end_character追加、参照テーブル構造変更
- コードファイル更新処理の最適化 - nochanges配列追加で不要な処理を削減

## 0.0.8　- 2025-07-28

### 0.0.8　- Added

- コード関係の取得を平行実行して高速化

## 0.0.7　- 2025-07-28

### 0.0.7　- Added

- **ファイル単位のコード関係図表示**
  - シンボル単位からファイル単位への表示変更
  - ファイル間の関係線の太さを関係数に応じて調整
  - ファイルノードの重なり防止とスペーシング改善

- **詳細な進捗ログシステム**
  - 開始からの経過時間表示（秒、小数点以下3桁）
  - 進捗率のパーセント表示（小数点以下2桁）
  - 関係線の詳細情報をログ出力
  - 関係数による並び替え（多い順）
  - 統計情報（合計、平均、最大、最小関係数）

### 0.0.7　- Changed

- **パフォーマンス向上**
  - ファイル単位でのグラフ要素生成により処理速度向上
  - 関係線の集約処理による表示の最適化

- **視覚的改善**
  - ファイル間の関係性をより明確に表現
  - 関係の密度に応じた線の太さと色の調整
  - ノード配置の最適化とレイアウト改善

## 0.0.6　- 2025-07-28

### 0.0.6　- Added

- **コード関係図の可視化機能を追加**
  - Cytoscape.jsを使用したインタラクティブなグラフ表示
  - 新しいコマンド: `Show Code Relationship Graph`
  - シンボル参照関係の抽出・保存機能
  - リアルタイムグラフレンダリング

- **階層構造を考慮したレイアウトシステム**
  - ファイル→クラス→メソッドの階層を視覚的に表現
  - 物理シミュレーションベースの自然な配置
  - 階層別の反発力とエッジ長調整

- **シンボル名表示機能**
  - `SymbolModel`クラスに`name`プロパティを追加
  - データベースに`name`カラムを追加
  - `vscode.DocumentSymbol.name`の適切な設定

- **進捗表示システム**
  - 画面上部の進捗バー表示
  - 処理段階ごとの詳細メッセージ
  - WebviewとTypeScript間の双方向通信

### 0.0.6　- Changed

- **VSCodeテーマ完全対応**
  - ダーク/ライトテーマに応じた背景色とUI色の自動調整
  - テーマ変更時の即座な反映

- **視覚的改善とユーザビリティ向上**
  - シンボル種別ごとのサイズとスタイル調整
  - 階層関係エッジ（青色、太線）と参照関係エッジ（赤色、細線）の明確な区別
  - 重なり防止とスペーシングの最適化
  - 縮小制限を"Fit to Screen"レベルに統一

- **セキュリティとパフォーマンス向上**
  - CDNからローカルnode_modulesへの参照移行
  - オフライン動作の実現
  - 依存関係の最適化

### 0.0.6　- Dependencies

- `cytoscape@^3.30.3` を追加
- `cytoscape-dagre@^2.5.0` を追加
- `duckdb-*.node`の`node-version`を`18`から`22`にアップグレード

## 0.0.５　- 2025-06-28

### 0.0.5　- Fixed

- 初期化(`initialize`)コマンドで、`Error: Cannot load duckdb.node: not a valid Win32 application`エラーが発生する fixed #7
  - 原因2: `duckdb.node`が、開発環境のMacOS用で、動作環境のWindows用では無いため発生していた。
    - 対策2-2: `duckdb`を動作環境により動的に読み込む様にした。

## 0.0.4　- 2025-06-23

### 0.0.4　- Fixed

- 初期化(`initialize`)コマンドで、`Error: Cannot load duckdb.node: not a valid Win32 application`エラーが発生する #7
  - 原因1: データベースファイル名が、Windows用では無いため発生していた。
    - 対策1: ファイルパスを`uri.path`から`uri.fsPath`に変更して、環境ごとのパス名にした。
  - 原因2: `duckdb.node`が、開発環境のMacOS用で、Windows用では無いため発生していた。
    - 対策2: `.vscodeignore`に`!node_modules/duckdb/node_modules/**`を追加して、環境ごとの動的バインディング(`node-gyp`)が動作する様にした。
      - MacOS:   `duckdb-darwin-arm64.node`
      - Windows: `duckdb-win32-x64.node`
      - Ubuntu:  `duckdb-linux-x64.node`

## 0.0.3　- 2025-06-22

### 0.0.3　- Fixed

- 初期化(`initialize`)コマンドで、`Error: Cannot load duckdb.node: not a valid Win32 application`エラーが発生する #7
  - 原因: `duckdb.node`が、開発環境のMacOS用で、Windows用では無いため発生していた。
  - 対策: 各々のOS用の`duckdb.node`を`GitHub Actions`で作成してバンドルした。
    - MacOS:   `duckdb-darwin-arm64.node`
    - Windows: `duckdb-win32-x64.node`
    - Ubuntu:  `duckdb-linux-x64.node`

## 0.0.2　- 2025-06-19

### 0.0.2　- Fixed

- 初期化(`initialize`)コマンドで、`Cannot find module 'duckdb'`エラーが発生する #6
  - `duckdb`モジュールを`.vscodeignore`で除外していた。
    - その他の参照モジュールも除外から外した。

## 0.0.1 - 2025-06-18

### 0.0.1 - Added

- 列挙ファイルでコードファイルテーブルを更新する #5
- 設定ファイルのファイル指定を読み込み検索する #3
- 多言語対応を行う #2
  - [Visual Studio Code 拡張のローカライズ対応方法](https://qiita.com/wraith13/items/8f873a1867a5cc2865a8)
- 設定ファイルがある場合に拡張機能を起動する #1
- Initial release
