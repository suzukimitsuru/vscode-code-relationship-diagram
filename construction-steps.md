
# Construction steps

## Tips

- VSCode DevTools: Option+Command+I
- uninstall Extension: code --uninstall-extension suzukimitsuru.code-attractor
- [marketplace](https://marketplace.visualstudio.com/manage/publishers/suzukimitsuru)
- nvm install: `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash  && source ~/.zshrc`
- node upgradeing: `nvm install --lts` `nvm alias default 'lts/*'` `nvm ls`
- npm upgradeing commands
  - `sudo npm install -g npm@latest`
  - `npm install`
  - `npm update`

## 1.プロジェクトの作成

- [vscodeの拡張機能を作ってみる](https://qiita.com/yuu_1st/items/d2d5a18de4859a165260)
  - sudo npm install -g yo generator-code
  - yo code

## 1.[Cytoscape.js](https://js.cytoscape.org/#getting-started) - Graph theory (network) library for visualisation and analysis

視覚化と分析のためのグラフ理論(ネットワーク)ライブラリ

``` shell
curl -o src/cytoscape.esm.min.mjs https://cdnjs.cloudflare.com/ajax/libs/cytoscape/3.32.0/cytoscape.esm.min.mjs
```

## 1.Three.js – JavaScript 3D Library

WebGLを使って三次元表現ができるライブラリ

- 参考: [three.js + TypeScript: 3次元空間で立方体を回してみる](https://qiita.com/FumioNonaka/items/dab4b854a1e3b541594c)

``` shell
npm install --save three
npm install --save-dev @types/three
npm install --save-dev three-orbitcontrols-ts
```

## 2.cannon.js - Lightweight 3D physics for the web

Webの為の軽い3次元物理エンジン

- 参考: [Cannon.js の世界へようこそ！ ３歩でわかる お手軽 物理シミュレーション](https://qiita.com/dsudo/items/66f41ef514344afeec4e)

``` shell
npm install --save cannon-es
npm install --save cannon-es-debugger
npm install --save-dev @types/cannon-es-debugger
```

## 3.VSCode の拡張機能を公開する

以下のサイトを参考にしました。

- [【VScode】自作した拡張機能を公開する方法](https://qiita.com/yusu79/items/44520c4c67864b0bb3e9)

- sudo npm install -g vsce
- [Azure DevOps Organization](https://dev.azure.com/suzukimitsuru/)
  - suzukimitsuru(suzukimitsuru-token: 5nBp2Q3lw5xPlutHEWU8g6nkduggTAStYzKsgZWMVSd4jEsmViUWJQQJ99BBACAAAAAAAAAAAAASAZDOaU2a
- vsce login suzukimitsuru
- vsce publish
- vsce logout suzukimitsuru

  ``` shell
  suzukimitsuru@suzukimitsuru-MacBook-Pro-2 vscode-code-attractor % vsce publish          
  (node:14625) [DEP0040] DeprecationWarning: The `punycode` module is deprecated. Please use a userland alternative instead.
  (Use `node --trace-deprecation ...` to show where the warning was created)
  INFO  Publishing 'suzukimitsuru.code-attractor v0.0.6'...
  INFO  Extension URL (might take a few minutes): https://marketplace.visualstudio.com/items?itemName=suzukimitsuru.code-attractor
  INFO  Hub URL: https://marketplace.visualstudio.com/manage/publishers/suzukimitsuru/extensions/code-attractor/hub
  DONE  Published suzukimitsuru.code-attractor v0.0.6.
  ```

- remove
  vsce ls-publishers
  vsce logout suzukimitsuru
  vsce delete-publisher suzukimitsru
  vsce delete-publisher suzukimitsrugunmaJapan

## 4.シーン内を動き回れる WalkThroughControls を作る

視点を中心としたカメラの移動により、自然に三次元空間を移動したい。

- 視点: マウスポインタの位置/タッチパネルのピンチの中心
- 前進/後退: マウスのホイール/トラックパッドやタッチパネルのピンチ
- 方向転換: マウスのドラッグ/トラックパッドやタッチパネルのスワイプ

予定と言えないが、こんな事をしようと思っている。

- 3-1.OrbitControls を TypeScript に移植してみる。
- 3-2.コントローラのイベントと構造を考える。
- 　　　: (試行錯誤)
- 3-9.WalkThroughControls の完成!!
