/** @file tree-sitter パーササービスの単体テスト */
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AST_LANGUAGES, AstParser, astLanguageOf } from './parser';
import { missingAstResources, resolveAstResources } from './resources';

// 資産は dist/ 配下に置かれる (vitest.config.mts の globalSetup が配置する)
// vitest はプロジェクトルートを作業ディレクトリとして実行される
const resources = resolveAstResources(path.resolve(process.cwd()));

describe('AstParser', () => {
    let parser: AstParser;

    beforeAll(async () => {
        expect(missingAstResources(resources)).toEqual([]);
        parser = await AstParser.create(resources);
    });

    afterAll(() => {
        parser?.dispose();
    });

    describe('対応言語', () => {
        it('TS/JS の language id を解決できる', () => {
            expect(astLanguageOf('typescript')?.grammar).toBe('typescript');
            expect(astLanguageOf('typescriptreact')?.grammar).toBe('tsx');
            expect(astLanguageOf('javascript')?.grammar).toBe('javascript');
            expect(astLanguageOf('javascriptreact')?.grammar).toBe('javascript');
        });

        it('未対応の language id は null を返す', () => {
            expect(astLanguageOf('rust')).toBeNull();
            expect(astLanguageOf('')).toBeNull();
        });

        it('未対応の language id ではパースせず null を返す', async () => {
            expect(parser.isSupported('rust')).toBe(false);
            expect(await parser.captures('rust', 'fn main() {}')).toBeNull();
        });
    });

    describe('パース', () => {
        it('TypeScript をエラー無しでパースできる', async () => {
            const source = [
                'import { Base } from "./base";',
                'export class Sample extends Base implements Marker {',
                '    private readonly _value: number = 0;',
                '    public run(target: Target): void {',
                '        const created = new Helper();',
                '        created.execute(this._value);',
                '    }',
                '}',
            ].join('\n');
            const hasError = await parser.withTree('typescript', source, root => root.hasError);
            expect(hasError).toBe(false);
        });

        it('TSX をエラー無しでパースできる', async () => {
            const source = 'const view = (props: Props) => <div className="x">{props.label}</div>;';
            const hasError = await parser.withTree('typescriptreact', source, root => root.hasError);
            expect(hasError).toBe(false);
        });

        it('JavaScript をエラー無しでパースできる', async () => {
            const source = 'const fs = require("fs");\nclass Sample extends Base { run() { return new Helper(); } }';
            const hasError = await parser.withTree('javascript', source, root => root.hasError);
            expect(hasError).toBe(false);
        });

        it('構文エラーを含むソースでも例外を投げない', async () => {
            const hasError = await parser.withTree('typescript', 'class {{{ ???', root => root.hasError);
            expect(hasError).toBe(true);
        });

        it('制御文字を含むソースは構文エラーになる（tree-sitter の既知の限界）', async () => {
            // TypeScript は受け付けるが tree-sitter は ERROR ノードにする
            const hasError = await parser.withTree('typescript', 'const key = `a\u0000b`;', root => root.hasError);
            expect(hasError).toBe(true);
        });

        it('空のソースをパースできる', async () => {
            const type = await parser.withTree('typescript', '', root => root.type);
            expect(type).toBe('program');
        });
    });

    describe('クエリ', () => {
        const source = [
            'import { Base } from "./base";',
            'import Default from "./default";',
            'import * as helpers from "./helpers";',
            'import "./side-effect";',
            'export class Sample extends Base implements Marker {',
            '    public run(target: Target): void {',
            '        const created = new Helper();',
            '        created.execute();',
            '        helpers.setup();',
            '        this.count = 1;',
            '    }',
            '}',
        ].join('\n');

        const capturesOf = async (name: string): Promise<string[]> => {
            const captures = await parser.captures('typescript', source);
            expect(captures).not.toBeNull();
            return (captures ?? []).filter(capture => capture.name === name).map(capture => capture.text);
        };

        it('定義を取り出せる', async () => {
            expect(await capturesOf('def.class')).toContain('Sample');
            expect(await capturesOf('def.method')).toContain('run');
        });

        it('import 束縛を取り出せる', async () => {
            expect(await capturesOf('imp.name')).toContain('Base');
            expect(await capturesOf('imp.default')).toContain('Default');
            expect(await capturesOf('imp.namespace')).toContain('helpers');
            expect(await capturesOf('imp.module.bare')).toContain('"./side-effect"');
        });

        it('参照の種類をキャプチャ名で判別できる', async () => {
            expect(await capturesOf('ref.inheritance')).toContain('Base');
            expect(await capturesOf('ref.implementation')).toContain('Marker');
            expect(await capturesOf('ref.instantiation')).toContain('Helper');
            expect(await capturesOf('ref.call')).toContain('execute');
            expect(await capturesOf('ref.type_reference')).toContain('Target');
            expect(await capturesOf('ref.write')).toContain('count');
            expect(await capturesOf('ref.read')).toContain('created');
        });

        it('this をレシーバとする書き込みを取り出せる', async () => {
            const captures = await parser.captures('typescript', source) ?? [];
            const write = captures.find(capture => capture.name === 'ref.write' && capture.text === 'count');
            expect(write).toBeDefined();
            const receiver = captures.find(capture => capture.matchIndex === write?.matchIndex && capture.name === 'ref.receiver');
            expect(receiver?.text).toBe('this');
        });

        it('レシーバと呼び出しが同じマッチに入る', async () => {
            const captures = await parser.captures('typescript', source) ?? [];
            const call = captures.find(capture => capture.name === 'ref.call' && capture.text === 'setup');
            expect(call).toBeDefined();
            const receiver = captures.find(capture => capture.matchIndex === call?.matchIndex && capture.name === 'ref.receiver');
            expect(receiver?.text).toBe('helpers');
        });

        it('キャプチャに 0 起点の位置が付く', async () => {
            const captures = await parser.captures('typescript', source) ?? [];
            const definition = captures.find(capture => capture.name === 'def.class');
            expect(definition?.startLine).toBe(4);
            expect(definition?.startCharacter).toBe(13);
            expect(definition?.endCharacter).toBe(19);
        });

        it('JavaScript のクエリも動く', async () => {
            const captures = await parser.captures('javascript', 'class A extends B { m() { new C(); } }') ?? [];
            const names = captures.map(capture => `${capture.name}:${capture.text}`);
            expect(names).toContain('def.class:A');
            expect(names).toContain('ref.inheritance:B');
            expect(names).toContain('ref.instantiation:C');
        });
    });

    describe('遅延ロード', () => {
        it('使った文法だけがロードされる', async () => {
            const lazy = await AstParser.create(resources);
            try {
                expect(lazy.loadedGrammars).toEqual([]);
                await lazy.captures('typescript', 'const a = 1;');
                expect(lazy.loadedGrammars).toEqual(['typescript']);
                await lazy.captures('javascript', 'const a = 1;');
                expect(lazy.loadedGrammars).toEqual(['javascript', 'typescript']);
                await lazy.captures('rust', 'fn main() {}');
                expect(lazy.loadedGrammars).toEqual(['javascript', 'typescript']);
            } finally {
                lazy.dispose();
            }
        });

        it('同じ文法を同時に要求しても1度しかロードしない', async () => {
            const shared = await AstParser.create(resources);
            try {
                await Promise.all([
                    shared.captures('typescript', 'const a = 1;'),
                    shared.captures('typescript', 'const b = 2;'),
                    shared.captures('typescriptreact', 'const c = 3;'),
                ]);
                expect(shared.loadedGrammars).toEqual(['tsx', 'typescript']);
            } finally {
                shared.dispose();
            }
        });

        it('破棄後のパースは例外になる', async () => {
            const disposed = await AstParser.create(resources);
            disposed.dispose();
            disposed.dispose();
            await expect(disposed.withTree('typescript', 'const a = 1;', root => root.type)).rejects.toThrow('disposed');
        });
    });

    describe('対応言語表', () => {
        it('全ての対応言語がパースできる', async () => {
            for (const language of AST_LANGUAGES) {
                const type = await parser.withTree(language.languageId, 'const a = 1;', root => root.type);
                expect(type, language.languageId).toBe('program');
            }
        });
    });
});
