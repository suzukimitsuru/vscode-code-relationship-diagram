# Cosmos.gl 移行計画

## 概要

現在のCytoscape.js実装からCosmos.glへ移行し、大規模グラフ（100万ノード以上）に対応する。

### 目標

- **ノード数制限の撤廃**: 現在の50,000ノード制限を解消
- **GPUアクセラレーション**: レイアウト計算とレンダリングをGPU上で実行
- **階層的表示**: ディレクトリ→ファイル→シンボルの階層構造を視覚化
- **インタラクティブ性**: 現在の機能（ドラッグ、ズーム、ツールチップ）を維持・強化

### 参考資料

- [Cosmos.gl GitHub](https://github.com/cosmograph-org/cosmos)
- [Cosmograph ドキュメント](https://next.cosmograph.app/docs-general/concept/)
- [@cosmograph/cosmos npm](https://www.npmjs.com/package/@cosmograph/cosmos)

---

## アーキテクチャ設計

### 新しいビジュアル構造

```
┌─────────────────────────────────────────────────────────┐
│                      Project Root                        │
│                                                         │
│   ┌─────────────┐         ┌─────────────┐              │
│   │   src/      │─────────│   tests/    │              │
│   │  ┌───────┐  │         │  ┌───────┐  │              │
│   │  │file.ts│  │         │  │test.ts│  │              │
│   │  │ ○ ○ ○ │  │         │  │ ○ ○   │  │              │
│   │  │○ ● ○  │──┼─────────┼──│ ○ ●   │  │              │
│   │  │ ○ ○ ○ │  │         │  │       │  │              │
│   │  └───────┘  │         │  └───────┘  │              │
│   │  ┌───────┐  │         │             │              │
│   │  │util.ts│  │         │             │              │
│   │  │ ○ ● ○ │  │         │             │              │
│   │  └───────┘  │         │             │              │
│   └─────────────┘         └─────────────┘              │
│                                                         │
└─────────────────────────────────────────────────────────┘

● = シンボル（関数、クラス、変数など）
○ = 他のシンボル
─ = 関係線（太さ = 関係数）
```

### ノード配置戦略

| レベル | 要素 | 配置方式 | サイズ |
|--------|------|---------|--------|
| **L0** | ディレクトリ | フォースレイアウト（外側） | 含むファイル数に比例 |
| **L1** | ファイル | 親ディレクトリ内に配置 | 含むシンボル数に比例 |
| **L2** | シンボル | 親ファイルの円内にパック | 固定サイズ |

---

## ファイル構成

### 新規作成ファイル

```
src/
├── webview/
│   ├── cosmosView.ts          # Cosmos.glメインビュー
│   ├── hierarchicalLayout.ts  # 階層的レイアウト計算
│   ├── directoryFilter.ts     # ディレクトリフィルタUI
│   └── codeNavigation.ts      # コード↔グラフ連携
├── relationship/
│   └── cosmosAdapter.ts       # Cosmos.gl用データ変換
templates/
└── cosmos-view.html           # 新しいHTMLテンプレート
```

### 変更ファイル

```
src/
├── relationship/
│   └── visualization.ts       # Cosmos.gl対応追加
├── extension.ts               # コマンド追加
package.json                   # 依存関係追加
```

---

## Phase 1: 基盤構築

### 1.1 依存関係の追加

```json
// package.json
{
  "dependencies": {
    "@cosmograph/cosmos": "^2.0.0",
    "graphology": "^0.26.0",
    "graphology-communities-louvain": "^2.0.2"
  }
}
```

### 1.2 Cosmos.glアダプター

```typescript
// src/relationship/cosmosAdapter.ts

import { Graph } from '@cosmograph/cosmos';
import * as SYMBOL from '../extruct/symbol';

/**
 * シンボルデータをCosmos.gl形式に変換
 */
export interface CosmosNode {
    id: string;
    x: number;
    y: number;
    size: number;
    color: string;
    // 階層情報
    parentId: string | null;
    level: 'directory' | 'file' | 'symbol';
    // メタデータ
    label: string;
    path: string;
    kind: number;
    line?: number;
}

export interface CosmosLink {
    source: number;  // ノードインデックス
    target: number;
    width: number;   // 関係数に基づく太さ
    color: string;
    // ツールチップ用
    details: RelationshipDetail[];
}

export interface RelationshipDetail {
    sourceName: string;
    targetName: string;
    sourceLine: number;
    targetLine: number;
}

/**
 * シンボルとリレーションシップをCosmos形式に変換
 */
export function convertToCosmosFormat(
    symbols: SYMBOL.SymbolModel[],
    relationships: Relationship[]
): { nodes: CosmosNode[], links: CosmosLink[] };

/**
 * 階層的な初期位置を計算
 * - ディレクトリ: フォースレイアウトで配置
 * - ファイル: 親ディレクトリの円内に配置
 * - シンボル: 親ファイルの円内にパック配置
 */
export function calculateHierarchicalPositions(
    nodes: CosmosNode[],
    links: CosmosLink[]
): Float32Array;
```

### 1.3 階層的レイアウト計算

```typescript
// src/webview/hierarchicalLayout.ts

/**
 * 円パッキングアルゴリズムでシンボルを配置
 */
export function packSymbolsInCircle(
    symbols: CosmosNode[],
    parentCenter: { x: number, y: number },
    parentRadius: number
): void {
    // d3-hierarchy の pack() アルゴリズムを使用
    // シンボルを親ファイルの円内に詰め込む
}

/**
 * ディレクトリの階層構造を反映したレイアウト
 */
export function layoutDirectoryHierarchy(
    directories: CosmosNode[],
    files: CosmosNode[]
): void {
    // 1. ディレクトリをフォースレイアウトで配置
    // 2. 各ディレクトリ内にファイルを配置
    // 3. 各ファイル内にシンボルをパック配置
}
```

---

## Phase 2: Webviewコンポーネント

### 2.1 Cosmos.glビュー

```typescript
// src/webview/cosmosView.ts

import { Graph } from '@cosmograph/cosmos';

export class CosmosGraphView {
    private graph: Graph;
    private canvas: HTMLCanvasElement;
    private visibleDirectories: Set<string>;

    constructor(container: HTMLElement) {
        this.canvas = document.createElement('canvas');
        container.appendChild(this.canvas);

        this.graph = new Graph(this.canvas, {
            backgroundColor: '#1e1e1e',
            nodeColor: (node) => node.color,
            nodeSize: (node) => node.size,
            linkWidth: (link) => link.width,
            linkColor: (link) => link.color,
            simulation: {
                repulsion: 0.5,
                gravity: 0.1,
                friction: 0.9,
            },
            events: {
                onClick: this.handleNodeClick.bind(this),
                onHover: this.handleNodeHover.bind(this),
            },
        });
    }

    /**
     * ノードクリック: ファイル/シンボルを開く
     */
    private handleNodeClick(node: CosmosNode): void {
        if (node.level === 'file' || node.level === 'symbol') {
            vscode.postMessage({
                type: 'openFile',
                path: node.path,
                line: node.line,
            });
        }
    }

    /**
     * ノードホバー: ツールチップ表示
     */
    private handleNodeHover(node: CosmosNode | null): void {
        // ツールチップUI更新
    }

    /**
     * ディレクトリフィルタ適用
     */
    public setDirectoryVisibility(dirPath: string, visible: boolean): void {
        if (visible) {
            this.visibleDirectories.add(dirPath);
        } else {
            this.visibleDirectories.delete(dirPath);
        }
        this.updateVisibleNodes();
    }

    /**
     * 特定ノードにズーム
     */
    public zoomToNode(nodeId: string): void {
        const node = this.findNode(nodeId);
        if (node) {
            this.graph.zoomToNodeById(nodeId, {
                duration: 500,
                padding: 50,
            });
        }
    }

    /**
     * 関連ノード群にズーム
     */
    public zoomToRelatedNodes(nodeIds: string[]): void {
        // 複数ノードを含むバウンディングボックスにズーム
    }
}
```

### 2.2 ディレクトリフィルタUI

```typescript
// src/webview/directoryFilter.ts

export class DirectoryFilterPanel {
    private container: HTMLElement;
    private directories: Map<string, DirectoryInfo>;
    private onVisibilityChange: (path: string, visible: boolean) => void;

    constructor(
        container: HTMLElement,
        onVisibilityChange: (path: string, visible: boolean) => void
    ) {
        this.container = container;
        this.onVisibilityChange = onVisibilityChange;
        this.directories = new Map();
    }

    /**
     * ディレクトリツリーを構築
     */
    public buildTree(nodes: CosmosNode[]): void {
        // ディレクトリ階層をツリー構造で表示
        // 各ディレクトリにチェックボックス付き
    }

    /**
     * UIを生成
     */
    private renderDirectoryItem(dir: DirectoryInfo, depth: number): HTMLElement {
        const item = document.createElement('div');
        item.className = 'directory-item';
        item.style.paddingLeft = `${depth * 16}px`;

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = dir.visible;
        checkbox.addEventListener('change', () => {
            this.onVisibilityChange(dir.path, checkbox.checked);
        });

        const label = document.createElement('span');
        label.textContent = `${dir.name} (${dir.fileCount} files, ${dir.symbolCount} symbols)`;

        item.appendChild(checkbox);
        item.appendChild(label);

        return item;
    }
}
```

### 2.3 コード↔グラフ連携

```typescript
// src/webview/codeNavigation.ts

/**
 * VSCodeエディタとグラフビューの双方向連携
 */
export class CodeGraphNavigation {
    private graphView: CosmosGraphView;

    /**
     * エディタでカーソル位置が変わった時
     * → グラフ上の対応シンボルをハイライト＆ズーム
     */
    public onEditorCursorChange(filePath: string, line: number): void {
        const symbolId = this.findSymbolAtPosition(filePath, line);
        if (symbolId) {
            this.graphView.highlightNode(symbolId);
            this.graphView.zoomToNode(symbolId);
        }
    }

    /**
     * エディタでファイルが開かれた時
     * → グラフ上の対応ファイルとその関連をハイライト
     */
    public onEditorFileOpen(filePath: string): void {
        const fileNode = this.findFileNode(filePath);
        if (fileNode) {
            const relatedNodes = this.findRelatedNodes(fileNode.id);
            this.graphView.highlightNodes([fileNode.id, ...relatedNodes]);
            this.graphView.zoomToRelatedNodes([fileNode.id, ...relatedNodes]);
        }
    }

    /**
     * 「関連コードを表示」コマンド
     * 選択範囲のシンボルとその依存関係をズーム表示
     */
    public showRelatedCode(selection: vscode.Selection): void {
        const symbolsInSelection = this.findSymbolsInRange(selection);
        const relatedSymbols = this.expandRelationships(symbolsInSelection);

        this.graphView.filterToNodes(relatedSymbols);
        this.graphView.zoomToRelatedNodes(relatedSymbols);
    }
}
```

---

## Phase 3: 関係線の機能維持

### 3.1 関係線の太さ

```typescript
// 関係数に基づく太さ計算
function calculateLinkWidth(relationshipCount: number): number {
    // 対数スケールで太さを決定（1-10の範囲）
    return Math.min(1 + Math.log2(relationshipCount + 1) * 2, 10);
}
```

### 3.2 ツールチップとナビゲーション

```typescript
// 関係線ホバー時のツールチップ
interface LinkTooltip {
    sourceFile: string;
    targetFile: string;
    relationships: Array<{
        sourceName: string;
        targetName: string;
        sourceLine: number;
        targetLine: number;
    }>;
}

// ツールチップ内のシンボルクリックでジャンプ
function onTooltipSymbolClick(path: string, line: number): void {
    vscode.postMessage({
        type: 'openFile',
        path: path,
        line: line,
    });
}
```

---

## Phase 4: VSCode統合

### 4.1 新しいコマンド

```typescript
// package.json contributes.commands
{
    "command": "crd.showRelatedInGraph",
    "title": "Show Related Code in Graph",
    "category": "CRD"
},
{
    "command": "crd.zoomToCurrentFile",
    "title": "Zoom to Current File in Graph",
    "category": "CRD"
}
```

### 4.2 エディタイベント連携

```typescript
// src/extension.ts

// アクティブエディタ変更時
vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && graphPanel) {
        graphPanel.webview.postMessage({
            type: 'editorFileOpen',
            path: editor.document.uri.fsPath,
        });
    }
});

// カーソル位置変更時（デバウンス付き）
vscode.window.onDidChangeTextEditorSelection(
    debounce((event) => {
        if (graphPanel) {
            graphPanel.webview.postMessage({
                type: 'editorCursorChange',
                path: event.textEditor.document.uri.fsPath,
                line: event.selections[0].start.line,
            });
        }
    }, 300)
);
```

---

## Phase 5: HTMLエクスポート対応

### 5.1 スタンドアロンHTML

```typescript
// Cosmos.glをCDNから読み込むスタンドアロン版
const standaloneHtml = `
<!DOCTYPE html>
<html>
<head>
    <script src="https://unpkg.com/@cosmograph/cosmos@2.0.0/dist/cosmos.min.js"></script>
</head>
<body>
    <canvas id="graph"></canvas>
    <script src="graph-data.js"></script>
    <script>
        const graph = new cosmos.Graph(document.getElementById('graph'), config);
        graph.setData(GRAPH_DATA);
    </script>
</body>
</html>
`;
```

---

## 実装スケジュール

| Phase | 内容 | 工数目安 | 依存関係 |
|-------|------|----------|----------|
| **1** | 基盤構築（アダプター、レイアウト） | 4-6時間 | なし |
| **2** | Webviewコンポーネント | 6-8時間 | Phase 1 |
| **3** | 関係線機能（太さ、ツールチップ） | 2-3時間 | Phase 2 |
| **4** | VSCode統合（コマンド、連携） | 3-4時間 | Phase 3 |
| **5** | HTMLエクスポート対応 | 2-3時間 | Phase 4 |
| **6** | テスト・最適化 | 3-4時間 | Phase 5 |

**合計: 約20-28時間**

---

## マイルストーン

### v0.2.0 - Cosmos.gl基本実装
- [ ] Cosmos.glでの基本レンダリング
- [ ] 階層的レイアウト（ディレクトリ→ファイル→シンボル）
- [ ] 基本的なインタラクション

### v0.2.1 - ディレクトリフィルタ
- [ ] ディレクトリツリーUI
- [ ] チェックボックスによる表示切り替え
- [ ] フィルタ状態の永続化

### v0.2.2 - 関係線機能
- [ ] 太さによる関係数表現
- [ ] ツールチップによるシンボル詳細
- [ ] クリックでシンボル位置にジャンプ

### v0.2.3 - コード連携
- [ ] エディタ→グラフ連携（ファイル開く、カーソル移動）
- [ ] グラフ→エディタ連携（ノードクリック）
- [ ] 「関連コードを表示」コマンド

### v0.2.4 - エクスポート・最適化
- [ ] スタンドアロンHTMLエクスポート
- [ ] パフォーマンス最適化
- [ ] ドキュメント整備

---

## リスクと対策

| リスク | 影響 | 対策 |
|--------|------|------|
| Cosmos.glのAPI変更 | 中 | バージョン固定、抽象化レイヤー |
| WebGL非対応環境 | 低 | フォールバック（Cytoscape.js維持） |
| 大規模データのメモリ使用 | 高 | ストリーミング読み込み、LOD |
| 円パッキングの計算コスト | 中 | Web Worker、事前計算 |

---

## 次のアクション

1. **Phase 1開始**: `cosmosAdapter.ts`の作成
2. サンプルデータでCosmos.glの動作確認
3. 階層的レイアウトのプロトタイプ作成
