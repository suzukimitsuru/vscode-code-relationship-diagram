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

前提: **Node.js 22.12.0 以上**、`yarn install` 済み、npm レジストリに接続できること。

> `@vscode/vsce` 4 は ES Module 専用の依存（`parse5` 8）を `require()` で読み込むため、`require()` で ES Module を読める Node.js 22.12.0 以上が必要。vsce の `package.json` は `node: ">= 22"` としているが、22.11 以前では `ERR_REQUIRE_ESM` で失敗する。`scripts/package-vsix.mjs` は最初に版を確かめ、足りなければ止まる。

#### Node.js を更新する（macOS）

`which node` の場所で、どの方法で入れたかが分かる。更新後は `node -v` で 22.12.0 以上（22 系の最新は 22.23.3、24 系は 24.22.0。2026-10-15 時点）になっている事を確かめる。

| `which node` の場所 | 入れ方 | 更新方法 |
|---|---|---|
| `/usr/local/bin/node` | 公式インストーラ | [nodejs.org](https://nodejs.org/) から 24 系（LTS）か 22 系の最新の macOS インストーラ（`.pkg`）を入れ直す |
| `/opt/homebrew/...` | Homebrew | `brew update && brew install node@24`（または `node@22`）。版付きの formula は PATH に入らないので、`~/.zprofile` に `export PATH="/opt/homebrew/opt/node@24/bin:$PATH"` を足す。`brew install node` は最新の 26 系になる |
| `~/.nvm/...` | nvm | `nvm install 24 && nvm alias default 24`（または 22）。グローバルに入れた yarn は版ごとなので `npm install -g yarn@1.22.22` を入れ直す |
| `~/.volta/...` / `~/.local/share/fnm/...` など | Volta / fnm / mise | 各ツールで 24 系か 22 系の最新を入れ、既定にする（例: `volta install node@24`、`fnm install 24 && fnm default 24`） |

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

### 4.2 公開の方法を選ぶ

> **重要**: Azure DevOps の**グローバル PAT（全組織で使える PAT）は 2026-12-01 に廃止される**。
> 自動で公開し続けるなら、Microsoft Entra ID で認証する。

| 方式 | Azure のサブスクリプション | 自動化 | 準備 |
|---|---|---|---|
| A. Web から手動で公開 | 不要 | なし | 不要（0.3.40 はこの方法で公開した） |
| B. Microsoft Entra ID の**アプリの登録**（推奨） | 不要 | あり | 4.3 の手順（初回だけ） |
| C. PAT | 不要 | あり | 2026-12-01 以降、グローバル PAT は使えない |

- 公式ドキュメントはマネージド ID を例にしているが、**マネージド ID は Azure のリソースなので有効なサブスクリプションが無いと作れない**（Azure ポータルのサブスクリプション一覧が空なら作れない）。アプリの登録はテナント（ディレクトリ）に作るため、サブスクリプションは要らない
- ワークフローは、GitHub の変数 `AZURE_CLIENT_ID` が設定されていれば B を、無ければ C（`VSCE_PAT`）を使う

### 4.3 B. Microsoft Entra ID（アプリの登録）で公開する場合

2026-10-15 に、この手順で GitHub Actions から Entra ID にログインし、Marketplace の拡張機能の情報を読めるところまで確認した。
（0.3.40 は手動で公開済みだったため、アプリでのアップロードは次の版で確かめる。）

#### 1. アプリを登録する（Entra 管理センター）

1. [Entra 管理センター](https://entra.microsoft.com) → アプリの登録 → 新規登録
   - 名前: 例 `crd-marketplace-publisher`
   - サポートされているアカウントの種類: この組織ディレクトリのみ（シングルテナント）
2. 「概要」の **アプリケーション (クライアント) ID** と **ディレクトリ (テナント) ID** を控える

#### 2. フェデレーション資格情報を追加する（Entra 管理センター）

アプリの「証明書とシークレット」→「フェデレーション資格情報」→「資格情報の追加」→ シナリオ「GitHub Actions」。

| 項目 | 値 |
|---|---|
| 組織 | `suzukimitsuru` |
| Organization ID | `796061`（所有者のユーザー ID） |
| リポジトリ | `vscode-code-relationship-diagram` |
| Repository ID | `934187440` |
| エンティティ型 | 環境 |
| GitHub 環境名 | `marketplace` |
| サブジェクト識別子 | `repo:suzukimitsuru@796061/vscode-code-relationship-diagram@934187440:environment:marketplace` |
| 名前 | 任意（例 `marketplace`） |

- ID は `https://api.github.com/repos/suzukimitsuru/vscode-code-relationship-diagram` の `"id"`（リポジトリ）と `"owner"` の `"id"`（ユーザー）で確かめられる
- サブジェクト識別子は、名前と変わらない数値 ID を含む **ID 入りの形式（immutable 形式）**。GitHub は 2026-07-15 以降に作った（または名前の変更・移管をした）リポジトリでこの形式を使い、それより前のリポジトリは名前だけの形式（`repo:suzukimitsuru/vscode-code-relationship-diagram:environment:marketplace`）のまま。**このリポジトリは 3 でオプトインして ID 入りの形式にしている**。形式が食い違うと、公開ジョブの `Azure login` が「一致する資格情報が無い」という趣旨のエラーで失敗する

#### 3. GitHub のリポジトリを ID 入りのサブジェクトにオプトインする

リポジトリ単位の REST API（`PUT /repos/{owner}/{repo}/actions/oidc/customization/sub` の `use_immutable_subject`）で切り替える。
GitHub CLI（`brew install gh` → `gh auth login`。既定で `repo` スコープが付く）を使う場合:

```zsh
# オプトインする
gh api -X PUT repos/suzukimitsuru/vscode-code-relationship-diagram/actions/oidc/customization/sub \
  -F use_default=true -F use_immutable_subject=true

# 確かめる（"use_immutable_subject": true、"sub_claim_prefix": "repo:suzukimitsuru@796061/vscode-code-relationship-diagram@934187440"）
gh api repos/suzukimitsuru/vscode-code-relationship-diagram/actions/oidc/customization/sub
```

元に戻す場合は `-F use_immutable_subject=false` で同じ `PUT` を送る。

#### 4. GitHub の environment を作る

リポジトリの Settings → Environments → **New environment** で `marketplace` を作り、変数（Variables）を登録する。

| 名前 | 値 |
|---|---|
| `AZURE_CLIENT_ID` | アプリケーション (クライアント) ID |
| `AZURE_TENANT_ID` | ディレクトリ (テナント) ID |

公開前に承認を挟みたければ Required reviewers を設定する。`VSCE_PAT` は登録しない。

#### 5. アプリのプロファイル ID を調べる（手元の Mac で 1 回だけ）

アプリとしてログインした状態でしか取れないので、一時的なクライアント シークレットでログインして調べ、終わったらシークレットを削除する。

1. **Azure CLI を入れる**
   ```zsh
   brew update && brew install azure-cli
   az version
   ```
   > Apple Silicon の Mac で Homebrew が `/usr/local`（Intel 用の場所）にあると、`Bad CPU type in executable` で失敗する（Intel Mac から移行した環境で起きる）。Apple Silicon 用の Homebrew を `/opt/homebrew` に入れ、`~/.zprofile` に `eval "$(/opt/homebrew/bin/brew shellenv)"` を足して優先させる。
2. **一時的なクライアント シークレットを作る**: アプリの「証明書とシークレット」→「クライアント シークレット」→「新しいクライアント シークレット」（有効期限は最短）。表示された **「値」**（「シークレット ID」ではない）をコピーする
3. **アプリとしてログインし、プロファイル ID を取得する**
   ```zsh
   APP_ID=<アプリケーション (クライアント) ID>
   TENANT_ID=<ディレクトリ (テナント) ID>
   read -s "SECRET?クライアントシークレットの値: "; echo

   # サブスクリプションが無いので --allow-no-subscriptions を付ける
   az login --service-principal --username "$APP_ID" --password "$SECRET" --tenant "$TENANT_ID" --allow-no-subscriptions

   # 499b84ac-... は Azure DevOps を表す固定の ID
   az rest -u https://app.vssps.visualstudio.com/_apis/profile/profiles/me \
     --resource 499b84ac-1321-427f-aa17-267ca6975798 --query id -o tsv
   ```
   表示された GUID がアプリのプロファイル ID。
4. **後片付け**: `az logout` と `unset SECRET` を実行し、Entra 管理センターで 2 のシークレットを**削除**する

#### 6. Marketplace の publisher にメンバーとして追加する

[publisher の管理ページ](https://marketplace.visualstudio.com/manage) → publisher `suzukimitsuru` → **Members** → Add で、5 のプロファイル ID を **Contributor** として追加する。

公開の権限は、アプリとしてログインした状態で `npx @vscode/vsce@4.0.0 verify-pat --azure-credential suzukimitsuru` を実行して確かめられる（5 のシークレットを削除する前に行う）。

### 4.4 C. PAT で公開する場合

1. [Azure DevOps](https://go.microsoft.com/fwlink/?LinkId=307137) の User settings → Personal access tokens → New Token
2. Organization は **All accessible organizations**、Scopes は Custom defined → **Marketplace: Manage**
   - これはグローバル PAT なので、2026-12-01 以降は使えない
3. GitHub の environment `marketplace` のシークレット（Secrets）に `VSCE_PAT` として登録する

## 5. 公開する

どの方法でも、先に `package.json` の `version` を上げ、`CHANGELOG.md` を更新して `main` にマージする。

### 5.1 Web から手動で公開する（0.3.40 で実施）

1. VSIX を用意する: Actions の成果物 `vsix` をダウンロードするか、手元で `node scripts/package-vsix.mjs` を実行する（8 個）
2. [publisher の管理ページ](https://marketplace.visualstudio.com/manage) で、拡張機能の更新（Update）から VSIX をアップロードする
3. 8 ターゲット分を 1 つずつ繰り返す。VSIX のマニフェストにターゲットが入っているので、それぞれのターゲットの版として登録される

### 5.2 GitHub Actions で公開する（推奨・4.3 の準備が必要）

1. Actions → **Package platform-specific VSIX** → **Run workflow** → `publish` にチェックを入れて実行する
2. package ジョブが全ターゲットの VSIX を作り、publish ジョブが全部を 1 回の `vsce publish --packagePath vsix/*.vsix` で公開する
   - environment に承認者を設定していれば、承認後に公開される
   - `--skip-duplicate` を付けているので、**同じ版・同じターゲットが公開済みなら、アップロードせずに成功で終わる**。ログの `Version x.y.z is already published. Skipping publish.` で分かる。途中で失敗した後の再実行では、公開済みのターゲットを飛ばして残りを公開する
3. 公開ジョブのログの `Azure login` に、トークンのサブジェクト（`subject claim - repo:suzukimitsuru@796061/...:environment:marketplace`）が出る。ログインに失敗した場合は、4.3 の 2 のサブジェクト識別子と一致しているかを確かめる

### 5.3 手元から公開する

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
- [GitHub Docs: OpenID Connect reference - Immutable subject claims](https://docs.github.com/en/actions/reference/security/oidc#immutable-subject-claims)
- [GitHub REST API: OIDC](https://docs.github.com/en/rest/actions/oidc)（`use_immutable_subject`）
- [Microsoft Entra: Migrate GitHub Actions federated credentials to immutable subjects](https://learn.microsoft.com/en-us/entra/workload-id/workload-identities-github-immutable-subjects)
- [Microsoft Learn: Manage user-assigned managed identities](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/how-manage-user-assigned-managed-identities)（マネージド ID にはサブスクリプションが要る）
- [@duckdb/node-api](https://www.npmjs.com/package/@duckdb/node-api)・[@duckdb/node-bindings](https://www.npmjs.com/package/@duckdb/node-bindings)
- [microsoft/vsmarketplace #1541: What is the maximum allowed VSIX size?](https://github.com/microsoft/vsmarketplace/issues/1541)
- [konveyor/editor-extensions #1494: VSIX exceeds Open VSX size limit](https://github.com/konveyor/editor-extensions/issues/1494)
