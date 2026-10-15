# Marketplace にプラットフォーム別 VSIX を登録する

この拡張機能は DuckDB のネイティブバイナリを含むため、**プラットフォーム別の VSIX** を作って Visual Studio Marketplace に登録する。
この文書は、VSIX の作り方、公開の準備（認証）、公開の手順、公開時の注意をまとめる。

- 調べた時点: 2026-10-15
- 使っている版: `@duckdb/node-api` 1.5.6-r.1 / `@vscode/vsce` 4.0.0

## 1. プラットフォーム別 VSIX とは

VS Code の拡張機能は、同じ拡張機能 ID・同じ版のまま、プラットフォームごとに別の VSIX を登録できる。
VS Code は利用者の環境に合う VSIX を Marketplace から自動で選んでインストールする。
リモート（SSH / WSL / Dev Containers）では、拡張機能が動くリモート側のプラットフォームの VSIX が選ばれる。

- **利用者から見ると**: 1つの拡張機能のまま。インストールや更新の手順は変わらない
- **公開する側から見ると**: ターゲットごとに VSIX を作り、全部を公開する（CI で自動化する）
- `.vsix` を手で配る場合だけ、利用者に正しいファイルを選んでもらう必要がある

### なぜプラットフォーム別にするか

| 理由 | 内容 |
|---|---|
| npm が実行中のプラットフォームの分しか入れない | DuckDB のバイナリ（`@duckdb/node-bindings-<platform>`）は npm の optionalDependencies。普通に `vsce package` すると作業したマシンの分しか入らない |
| 全部入りは大きい | 8 プラットフォーム分を入れると圧縮後 約 186MB（展開後 約 567MB）。プラットフォーム別なら 1 つ 15〜37MB |
| 配布先のサイズ制限 | Open VSX は 250MB と報告されている。Visual Studio Marketplace は上限を公開していない |
| 公式の推奨 | VS Code のドキュメントは、ネイティブモジュールを使う拡張機能にプラットフォーム別を勧めている |

### ターゲットと DuckDB のバイナリ

| VS Code のターゲット | DuckDB のバイナリ | VSIX の大きさ（0.3.39 で実測） |
|---|---|---|
| `win32-x64` | `@duckdb/node-bindings-win32-x64` | 14.5 MB |
| `win32-arm64` | `@duckdb/node-bindings-win32-arm64` | 15.4 MB |
| `linux-x64` | `@duckdb/node-bindings-linux-x64` | 24.4 MB |
| `linux-arm64` | `@duckdb/node-bindings-linux-arm64` | 22.2 MB |
| `alpine-x64` | `@duckdb/node-bindings-linux-x64-musl` | 25.1 MB |
| `alpine-arm64` | `@duckdb/node-bindings-linux-arm64-musl` | 23.3 MB |
| `darwin-x64` | `@duckdb/node-bindings-darwin-x64` | 36.7 MB |
| `darwin-arm64` | `@duckdb/node-bindings-darwin-arm64` | 36.6 MB |

`linux-armhf`（32 ビット ARM）と `web` は DuckDB がバイナリを配布していないため作らない。
ターゲットを指定しない汎用の VSIX も作らないので、これらの環境にはこの版をインストールできない。

## 2. このリポジトリでの仕組み

| 場所 | 役割 |
|---|---|
| `esbuild.js` | `@duckdb/node-api`（JS）は `dist/extension.js` に取り込む。ネイティブバイナリを読む `@duckdb/node-bindings` は取り込まず `node_modules` から読む（external） |
| `.vscodeignore` | `node_modules/@duckdb/node-bindings/**`・`node_modules/@duckdb/node-bindings-*/**`・`node_modules/detect-libc/**` を VSIX に入れる |
| `scripts/package-vsix.mjs` | ターゲットごとに `node_modules/@duckdb` のバイナリをそのターゲットの分だけに入れ替え（`npm pack` がレジストリの integrity を検証して取得する）、`vsce package --target` を実行する。最後に実行中のプラットフォームの分へ戻す |
| `.github/workflows/package-vsix.yml` | 全ターゲットの VSIX を作って成果物にする。手動実行で `publish` を選んだときだけ Marketplace に公開する |

DuckDB のバイナリを npm から取得するので、全ターゲットの VSIX を 1 台（Linux の 1 ジョブ）で作れる。
macOS や Windows のランナーは要らない。

