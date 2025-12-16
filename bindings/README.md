# DuckDB Bindings

This directory contains prebuilt DuckDB native binaries for multiple platforms and Node.js versions.

## Automatic Code Signing (macOS)

**Good news!** The extension now **automatically signs binaries** on macOS when needed. No manual intervention required.

When the extension loads a DuckDB binary on macOS, it will:
1. Check if the binary needs signing
2. Remove quarantine attributes (if present)
3. Apply an ad-hoc signature
4. Load the signed binary

This happens transparently in the background.

### Manual Signing (Optional)

If you prefer to sign binaries manually, you can still do so:

```bash
cd bindings
for file in duckdb-darwin-arm64-*.node; do
  xattr -d com.apple.quarantine "$file" 2>/dev/null || true
  codesign -s - -f "$file"
done
```

### Linux/Windows

No additional steps required. Binaries can be used directly.

## Building Locally

If you prefer to build binaries locally:

```bash
# Install Python 3.11+ (required for node-gyp)
# macOS: brew install python@3.11
# Linux: sudo apt-get install python3.11

# Build for Node.js 23 (ABI 140)
npm install
cd node_modules/duckdb
NODE_VERSION=23 npm run install --build-from-source

# Copy to bindings directory
cp lib/binding/duckdb.node ../../bindings/duckdb-darwin-arm64-abi140.node

# Sign on macOS
codesign -s - -f ../../bindings/duckdb-darwin-arm64-abi140.node
```

## Supported Platforms

| Platform | Node.js Versions | ABI Versions |
|----------|------------------|--------------|
| Linux x64 | 18, 20, 22, 23 | 108, 115, 127, 140 |
| macOS arm64 | 18, 20, 22, 23 | 108, 115, 127, 140 |
| Windows x64 | 18, 20 | 108, 115 |

**Note**: Windows does not support Node.js 22/23 due to DuckDB build issues.

## Fallback Behavior

If no compatible custom binding is found, the extension automatically falls back to the default DuckDB module from `node_modules/duckdb`.
