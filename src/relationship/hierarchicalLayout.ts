/**
 * Hierarchical Layout Calculator
 *
 * ディレクトリ→ファイル→シンボルの階層構造を
 * 円パッキングとフォースレイアウトで配置する
 */

import { CosmosNode, CosmosLink, CosmosData } from './cosmosAdapter';

/**
 * レイアウト設定
 */
export interface LayoutConfig {
    /** キャンバス幅 */
    width: number;
    /** キャンバス高さ */
    height: number;
    /** ディレクトリ間の最小距離 */
    directorySpacing: number;
    /** ファイル間の最小距離 */
    fileSpacing: number;
    /** シンボル間の最小距離 */
    symbolSpacing: number;
    /** 中心からの重力 */
    gravity: number;
}

const DEFAULT_CONFIG: LayoutConfig = {
    width: 2000,
    height: 2000,
    directorySpacing: 100,
    fileSpacing: 30,
    symbolSpacing: 10,
    gravity: 0.1,
};

/**
 * 円パッキングノード
 */
interface PackNode {
    id: string;
    x: number;
    y: number;
    r: number;  // 半径
    children?: PackNode[];
}

/**
 * 階層的レイアウトを計算
 */
export function calculateHierarchicalLayout(
    data: CosmosData,
    config: Partial<LayoutConfig> = {}
): void {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const { nodes } = data;

    // 1. ノードを階層ごとに分類
    const directories = nodes.filter(n => n.level === 'directory');
    const files = nodes.filter(n => n.level === 'file');
    const symbols = nodes.filter(n => n.level === 'symbol');

    // 2. ディレクトリの階層構造を構築
    const rootDirectories = directories.filter(d => d.parentId === null);
    const directoryHierarchy = buildHierarchy(directories);

    // 3. ディレクトリを円パッキングで配置
    layoutDirectories(rootDirectories, directoryHierarchy, files, cfg);

    // 4. 各ディレクトリ内のファイルを円パッキングで配置
    for (const dir of directories) {
        const dirFiles = files.filter(f => f.parentId === dir.id);
        if (dirFiles.length > 0) {
            packNodesInCircle(dirFiles, dir.x, dir.y, dir.size * 2, cfg.fileSpacing);
        }
    }

    // 5. 各ファイル内のシンボルを円パッキングで配置
    for (const file of files) {
        const fileSymbols = symbols.filter(s => s.parentId === file.id);
        if (fileSymbols.length > 0) {
            packNodesInCircle(fileSymbols, file.x, file.y, file.size, cfg.symbolSpacing);
        }
    }

    // 6. 親を持たないシンボル（トップレベルシンボル）を親ファイルの周囲に配置
    const orphanSymbols = symbols.filter(s => {
        const parent = nodes.find(n => n.id === s.parentId);
        return parent?.level === 'file';
    });

    for (const symbol of orphanSymbols) {
        const parentFile = files.find(f => f.id === symbol.parentId);
        if (parentFile) {
            const siblings = symbols.filter(s => s.parentId === symbol.parentId);
            const index = siblings.indexOf(symbol);
            const total = siblings.length;
            const angle = (2 * Math.PI * index) / total;
            const radius = parentFile.size * 0.7;
            symbol.x = parentFile.x + Math.cos(angle) * radius;
            symbol.y = parentFile.y + Math.sin(angle) * radius;
        }
    }
}

/**
 * 階層構造を構築
 */
function buildHierarchy(nodes: CosmosNode[]): Map<string, CosmosNode[]> {
    const hierarchy = new Map<string, CosmosNode[]>();

    for (const node of nodes) {
        if (node.parentId) {
            if (!hierarchy.has(node.parentId)) {
                hierarchy.set(node.parentId, []);
            }
            hierarchy.get(node.parentId)!.push(node);
        }
    }

    return hierarchy;
}

/**
 * ディレクトリをレイアウト
 */
function layoutDirectories(
    rootDirs: CosmosNode[],
    hierarchy: Map<string, CosmosNode[]>,
    files: CosmosNode[],
    config: LayoutConfig
): void {
    const centerX = config.width / 2;
    const centerY = config.height / 2;

    // ルートディレクトリのサイズを計算（含むファイル数に基づく）
    for (const dir of rootDirs) {
        const fileCount = countFilesRecursive(dir.id, hierarchy, files);
        dir.size = Math.max(30, Math.sqrt(fileCount) * 20);
    }

    // ルートディレクトリを円周上に配置
    if (rootDirs.length === 1) {
        rootDirs[0].x = centerX;
        rootDirs[0].y = centerY;
    } else {
        const radius = Math.max(200, rootDirs.length * 50);
        for (let i = 0; i < rootDirs.length; i++) {
            const angle = (2 * Math.PI * i) / rootDirs.length - Math.PI / 2;
            rootDirs[i].x = centerX + Math.cos(angle) * radius;
            rootDirs[i].y = centerY + Math.sin(angle) * radius;
        }
    }

    // 子ディレクトリを再帰的に配置
    for (const rootDir of rootDirs) {
        layoutChildDirectories(rootDir, hierarchy, files, config);
    }
}

