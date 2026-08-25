import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as childProcess from 'child_process';

vi.mock('fs');
vi.mock('child_process');

import { autoSignBinary, autoSignDirectory } from './bindingsAutoSign';

const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform });
}

describe('bindingsAutoSign', () => {
    afterEach(() => {
        setPlatform(originalPlatform);
        vi.restoreAllMocks();
    });

    describe('autoSignBinary', () => {
        it('macOS以外では何もせずtrueを返す', () => {
            setPlatform('linux');
            const execSpy = vi.spyOn(childProcess, 'execSync');
            expect(autoSignBinary('/tmp/dummy.node')).toBe(true);
            expect(execSpy).not.toHaveBeenCalled();
        });

        it('macOSでバイナリが存在せず署名不要の場合はtrueを返しexecSyncを呼ばない', () => {
            setPlatform('darwin');
            vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            const execSpy = vi.spyOn(childProcess, 'execSync');
            expect(autoSignBinary('/tmp/dummy.node')).toBe(true);
            expect(execSpy).not.toHaveBeenCalled();
        });

        it('macOSで署名済みかつ検疫属性が無い場合は署名不要でtrueを返す', () => {
            setPlatform('darwin');
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(childProcess, 'execSync').mockImplementation((cmd: string) => {
                if (typeof cmd === 'string' && cmd.startsWith('codesign -v')) { return Buffer.from(''); }
                if (typeof cmd === 'string' && cmd.startsWith('xattr')) { return ''; }
                return Buffer.from('');
            });
            expect(autoSignBinary('/tmp/dummy.node')).toBe(true);
        });

        it('macOSで検疫属性がある場合は署名処理を実行する', () => {
            setPlatform('darwin');
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            const calls: string[] = [];
            vi.spyOn(childProcess, 'execSync').mockImplementation((cmd: string) => {
                calls.push(cmd);
                if (cmd.startsWith('codesign -v') && !calls.some(c => c.startsWith('codesign -s'))) {
                    // 初回のverifyは「検疫あり」を示すためxattrで判定させる
                    return Buffer.from('');
                }
                if (cmd.startsWith('xattr "')) { return 'com.apple.quarantine\n'; }
                return Buffer.from('');
            });
            const result = autoSignBinary('/tmp/dummy.node');
            expect(result).toBe(true);
            expect(calls.some(c => c.startsWith('xattr -d com.apple.quarantine'))).toBe(true);
            expect(calls.some(c => c.startsWith('codesign -s -'))).toBe(true);
        });

        it('署名コマンドが失敗した場合はfalseを返す', () => {
            setPlatform('darwin');
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(childProcess, 'execSync').mockImplementation((cmd: string) => {
                if (cmd.startsWith('xattr "')) { return 'com.apple.quarantine\n'; }
                if (cmd.startsWith('codesign -s -')) { throw new Error('sign failed'); }
                if (cmd.startsWith('codesign -v')) { return Buffer.from(''); }
                return Buffer.from('');
            });
            expect(autoSignBinary('/tmp/dummy.node')).toBe(false);
        });
    });

    describe('autoSignDirectory', () => {
        it('macOS以外では0を返す', () => {
            setPlatform('linux');
            expect(autoSignDirectory('/tmp/bindings')).toBe(0);
        });

        it('ディレクトリが存在しない場合は0を返す', () => {
            setPlatform('darwin');
            vi.spyOn(fs, 'existsSync').mockReturnValue(false);
            expect(autoSignDirectory('/tmp/bindings')).toBe(0);
        });

        it('.nodeファイルのみを対象に署名し、件数を返す', () => {
            setPlatform('darwin');
            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs, 'readdirSync').mockReturnValue(['a.node', 'b.txt', 'c.node'] as any);
            vi.spyOn(fs, 'statSync').mockReturnValue({ isFile: () => true } as fs.Stats);
            vi.spyOn(childProcess, 'execSync').mockImplementation((cmd: string) => {
                if (cmd.startsWith('xattr "')) { return ''; }
                return Buffer.from('');
            });
            expect(autoSignDirectory('/tmp/bindings')).toBe(2);
        });
    });
});
