/** @file ログ出力 */
import * as vscode from 'vscode';

export class Logs {
    private readonly _channel: vscode.LogOutputChannel;
    public constructor(channelName: string) {
        this._channel = vscode.window.createOutputChannel(channelName, { log: true });
    }

    public trace(message: string, ...args: any[]): void {
        console.trace(`[TRACE]: ${message}`, ...args);
        this._channel.error(message, ...args);
        vscode.window.showErrorMessage(message, ...args);
    }

    public error(message: string, ...args: any[]): void {
        console.error(`[ERROR]: ${message}`, ...args);
        this._channel.error(message, ...args);
        vscode.window.showErrorMessage(message, ...args);
    }

    public warn(message: string, ...args: any[]): void {
        console.warn(`[WARN]: ${message}`, ...args);
        this._channel.warn(message, ...args);
        vscode.window.showWarningMessage(message, ...args);
    }

    public info(message: string, ...args: any[]): void {
        console.info(`[INFO]: ${message}`, ...args);
        vscode.window.showInformationMessage(message, ...args);
        this._channel.info(message, ...args);
    }

    public log(message: string, ...args: any[]): void {
        console.log(`[LOG]: ${message}`, ...args);
        this._channel.info(message, ...args);
    }

    public debug(message: string, ...args: any[]): void {
        console.debug(`[DEBUG]: ${message}`, ...args);
    }
}