
# Construction steps

## Tips

- VSCode DevTools: Option+Command+I
- uninstall Extension: code --uninstall-extension suzukimitsuru.vscode-code-relationship-diagram

## 1.プロジェクトの作成

- [vscodeの拡張機能を作ってみる](https://qiita.com/yuu_1st/items/d2d5a18de4859a165260)
  - sudo npm install -g yo generator-code
  - yo code

## 2.[Cytoscape.js](https://js.cytoscape.org/#getting-started) - Graph theory (network) library for visualisation and analysis

視覚化と分析のためのグラフ理論(ネットワーク)ライブラリ

``` shell
curl -o src/cytoscape.esm.min.mjs https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.32.0/cytoscape.esm.min.mjs
```

## 3.VSCode の拡張機能を公開する

### 3-1.VSCode Extention Marketplace コマンドのインストール

- `sudo npm install -g vsce`

### 3-2.パッケージ(`*.vsix`)の作成

  ``` shell
  yarn package
  vsce package
  unzip -l vscode-code-relationship-diagram-0.0.1.vsix
  ```

### 3-3.[Marketplace](https://marketplace.visualstudio.com/manage/publishers/suzukimitsuru)にアップロード

- 参考: [Azure DevOps Organization](https://dev.azure.com/suzukimitsuru/)

以下のサイトを参考にしました。

- [【VScode】自作した拡張機能を公開する方法](https://qiita.com/yusu79/items/44520c4c67864b0bb3e9)
