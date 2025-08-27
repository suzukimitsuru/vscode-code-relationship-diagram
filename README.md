# vscode-code-relationship-diagram

コードの関係図でソフトウェア全体を俯瞰しながら育てる事を目指しています。  
コードと連携した図で、ソフトウェアの形を見える様にします。  
良い設計のソフトウェアは、美しく見えると思います。  
`Visual Studio Code`の拡張機能として動作します。

![Screen shot](media/screen-shot.png)

## Operation

- 1.定義(シンボル)をデータベースに保存する。
  - a) `Ctrl(⌘)+Shift(⇧)+P`キーを押し、コマンドパレットを出力する。
  - b) `CRD: Initialize Code Relationship Diagram`コマンドを選ぶ。
- 2.関係図を表示する。
  - a) `Ctrl(⌘)+Shift(⇧)+P`キーを押し、コマンドパレットを出力する。
  - b) `CRD: Show Code Relationship Diagram`コマンドを選ぶ。

## Supported languages

- 1.システム言語 (10): C/C++, Rust, Go, Zig, Nim, D, Crystal, Carbon, V, Odin
- 2.Web開発 (18): JavaScript, TypeScript, HTML, CSS, SCSS, Less, PHP, Vue, Svelte, Angular, React, Astro, SolidJS, Ember, Lit, Stencil
- 3.モバイル/ゲーム開発 (9): Swift, Kotlin, Dart, Flutter, Objective-C, Xamarin, React Native, Unity, GDScript
- 4.関数型言語 (9): Haskell, OCaml, F#, Clojure, Elixir, Erlang, Scheme, Racket, Common Lisp
- 5.JVM言語 (2): Java, Groovy
- 6.スクリプト言語 (9): Python, Ruby, Lua, Perl, R, Julia, Tcl, AWK, SED
- 7.設定・マークアップ (18): JSON, XML, YAML, Markdown, TOML, INI, Dockerfile, Terraform, Makefile, CMake, Bazel, Gradle, Ant, Maven, SBT, Ninja, Meson
- 8.シェル (5): ShellScript, PowerShell, Bash, Zsh, Fish
- 9.データベース (5): SQL Server, MySQL, PostgreSQL, SQLite, MongoDB
- 10.アセンブリ・低レベル (7): x86-64 ASM, NASM, GAS, MASM, ARM, RISC-V, WebAssembly
- 11.ブロックチェーン (6): Solidity, Vyper, Move, Cairo, Clarity, Cadence
- 12.科学計算・データサイエンス (7): MATLAB, Octave, Scilab, Fortran, COBOL, Mathematica, SageMath
- 13.GPU・並列プログラミング (5): CUDA, OpenCL, HLSL, GLSL, Metal
- 14.ゲーム開発 (3): GDScript, UnrealScript, ActionScript
- 15.特殊DSL・ツール (7): Regex, Graphviz, PlantUML, Mermaid, LaTeX, BibTeX, Gnuplot
- 16.歴史的・教育言語 (6): Pascal, BASIC, Logo, Smalltalk, Forth, Prolog
- 17.エソテリック言語 (2): Brainfuck, Whitespace

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
