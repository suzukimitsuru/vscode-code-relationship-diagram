/** @file 各国語サポート nls: National Language Support */
import * as vscode from 'vscode';

import localeEn from '../package.nls.json';
import localeJa from '../package.nls.ja.json';
export type LocaleKeyType = keyof typeof localeEn;
interface LocaleEntry { [key : string] : string; }
const localeTableKey = vscode.env.language;
const localeTable = Object.assign(localeEn, ((<{[key : string] : LocaleEntry}>{
    ja : localeJa
})[localeTableKey] || { }));
const localeString = (key : string) : string => localeTable[key] || key;
export const localeMap = (key : LocaleKeyType) : string => localeString(key);
export default localeMap;
