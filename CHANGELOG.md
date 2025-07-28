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
