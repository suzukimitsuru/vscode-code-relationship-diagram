import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = path.dirname(fileURLToPath(import.meta.url));

export default {
    files: path.join(base, 'test', 'lsp-parallel.test.js'),
    version: '1.105.0',
    workspaceFolder: path.join(base, 'fixture'),
    mocha: { ui: 'tdd', timeout: 120000 },
};
