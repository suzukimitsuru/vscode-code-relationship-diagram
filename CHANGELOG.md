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

## [0.0.５]　- 2025-06-28

- 初期化(`initialize`)コマンドで、`Error: Cannot load duckdb.node: not a valid Win32 application`エラーが発生する fixed #7
  - 原因2: `duckdb.node`が、開発環境のMacOS用で、動作環境のWindows用では無いため発生していた。
    - 対策2-2: `duckdb`を動作環境により動的に読み込む様にした。

## [0.0.4]　- 2025-06-23

### [0.0.4]　- Fixed

- 初期化(`initialize`)コマンドで、`Error: Cannot load duckdb.node: not a valid Win32 application`エラーが発生する #7
  - 原因1: データベースファイル名が、Windows用では無いため発生していた。
    - 対策1: ファイルパスを`uri.path`から`uri.fsPath`に変更して、環境ごとのパス名にした。
  - 原因2: `duckdb.node`が、開発環境のMacOS用で、Windows用では無いため発生していた。
    - 対策2: `.vscodeignore`に`!node_modules/duckdb/node_modules/**`を追加して、環境ごとの動的バインディング(`node-gyp`)が動作する様にした。
      - MacOS:   `duckdb-darwin-arm64.node`
      - Windows: `duckdb-win32-x64.node`
      - Ubuntu:  `duckdb-linux-x64.node`

## [0.0.3]　- 2025-06-22

### [0.0.3]　- Fixed

- 初期化(`initialize`)コマンドで、`Error: Cannot load duckdb.node: not a valid Win32 application`エラーが発生する #7
  - 原因: `duckdb.node`が、開発環境のMacOS用で、Windows用では無いため発生していた。
  - 対策: 各々のOS用の`duckdb.node`を`GitHub Actions`で作成してバンドルした。
    - MacOS:   `duckdb-darwin-arm64.node`
    - Windows: `duckdb-win32-x64.node`
    - Ubuntu:  `duckdb-linux-x64.node`

## [0.0.2]　- 2025-06-19

### [0.0.2]　- Fixed

- 初期化(`initialize`)コマンドで、`Cannot find module 'duckdb'`エラーが発生する #6
  - `duckdb`モジュールを`.vscodeignore`で除外していた。
    - その他の参照モジュールも除外から外した。

## [0.0.1] - 2025-06-18

### [0.0.1] - Added

- 列挙ファイルでコードファイルテーブルを更新する #5
- 設定ファイルのファイル指定を読み込み検索する #3
- 多言語対応を行う #2
  - [Visual Studio Code 拡張のローカライズ対応方法](https://qiita.com/wraith13/items/8f873a1867a5cc2865a8)
- 設定ファイルがある場合に拡張機能を起動する #1
- Initial release