拡張機能の実行時は `@duckdb/node-bindings` が実行中のプラットフォームを判定してバイナリを読み込む。
Linux の glibc と musl（Alpine）の判定には `detect-libc` を使う。

## 3. VSIX を作る

前提: Node.js 22 以上（`@vscode/vsce` 4 の要件）、`yarn install` 済み、npm レジストリに接続できること。

```bash
# 全ターゲット（vsix/ に 8 個できる。1 個あたり 20 秒ほど）
node scripts/package-vsix.mjs

# 一部のターゲットだけ
node scripts/package-vsix.mjs linux-x64 darwin-arm64
```

出力: `vsix/vscode-code-relationship-diagram-<version>-<target>.vsix`

各 VSIX の作成時に `vscode:prepublish`（型検査・lint・本番ビルド）が走る。

手元で動作を確かめる場合は、自分の環境の VSIX をインストールする。

```bash
code --install-extension vsix/vscode-code-relationship-diagram-<version>-linux-x64.vsix
```

GitHub Actions では、`main` への push と、パッケージに関わるファイルを変えた PR で VSIX を作る。
作った VSIX は `vsix` という成果物（30 日保持）からダウンロードできる。

## 4. 公開の準備（初回だけ）

### 4.1 publisher

`package.json` の `publisher`（`suzukimitsuru`）が Marketplace の publisher ID。
[publisher の管理ページ](https://marketplace.visualstudio.com/manage) で確認する。

### 4.2 認証方式を選ぶ

> **重要**: Azure DevOps の**グローバル PAT（全組織で使える PAT）は 2026-12-01 に廃止される**。
> VS Code の公式ドキュメントは、Microsoft Entra ID（ワークロード ID フェデレーション + マネージド ID）での公開を推奨している。

| 方式 | 長所 | 短所 |
|---|---|---|
| A. Microsoft Entra ID（推奨） | 長期間有効な秘密情報を持たない。PAT 廃止の影響を受けない | Azure（サブスクリプション）での準備が要る |
| B. PAT | 準備が簡単 | 2026-12-01 以降、グローバル PAT は使えない |

ワークフローは、GitHub の変数 `AZURE_CLIENT_ID` が設定されていれば A を、無ければ B（`VSCE_PAT`）を使う。

### 4.3 A. Microsoft Entra ID で公開する場合

公式ドキュメントの手順は Azure Pipelines 向けなので、ここでは GitHub Actions 向けに読み替えている。
**この読み替えはまだ実際に公開して確かめていない**。最初の公開で手順を確定させること。

1. **マネージド ID を作る（Azure）**
   - Azure ポータルで「ユーザー割り当てマネージド ID」を作る
   - クライアント ID とテナント ID を控える
2. **フェデレーション資格情報を追加する（Azure）**
   - マネージド ID の「フェデレーション資格情報」で「GitHub Actions」を選ぶ
   - 組織 `suzukimitsuru`、リポジトリ `vscode-code-relationship-diagram`、エンティティ `Environment`、名前 `marketplace`
   - サブジェクトは `repo:suzukimitsuru/vscode-code-relationship-diagram:environment:marketplace`、発行者は `https://token.actions.githubusercontent.com` になる
3. **GitHub の environment を作る**
   - リポジトリの Settings → Environments → `marketplace` を作る
   - 公開前に承認を挟みたければ Required reviewers を設定する
   - 変数（Variables）に `AZURE_CLIENT_ID` と `AZURE_TENANT_ID` を登録する
4. **マネージド ID のプロファイル ID を調べる（1 回だけ）**
   - マネージド ID でログインした状態で次を実行し、出力 JSON の `id` を控える
     ```bash
     az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me --resource 499b84ac-1321-427f-aa17-267ca6975798
     ```
   - GitHub Actions で一度だけ実行する場合は、`azure/login@v3`（`allow-no-subscriptions: true`）の後に上のコマンドを実行する一時的なワークフローを使う
5. **Marketplace の publisher にメンバーとして追加する**
   - [publisher の管理ページ](https://marketplace.visualstudio.com/manage) → publisher → Members で、4 の `id` を **Contributor** として追加する

公開のステップは `azure/login@v3` でログインしてから `vsce publish --azure-credential` を実行する（`.github/workflows/package-vsix.yml` の publish ジョブ）。

### 4.4 B. PAT で公開する場合

1. [Azure DevOps](https://go.microsoft.com/fwlink/?LinkId=307137) の User settings → Personal access tokens → New Token
2. Organization は **All accessible organizations**、Scopes は Custom defined → **Marketplace: Manage**
   - これはグローバル PAT なので、2026-12-01 以降は使えない
3. GitHub の environment `marketplace` のシークレット（Secrets）に `VSCE_PAT` として登録する

## 5. 公開する

### 5.1 GitHub Actions で公開する（推奨）

1. `package.json` の `version` を上げ、`CHANGELOG.md` を更新して `main` にマージする
2. Actions → **Package platform-specific VSIX** → **Run workflow** → `publish` にチェックを入れて実行する
3. package ジョブが全ターゲットの VSIX を作り、publish ジョブが全部を 1 回の `vsce publish --packagePath vsix/*.vsix` で公開する
   - environment に承認者を設定していれば、承認後に公開される
   - `--skip-duplicate` を付けているので、途中で失敗した後の再実行では公開済みのターゲットを飛ばす

### 5.2 手元から公開する

```bash
node scripts/package-vsix.mjs

# PAT の場合（VSCE_PAT を環境変数に入れるか、npx @vscode/vsce@4.0.0 login suzukimitsuru でログインする）
npx @vscode/vsce@4.0.0 publish --packagePath vsix/*.vsix

# Microsoft Entra ID の場合（az login 済みで、そのアカウントが publisher のメンバーであること）
npx @vscode/vsce@4.0.0 publish --azure-credential --packagePath vsix/*.vsix
```

## 6. 公開時の注意

- **全ターゲットを同じ版で公開する**。一部のターゲットだけ新しい版を公開すると、それ以外のターゲットの利用者には新しい版が届かない
- **同じ版・同じターゲットは公開し直せない**。直したら版を上げる。削除した版の番号も再利用できない
- **プレリリース**として公開する場合は、`vsce package` と `vsce publish` の両方に `--pre-release` を付ける（`scripts/package-vsix.mjs` には付けていない）。公式ドキュメントは、リリースを偶数の minor、プレリリースを奇数の minor にすることを勧めている
- **これまでの版（0.3.39 まで）は汎用の VSIX**（全プラットフォームの自前ビルドのバイナリ入り）。プラットフォーム別の版を公開すると、対応するプラットフォームではそちらが選ばれる
- **macOS**: DuckDB の `libduckdb.dylib` は Developer ID で署名済み、`duckdb.node` は arm64 版がリンカの ad-hoc 署名入り。以前の `bindingsAutoSign` による署名し直しはしない
- 公開後は Marketplace の拡張機能のページの Version History で、各版とターゲットを確認できる

## 7. Open VSX にも公開する場合（参考）

Open VSX のコマンドラインツール `ovsx` も、プラットフォーム別の VSIX をそのまま受け付ける。

```bash
# OVSX_PAT にアクセストークンを入れておく
npx ovsx@1.2.0 publish --packagePath vsix/*.vsix
```

Open VSX のサイズ上限は 250MB と報告されている。この拡張機能の VSIX は 1 つ 40MB 未満なので収まる。

## 参考

- [VS Code: Publishing Extensions - Platform-specific extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platform-specific-extensions)
- [VS Code: Secure automated publishing to Visual Studio Marketplace](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#secure-automated-publishing-to-visual-studio-marketplace)
- [Retirement of global Personal Access Tokens in Azure DevOps](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)
- [microsoft/vscode-platform-specific-sample](https://github.com/microsoft/vscode-platform-specific-sample)（公式のサンプルと CI）
- [Azure/login](https://github.com/Azure/login)（GitHub Actions から Entra ID でログインする）
- [@duckdb/node-api](https://www.npmjs.com/package/@duckdb/node-api)・[@duckdb/node-bindings](https://www.npmjs.com/package/@duckdb/node-bindings)
- [microsoft/vsmarketplace #1541: What is the maximum allowed VSIX size?](https://github.com/microsoft/vsmarketplace/issues/1541)
- [konveyor/editor-extensions #1494: VSIX exceeds Open VSX size limit](https://github.com/konveyor/editor-extensions/issues/1494)
