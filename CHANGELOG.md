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
