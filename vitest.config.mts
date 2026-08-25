import { defineConfig } from 'vitest/config';
import * as path from 'path';

export default defineConfig({
    test: {
        include: ['src/**/*.unit.test.ts'],
        environment: 'node',
    },
    resolve: {
        alias: {
            vscode: path.resolve(import.meta.dirname, 'src/test/mocks/vscode.ts'),
        },
    },
});
