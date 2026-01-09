/** @file ログ出力 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class Logs {
    private readonly _channel: vscode.LogOutputChannel;
    private _logFilePath: string | null = null;
    private _logFileStream: fs.WriteStream | null = null;

    public constructor(channelName: string) {
        this._channel = vscode.window.createOutputChannel(channelName, { log: true });
    }

    /**
     * ログファイルのパスを設定し、既存のファイルをクリアする
     * @param filePath ログファイルのパス
     */
    public setLogFile(filePath: string): void {
        // 既存のストリームを閉じる
        if (this._logFileStream) {
            this._logFileStream.end();
            this._logFileStream = null;
        }

        this._logFilePath = filePath;

        // ディレクトリが存在しない場合は作成
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // ファイルをクリア（空のファイルを作成）
        fs.writeFileSync(filePath, '', 'utf8');

        // 新しいストリームを作成（追記モード）
        this._logFileStream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    }

    /**
     * ログファイルへの書き込みを終了する
     */
    public closeLogFile(): void {
        if (this._logFileStream) {
            this._logFileStream.end();
            this._logFileStream = null;
        }
        this._logFilePath = null;
    }

    /**
     * ファイルにログメッセージを書き込む
     * @param level ログレベル
     * @param message メッセージ
     * @param args 追加の引数
     */
    private writeToFile(level: string, message: string, ...args: any[]): void {
        if (this._logFileStream && this._logFilePath) {
            const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 23);
            const formattedArgs = args.length > 0 ? ' ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ') : '';
            const logLine = `${timestamp} [${level}] ${message}${formattedArgs}\n`;
            this._logFileStream.write(logLine);
        }
    }

    public trace(message: string, ...args: any[]): void {
        console.trace(`[TRACE]: ${message}`, ...args);
        this._channel.error(message, ...args);
        vscode.window.showErrorMessage(message, ...args);
        this.writeToFile('trace', message, ...args);
    }

    public error(message: string, ...args: any[]): void {
        console.error(`[ERROR]: ${message}`, ...args);
        this._channel.error(message, ...args);
        vscode.window.showErrorMessage(message, ...args);
        this.writeToFile('error', message, ...args);
    }

    public warn(message: string, ...args: any[]): void {
        console.warn(`[WARN]: ${message}`, ...args);
        this._channel.warn(message, ...args);
        vscode.window.showWarningMessage(message, ...args);
        this.writeToFile('warn', message, ...args);
    }

    public info(message: string, ...args: any[]): void {
        console.info(`[INFO]: ${message}`, ...args);
        vscode.window.showInformationMessage(message, ...args);
        this._channel.info(message, ...args);
        this.writeToFile('info', message, ...args);
    }

    public log(message: string, ...args: any[]): void {
        console.log(`[LOG]: ${message}`, ...args);
        this._channel.info(message, ...args);
        this.writeToFile('info', message, ...args);
    }

    public debug(message: string, ...args: any[]): void {
        console.debug(`[DEBUG]: ${message}`, ...args);
        this.writeToFile('debug', message, ...args);
    }
}