/**
 * 子ディレクトリを再帰的に配置
 */
function layoutChildDirectories(
    parent: CosmosNode,
    hierarchy: Map<string, CosmosNode[]>,
    files: CosmosNode[],
    config: LayoutConfig
): void {
    const children = hierarchy.get(parent.id) || [];

    if (children.length === 0) {
        return;
    }

    // 子ディレクトリのサイズを計算
    for (const child of children) {
        const fileCount = countFilesRecursive(child.id, hierarchy, files);
        child.size = Math.max(20, Math.sqrt(fileCount) * 15);
    }

    // 親の周囲に子を配置
    const totalChildSize = children.reduce((sum, c) => sum + c.size, 0);
    const baseRadius = parent.size + totalChildSize / (2 * Math.PI) + config.directorySpacing;

    let currentAngle = -Math.PI / 2;
    for (const child of children) {
        const arcLength = child.size * 2;
        const angleIncrement = arcLength / baseRadius;

        child.x = parent.x + Math.cos(currentAngle + angleIncrement / 2) * baseRadius;
        child.y = parent.y + Math.sin(currentAngle + angleIncrement / 2) * baseRadius;

        currentAngle += angleIncrement;

        // 再帰的に孫ディレクトリを配置
        layoutChildDirectories(child, hierarchy, files, config);
    }
}

/**
 * ディレクトリ配下のファイル数を再帰的にカウント
 */
function countFilesRecursive(
    dirId: string,
    hierarchy: Map<string, CosmosNode[]>,
    files: CosmosNode[]
): number {
    // 直接の子ファイル数
    let count = files.filter(f => f.parentId === dirId).length;

    // 子ディレクトリのファイル数を加算
    const children = hierarchy.get(dirId) || [];
    for (const child of children) {
        count += countFilesRecursive(child.id, hierarchy, files);
    }

    return count;
}

/**
 * ノードを円内にパッキング配置
 *
 * シンプルな円パッキングアルゴリズム：
 * - 中心から外側に向かって螺旋状に配置
 * - 衝突を避けながら詰め込む
 */
function packNodesInCircle(
    nodes: CosmosNode[],
    centerX: number,
    centerY: number,
    containerRadius: number,
    spacing: number
): void {
    if (nodes.length === 0) {return;}

    if (nodes.length === 1) {
        nodes[0].x = centerX;
        nodes[0].y = centerY;
        return;
    }

    // ノードサイズでソート（大きい順）
    const sortedNodes = [...nodes].sort((a, b) => b.size - a.size);

    // 配置済みノード
    const placed: Array<{ x: number, y: number, r: number }> = [];

    for (const node of sortedNodes) {
        const nodeRadius = node.size / 2 + spacing;

        if (placed.length === 0) {
            // 最初のノードは中心に配置
            node.x = centerX;
            node.y = centerY;
            placed.push({ x: centerX, y: centerY, r: nodeRadius });
            continue;
        }

        // 配置可能な位置を探索
        let bestPos = findPackingPosition(
            placed,
            nodeRadius,
            centerX,
            centerY,
            containerRadius
        );

        node.x = bestPos.x;
        node.y = bestPos.y;
        placed.push({ x: bestPos.x, y: bestPos.y, r: nodeRadius });
    }
}

/**
 * パッキング位置を探索
 */
