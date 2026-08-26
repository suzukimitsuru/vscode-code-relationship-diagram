/** @file 単体テスト前に AST 資産(WASM / クエリ)を dist へ配置する */
import { copyAstAssets } from '../../../scripts/ast-assets.mjs';

export default function setup() {
    copyAstAssets();
}
