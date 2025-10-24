# C Language Exsample Workspace

このワークスペースは、Code Relationship Diagram 拡張機能の実行例として作成されたC言語プロジェクトです。

関係の抽出結果は、以下になる筈です。

- 9 processed 3 files(upserted 3, no changed 0, removed 0) 158 lines, 16 relationships

## ファイル構造

``` text
exsample-workspace/
├── include/
│   ├── math_utils.h      # 数学関数の宣言
│   └── string_utils.h    # 文字列操作関数の宣言
├── src/
│   ├── main.c           # メイン関数
│   ├── math_utils.c     # 数学関数の実装
│   └── string_utils.c   # 文字列操作関数の実装
├── .vscode/
│   ├── launch.json      # デバッグ設定
│   ├── tasks.json       # ビルドタスク設定
│   ├── c_cpp_properties.json  # C/C++言語サーバー設定
│   └── crd.duckdb       # コード関係図 データベース
├── Makefile             # ビルド設定
└── exsample-workspace.code-workspace   # ワークスペース
```

## 参照関係

このプロジェクトには以下の参照関係があります：

### ヘッダーファイル参照

- `main.c` → `math_utils.h`, `string_utils.h`
- `math_utils.c` → `math_utils.h`
- `string_utils.c` → `string_utils.h`, `math_utils.h`

### 関数参照

- `main.c`で`math_utils.c`と`string_utils.c`の関数を呼び出し
- `string_utils.c`で`math_utils.c`の関数を使用（クロス参照）

## ビルドと実行

### コマンドライン

``` bash
make          # ビルド
make run      # ビルドして実行
make clean    # クリーンアップ
make debug    # デバッグビルド
```

### VSCode

1. `Ctrl+Shift+P` → "Tasks: Run Build Task"
2. F5キーでデバッグ実行

## デバッグ設定

### C言語プログラムのデバッグ

- 設定名: "Debug Test Program"
- `stopAtEntry: true`でmain関数の最初で停止

### 拡張機能開発のデバッグ

- 設定名: "Launch Extension Host for CRD Testing"
- このワークスペースを開いた状態でCRD拡張機能をテスト

## CRD拡張機能テスト手順

1. F5キーで"Launch Extension Host for CRD Testing"を選択
2. 新しいVSCodeウィンドウが開く
3. CRDコマンドを実行してコード関係図を生成
4. C言語の参照関係が正しく検出されることを確認
