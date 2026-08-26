import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    test: {
        include: ['src/**/*.unit.test.ts'],
        environment: 'node',
        // AST パーサのテストは dist/wasm と dist/queries を読むため、先に配置する
        globalSetup: ['src/test/setup/astAssets.mjs'],
    },
    resolve: {
        alias: {
            vscode: path.resolve(import.meta.dirname, 'src/test/mocks/vscode.ts'),
        },
    },
});
