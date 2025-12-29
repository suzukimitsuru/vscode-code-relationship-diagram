# DuckDB Custom Bindings

このプロジェクトは、複数のNode.jsバージョンとプラットフォームに対応するため、DuckDBのカスタムバイナリビルドを使用します。

## サポート環境

### プラットフォーム
- **Linux x64** (Ubuntu 22.04+)
- **macOS arm64** (Apple Silicon) - macOS 14+
- **Windows x64** (Windows Server 2022)

### Node.js バージョン
- **Node.js 18.x** - Ubuntu 22.04推奨
- **Node.js 20.x**
- **Node.js 22.x**
- **Node.js 23.x**

### 注意事項
- **macOS x64 (Intel)**: 現在サポートされていません
- **Windows**: Node.js 22/23はDuckDBのプリビルドバイナリが提供されていないためサポート外
- macOS runnerは課金対象となるため、並行実行数を制限しています

## バイナリの命名規則

```
duckdb-{platform}-{arch}-v{major}.node
```

**パラメータ**:
- `{platform}`: `linux`, `darwin`, `win32`
- `{arch}`: `x64`, `arm64`
- `{major}`: Node.jsメジャーバージョン (`18`, `20`, `22`, `23`)

**例**:
- `duckdb-linux-x64-v18.node` - Linux x64, Node.js 18
- `duckdb-darwin-arm64-v22.node` - macOS Apple Silicon, Node.js 22
- `duckdb-win32-x64-v20.node` - Windows x64, Node.js 20

## バイナリのビルド方法

### GitHub Actionsを使用（推奨）

1. GitHubリポジトリの「Actions」タブに移動
2. 「Build duckdb.node for all platforms and Node.js versions」ワークフローを選択
3. 「Run workflow」をクリック
4. ワークフローが完了したら、各ジョブのアーティファクトをダウンロード
5. ダウンロードしたファイルを `bindings/` ディレクトリに配置

### ローカルビルド

```bash
# 必要なNode.jsバージョンをインストール（nvmを使用する場合）
nvm install 18
nvm use 18

# 依存関係をインストール
yarn install

# バイナリをコピー
mkdir -p bindings
cp node_modules/duckdb/lib/binding/duckdb.node bindings/duckdb-linux-x64-v18.node

# 他のNode.jsバージョンでも繰り返す
nvm install 20
nvm use 20
yarn install
cp node_modules/duckdb/lib/binding/duckdb.node bindings/duckdb-linux-x64-v20.node
```

## ランタイムでの動作

拡張機能の起動時に、`src/codeDb.ts` が以下の順序でバイナリをロードします：

1. **完全一致**: `duckdb-{platform}-{arch}-v{current}.node`
   - 現在のNode.jsメジャーバージョンに完全一致するバイナリ
   - 例: Node.js 20環境では `duckdb-linux-x64-v20.node`

2. **フォールバック**: 利用可能な最も近いメジャーバージョン
   - 現在のバージョン以下で最も近いバージョンを選択
   - 例: Node.js 21環境では `duckdb-linux-x64-v20.node` を使用

**注意**: 適切なバインディングが見つからない場合、`require()` はエラーをスローします。デフォルトバイナリへのフォールバックはありません。

**実装詳細**: [IMPLEMENTATION_SPECS.md §6.1](IMPLEMENTATION_SPECS.md#61-duckdbネイティブバインディング) を参照してください。

## トラブルシューティング

### エラー: "Module version mismatch"

**原因**: Node.jsバージョンとバイナリの不一致

**解決策**:
1. 現在のNode.jsバージョンを確認:
   ```bash
   node --version
   # v20.10.0 の場合、メジャーバージョンは 20
   ```
2. 対応するバイナリが `bindings/` に存在するか確認:
   ```bash
   ls bindings/duckdb-*-v20.node
   ```
3. 必要に応じてワークフローを実行してバイナリを再ビルド

### エラー: "Cannot find module"

**原因**: `bindings/` ディレクトリが存在しない、または空

**解決策**:
1. GitHub Actionsからバイナリをダウンロード
2. `bindings/` ディレクトリに配置
3. ファイル名が正しいことを確認

### Linux/Ubuntu特有の問題

**Ubuntu 24.04 + Node.js 18の互換性問題**:

Ubuntu 24.04のNode.js 18.19.1は、t64変更により予期しない動作をする場合があります。
この場合、以下の対処を推奨します：

1. Node.js 18の公式バイナリを使用する
2. または、Node.js 20以降にアップグレードする

**確認方法**:
```bash
node --version
# v18.19.1 (Ubuntu 24.04パッケージ) の場合、問題が発生する可能性あり
```

## 開発者向け情報

### バインディングのテスト

```bash
# 特定のNode.jsバージョンでテスト
nvm use 18
node -e "console.log('Node.js version:', process.version)"
yarn test

# すべてのバージョンでテスト
for version in 18 20 22 23; do
  nvm use $version
  echo "Testing with Node.js $version"
  node --version
  yarn test
done
```

### 新しいプラットフォーム/バージョンの追加

`.github/workflows/build-duckdb-binaries.yml` の `matrix.include` セクションに追加:

```yaml
- os: ubuntu-22.04
  arch: x64
  platform: linux
  node-version: 24  # 新しいバージョン
```

**注意**: `abi` パラメータは不要です。バインディング名はNode.jsメジャーバージョンのみを使用します。

### GitHub Actions Runner の選択

- **Linux**: `ubuntu-22.04`, `ubuntu-latest`
- **macOS Apple Silicon**: `macos-14`, `macos-latest` (課金対象)
- **macOS Intel**: サポート外 (必要な場合は `macos-15-large` を検討)
- **Windows**: `windows-2022`, `windows-latest`

**注意**: macOS runnerは課金対象のため、並行実行数を制限しています (max-parallel: 6)。

## 関連ドキュメント

### プロジェクト内
- [IMPLEMENTATION_SPECS.md §6 - マルチプラットフォーム対応](IMPLEMENTATION_SPECS.md#6-マルチプラットフォーム対応) - バインディング選択アルゴリズムとmacOSコード署名の詳細
- [IMPLEMENTATION_SPECS.md §6.2 - macOSコード署名](IMPLEMENTATION_SPECS.md#62-macosコード署名-bindingsautosignts) - `bindingsAutoSign.ts` の実装詳細
- [IMPLEMENTATION_SPECS.md §6.3 - GitHub Actionsビルドプロセス](IMPLEMENTATION_SPECS.md#63-github-actionsビルドプロセス) - CI/CDワークフローの詳細

### 外部リンク
- [DuckDB Node.js API Documentation](https://duckdb.org/docs/stable/clients/nodejs/overview)
- [Node.js Native Addons Guide](https://nodejs.org/api/addons.html)
- [GitHub Actions - Building and testing Node.js](https://docs.github.com/en/actions/automating-builds-and-tests/building-and-testing-nodejs)
