/** @file モジュール指定子の解決の単体テスト */
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { ModuleResolver, ModuleResolverHost, parseJsonc } from './moduleResolver';

const WORKSPACE = path.resolve('/workspace');

/** メモリ上のファイルシステム (キーはワークスペース相対パス) */
const hostOf = (files: Record<string, string>): ModuleResolverHost => {
    const absolute = new Map(Object.entries(files).map(([file, content]) => [path.resolve(WORKSPACE, file), content]));
    return {
        fileExists: (file) => absolute.has(file),
        readFile: (file) => absolute.get(file),
    };
};
const native = (relative: string): string => relative.split('/').join(path.sep);

describe('ModuleResolver', () => {
    describe('相対指定', () => {
        const resolver = new ModuleResolver(WORKSPACE, hostOf({
            'src/a.ts': '',
            'src/lib/b.tsx': '',
            'src/lib/index.ts': '',
            'src/types.d.ts': '',
            'src/esm.ts': '',
            'src/data.json': '',
            'src/plain.js': '',
        }));

        it('拡張子を補って解決する', () => {
            expect(resolver.resolve('src/main.ts', './a')).toEqual({ resolvedPath: native('src/a.ts'), isExternal: false });
            expect(resolver.resolve('src/main.ts', './lib/b')).toEqual({ resolvedPath: native('src/lib/b.tsx'), isExternal: false });
            expect(resolver.resolve('src/main.ts', './types')).toEqual({ resolvedPath: native('src/types.d.ts'), isExternal: false });
            expect(resolver.resolve('src/main.ts', './plain')).toEqual({ resolvedPath: native('src/plain.js'), isExternal: false });
        });

        it('ディレクトリは index.* で解決する', () => {
            expect(resolver.resolve('src/main.ts', './lib')).toEqual({ resolvedPath: native('src/lib/index.ts'), isExternal: false });
            expect(resolver.resolve('src/lib/b.tsx', '.')).toEqual({ resolvedPath: native('src/lib/index.ts'), isExternal: false });
        });

        it('親ディレクトリを辿る', () => {
            expect(resolver.resolve('src/lib/b.tsx', '../a')).toEqual({ resolvedPath: native('src/a.ts'), isExternal: false });
        });

        it('ESM 形式の .js 指定をソースの .ts へ解決する', () => {
            expect(resolver.resolve('src/main.ts', './esm.js')).toEqual({ resolvedPath: native('src/esm.ts'), isExternal: false });
        });

        it('拡張子付きのファイルはそのまま解決する', () => {
            expect(resolver.resolve('src/main.ts', './data.json')).toEqual({ resolvedPath: native('src/data.json'), isExternal: false });
        });

        it('見つからない相対指定はプロジェクト内の未解決とする', () => {
            expect(resolver.resolve('src/main.ts', './missing')).toEqual({ resolvedPath: null, isExternal: false });
        });

        it('ワークスペース外へ出る指定はプロジェクト外とする', () => {
            const outside = new ModuleResolver(path.join(WORKSPACE, 'src'), hostOf({ 'shared/x.ts': '' }));
            expect(outside.resolve('main.ts', '../shared/x')).toEqual({ resolvedPath: null, isExternal: true });
        });
    });

    describe('非相対指定', () => {
        it('パッケージ名・組込みモジュールはプロジェクト外とする', () => {
            const resolver = new ModuleResolver(WORKSPACE, hostOf({ 'src/a.ts': '' }));
            expect(resolver.resolve('src/a.ts', 'vscode')).toEqual({ resolvedPath: null, isExternal: true });
            expect(resolver.resolve('src/a.ts', '@scope/pkg/sub')).toEqual({ resolvedPath: null, isExternal: true });
            expect(resolver.resolve('src/a.ts', 'node:fs')).toEqual({ resolvedPath: null, isExternal: true });
        });

        it('tsconfig の paths で写せる指定はプロジェクト内とする', () => {
            const resolver = new ModuleResolver(WORKSPACE, hostOf({
                'tsconfig.json': [
                    '{',
                    '    // コメントと末尾カンマを含む',
                    '    "compilerOptions": {',
                    '        "baseUrl": ".",',
                    '        "paths": { "@app/*": ["src/app/*"], "@core": ["src/core/index.ts"], },',
                    '    },',
                    '}',
                ].join('\n'),
                'src/app/view.ts': '',
                'src/core/index.ts': '',
                'src/util.ts': '',
            }));
            expect(resolver.resolve('src/main.ts', '@app/view')).toEqual({ resolvedPath: native('src/app/view.ts'), isExternal: false });
            expect(resolver.resolve('src/main.ts', '@core')).toEqual({ resolvedPath: native('src/core/index.ts'), isExternal: false });
            // baseUrl からの非相対指定
            expect(resolver.resolve('src/main.ts', 'src/util')).toEqual({ resolvedPath: native('src/util.ts'), isExternal: false });
            // 写せないものはプロジェクト外
            expect(resolver.resolve('src/main.ts', '@app/missing')).toEqual({ resolvedPath: null, isExternal: true });
        });

        it('baseUrl が無ければ paths は設定ファイルのディレクトリ基準で、extends を辿る', () => {
            const resolver = new ModuleResolver(WORKSPACE, hostOf({
                'config/base.json': '{ "compilerOptions": { "paths": { "~/*": ["../src/*"] } } }',
                'packages/web/tsconfig.json': '{ "extends": "../../config/base" }',
                'src/shared.ts': '',
            }));
            expect(resolver.resolve('packages/web/src/app.ts', '~/shared')).toEqual({ resolvedPath: native('src/shared.ts'), isExternal: false });
        });

        it('最寄りの設定ファイルを使う', () => {
            const resolver = new ModuleResolver(WORKSPACE, hostOf({
                'tsconfig.json': '{ "compilerOptions": { "paths": { "#x": ["src/root-x.ts"] } } }',
                'sub/jsconfig.json': '{ "compilerOptions": { "paths": { "#x": ["sub-x.js"] } } }',
                'src/root-x.ts': '',
                'sub/sub-x.js': '',
            }));
            expect(resolver.resolve('src/a.ts', '#x').resolvedPath).toBe(native('src/root-x.ts'));
            expect(resolver.resolve('sub/deep/b.js', '#x').resolvedPath).toBe(native('sub/sub-x.js'));
        });
    });

    describe('parseJsonc', () => {
        it('文字列中の // と /* はコメントとして扱わない', () => {
            expect(parseJsonc('{ "url": "https://example.com/*x*/", /* c */ "a": [1, 2,], }')).toEqual({ url: 'https://example.com/*x*/', a: [1, 2] });
        });

        it('壊れた JSON は null', () => {
            expect(parseJsonc('{ "a": ')).toBeNull();
        });
    });
});