function findPackingPosition(
    placed: Array<{ x: number, y: number, r: number }>,
    radius: number,
    centerX: number,
    centerY: number,
    containerRadius: number
): { x: number, y: number } {
    // 螺旋状に探索
    const spiralStep = radius * 0.5;
    let angle = 0;
    let distance = radius;

    for (let i = 0; i < 1000; i++) {
        const x = centerX + Math.cos(angle) * distance;
        const y = centerY + Math.sin(angle) * distance;

        // コンテナ内に収まるか確認
        const distFromCenter = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2);
        if (distFromCenter + radius > containerRadius) {
            angle += 0.5;
            distance += spiralStep * 0.1;
            continue;
        }

        // 他のノードと衝突しないか確認
        let collision = false;
        for (const p of placed) {
            const dist = Math.sqrt((x - p.x) ** 2 + (y - p.y) ** 2);
            if (dist < radius + p.r) {
                collision = true;
                break;
            }
        }

        if (!collision) {
            return { x, y };
        }

        angle += 0.3;
        if (angle > Math.PI * 2) {
            angle = 0;
            distance += spiralStep;
        }
    }

    // 見つからない場合は中心付近に配置
    return {
        x: centerX + (Math.random() - 0.5) * containerRadius * 0.5,
        y: centerY + (Math.random() - 0.5) * containerRadius * 0.5,
    };
}

/**
 * フォースシミュレーションで位置を調整
 *
 * Cosmos.glのGPUフォースシミュレーションを使用する前の
 * 初期位置として使用
 */
export function applyForceLayout(
    data: CosmosData,
    iterations: number = 100,
    config: Partial<LayoutConfig> = {}
): void {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const { nodes, links } = data;

    for (let iter = 0; iter < iterations; iter++) {
        // 斥力（ノード間）
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const dx = nodes[j].x - nodes[i].x;
                const dy = nodes[j].y - nodes[i].y;
                const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                const minDist = (nodes[i].size + nodes[j].size) / 2 + 10;

                if (dist < minDist) {
                    const force = (minDist - dist) / dist * 0.5;
                    const fx = dx * force;
                    const fy = dy * force;

                    nodes[i].x -= fx;
                    nodes[i].y -= fy;
                    nodes[j].x += fx;
                    nodes[j].y += fy;
                }
            }
        }

        // 引力（リンク）
        for (const link of links) {
            const source = nodes[link.source];
            const target = nodes[link.target];

            const dx = target.x - source.x;
            const dy = target.y - source.y;
            const dist = Math.sqrt(dx * dx + dy * dy) || 1;
            const idealDist = (source.size + target.size) / 2 + 50;

            const force = (dist - idealDist) / dist * 0.1;
            const fx = dx * force;
            const fy = dy * force;

            source.x += fx;
            source.y += fy;
            target.x -= fx;
            target.y -= fy;
        }

        // 重力（中心への引力）
        const centerX = cfg.width / 2;
        const centerY = cfg.height / 2;

        for (const node of nodes) {
            const dx = centerX - node.x;
            const dy = centerY - node.y;

            node.x += dx * cfg.gravity * 0.01;
            node.y += dy * cfg.gravity * 0.01;
        }
    }
}

/**
 * 特定のディレクトリとその内容のみを表示するようにフィルタ
 */
export function filterByDirectory(
    data: CosmosData,
    visibleDirectories: Set<string>
): void {
    for (const node of data.nodes) {
        if (node.level === 'directory') {
            node.visible = visibleDirectories.has(node.path);
        } else if (node.level === 'file') {
            const dirPath = node.path.substring(0, node.path.lastIndexOf('/'));
            node.visible = visibleDirectories.has(dirPath);
        } else {
            // シンボルは親ファイルの可視性に従う
            const parentFile = data.nodes.find(n => n.id === node.parentId);
            node.visible = parentFile?.visible ?? false;
        }
    }
}

/**
 * ノードIDから関連ノードを取得（ズーム対象の計算用）
 */
export function getRelatedNodes(
    data: CosmosData,
    nodeId: string,
    depth: number = 1
): string[] {
    const related = new Set<string>([nodeId]);

    for (let d = 0; d < depth; d++) {
        const currentRelated = new Set(related);

        for (const link of data.links) {
            const sourceNode = data.nodes[link.source];
            const targetNode = data.nodes[link.target];

            if (currentRelated.has(sourceNode.id)) {
                related.add(targetNode.id);
            }
            if (currentRelated.has(targetNode.id)) {
                related.add(sourceNode.id);
            }
        }
    }

    return Array.from(related);
}

/**
 * バウンディングボックスを計算（ズーム範囲の計算用）
 */
export function calculateBoundingBox(
    nodes: CosmosNode[]
): { minX: number, minY: number, maxX: number, maxY: number } {
    if (nodes.length === 0) {
        return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    }

    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const node of nodes) {
        const r = node.size / 2;
        minX = Math.min(minX, node.x - r);
        minY = Math.min(minY, node.y - r);
        maxX = Math.max(maxX, node.x + r);
        maxY = Math.max(maxY, node.y + r);
    }

    return { minX, minY, maxX, maxY };
}
