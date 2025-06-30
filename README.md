# vscode-code-relationship-diagram

コードの関係図でソフトウェア全体を俯瞰しながら育てる事を目指しています。  
コードと連携した図で、ソフトウェアの形を見える様にします。  
良い設計のソフトウェアは、美しく見えると思います。  
`Visual Studio Code`の拡張機能として動作します。

## Operation

- 1.定義(シンボル)をデータベースに保存する。
  - a) `Ctrl(⌘)+Shift(⇧)+P`キーを押し、コマンドパレットを出力する。
  - b) `CRD: Initialize Code Relationship Diagram`コマンドを選ぶ。

## Rordmap @beta

- 1.ソースコードから定義(シンボル)を抽出する。 <- **今ココ！**
- 2.`Visual Studio Code`から、定義(シンボル)の関係を抽出する。
- 3.関係図を表示する。

## Features @alpha

- ディレクトリ・ファイル・名前空間でグループ分けして、関係を線で現わす。
  - 階層構造を飛び越した依存を発見できる。

## Build steps

このプロジェクトを作った手順を説明します。

### Tips

- VSCode DevTools: `Option+Command+I`
- uninstall Extension: `code --uninstall-extension suzukimitsuru.vscode-code-relationship-diagram`

### 1.プロジェクトの作成

- [vscodeの拡張機能を作ってみる](https://qiita.com/yuu_1st/items/d2d5a18de4859a165260)
  - sudo npm install -g yo generator-code
  - yo code

### 2.VSCode の拡張機能を公開する

#### 2-1.VSCode Extention Marketplace コマンドのインストール

- `sudo npm install -g vsce`

### 2-2.パッケージ(`*.vsix`)の作成

  ``` shell
  yarn package
  vsce package
  unzip -l vscode-code-relationship-diagram-0.0.1.vsix
  ```

#### 2-3.[Marketplace](https://marketplace.visualstudio.com/manage/publishers/suzukimitsuru)にアップロード

以下のサイトを参考にしました。

- [Azure DevOps Organization](https://dev.azure.com/suzukimitsuru/)
- [【VScode】自作した拡張機能を公開する方法](https://qiita.com/yusu79/items/44520c4c67864b0bb3e9)

### 3.[Cytoscape.js](https://js.cytoscape.org/#getting-started) - Graph theory (network) library for visualisation and analysis

視覚化と分析のためのグラフ理論(ネットワーク)ライブラリ

``` shell
curl -o src/cytoscape.esm.min.mjs https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.32.0/cytoscape.esm.min.mjs
```
