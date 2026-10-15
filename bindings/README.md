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
# Install Python 3.13 (for node-gyp bundled with npm 11)
# macOS: brew install python@3.13
# Linux: sudo apt-get install python3.13

# Use npm 11+ (npm 10.x crashes while resolving devDependencies)
npm install -g npm@11

# Build for the current Node.js version
npm install
cd node_modules/duckdb
npm run install --build-from-source

# Copy to bindings directory (e.g. Node.js 24 on macOS arm64)
cp lib/binding/duckdb.node ../../bindings/duckdb-darwin-arm64-v24.node

# Sign on macOS
codesign -s - -f ../../bindings/duckdb-darwin-arm64-v24.node
```

## Supported Platforms

| Platform | Node.js Versions | Build Runner |
|----------|------------------|--------------|
| Linux x64 | 22, 24, 26 | ubuntu-22.04 (glibc 2.35+) |
| Linux arm64 | 22, 24, 26 | ubuntu-22.04-arm (glibc 2.35+) |
| macOS arm64 | 22, 24, 26 | macos-15 (macOS 10.15+) |
| Windows x64 | 22, 24, 26 | windows-2025 |

DuckDB's Node.js binding uses N-API (`NAPI_VERSION=6`), so a binary is not tied to a specific Node.js ABI.
The extension loads the binary for the nearest Node.js major version (e.g. VS Code with Node.js 20 loads `v22`).

## Fallback Behavior

If no compatible custom binding is found, the extension automatically falls back to the default DuckDB module from `node_modules/duckdb`.
