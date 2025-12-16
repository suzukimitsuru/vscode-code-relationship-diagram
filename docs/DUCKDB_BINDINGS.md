# DuckDB Custom Bindings

このプロジェクトは、複数のNode.jsバージョンとプラットフォームに対応するため、DuckDBのカスタムバイナリビルドを使用します。

## サポート環境

### プラットフォーム
- **Linux x64** (Ubuntu 22.04+)
- **macOS arm64** (Apple Silicon) - macOS 14+
- **macOS x64** (Intel Mac) - macOS 15 large runner (2027年8月まで利用可能)
- **Windows x64** (Windows Server 2022)

### Node.js / ABI バージョン
- **Node.js 18.x** (ABI 108) - Ubuntu 22.04推奨
- **Node.js 20.x** (ABI 115)
- **Node.js 22.x** (ABI 127)

### 注意事項
- macOS x64 (Intel) サポートは GitHub Actions の `macos-15-large` ランナーを使用します
- macOS-13 ランナーは2025年12月に廃止されるため、macos-15-largeに移行済みです
- macOS runnerは課金対象となるため、並行実行数を制限しています

## バイナリの命名規則

```
duckdb-{platform}-{arch}-abi{version}.node
```

例:
- `duckdb-linux-x64-abi108.node` - Linux x64, Node.js 18
- `duckdb-darwin-arm64-abi127.node` - macOS Apple Silicon, Node.js 22
- `duckdb-win32-x64-abi115.node` - Windows x64, Node.js 20

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
cp node_modules/duckdb/lib/binding/duckdb.node bindings/duckdb-linux-x64-abi108.node

# 他のNode.jsバージョンでも繰り返す
nvm install 20
nvm use 20
yarn install
cp node_modules/duckdb/lib/binding/duckdb.node bindings/duckdb-linux-x64-abi115.node
```

## ランタイムでの動作

拡張機能の起動時に、`src/codeDb.ts` が以下の順序でバイナリをロードします：

1. **完全一致**: `duckdb-{platform}-{arch}-abi{current}.node`
   - 現在のNode.js ABI版に完全一致するバイナリ

2. **フォールバック**: 利用可能な最も近いABIバージョン
   - ABI互換性を考慮して、利用可能なバイナリを試行

3. **デフォルト**: `npm install duckdb` からのバイナリ
   - カスタムバインディングが見つからない場合

## トラブルシューティング

### エラー: "Module version mismatch"

**原因**: Node.js ABI版とバイナリの不一致

**解決策**:
1. 現在のNode.js版を確認: `node -p "process.versions.modules"`
2. 対応するバイナリが `bindings/` に存在するか確認
3. 必要に応じてワークフローを実行してバイナリを再ビルド

### エラー: "Cannot find module"

**原因**: `bindings/` ディレクトリが存在しない、または空

**解決策**:
1. GitHub Actionsからバイナリをダウンロード
2. `bindings/` ディレクトリに配置
3. ファイル名が正しいことを確認

### Linux/Ubuntu特有の問題

Ubuntu 24.04のNode.js 18.19.1は、t64変更により予期しないABI 109を報告する場合があります。
この場合、Node.js 18の公式バイナリ（ABI 108）を使用することを推奨します。

## 開発者向け情報

### バインディングのテスト

```bash
# 特定のNode.jsバージョンでテスト
nvm use 18
node -e "console.log('ABI:', process.versions.modules)"
yarn test

# すべてのバージョンでテスト
for version in 18 20 22; do
  nvm use $version
  echo "Testing with Node.js $version (ABI: $(node -p process.versions.modules))"
  yarn test
done
```

### 新しいプラットフォーム/バージョンの追加

`.github/workflows/build-duckdb-binaries.yml` の `matrix.include` セクションに追加:

```yaml
- os: ubuntu-latest
  arch: x64
  platform: linux
  node-version: 23  # 新しいバージョン
  abi: 128          # 新しいABI
```

### GitHub Actions Runner の選択

- **Linux**: `ubuntu-22.04`, `ubuntu-latest`
- **macOS Apple Silicon**: `macos-14`, `macos-latest`
- **macOS Intel**: `macos-15-large` (課金対象、2027年8月まで)
- **Windows**: `windows-2022`, `windows-latest`

## 参考リンク

- [Node.js ABI Version Registry](https://github.com/nodejs/node/blob/main/doc/abi_version_registry.json)
- [DuckDB Node.js API Documentation](https://duckdb.org/docs/stable/clients/nodejs/overview)
- [Native Addons Guide](https://nodejs.org/api/addons.html)
