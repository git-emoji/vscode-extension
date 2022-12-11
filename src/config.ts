import * as vscode from 'vscode';

export interface Config {
    contextualDataVersion: 'v1' | 'v2';
}

function load() {
    const c = vscode.workspace.getConfiguration('vscode-git-emoji');
    return {
        contextualDataVersion: c.get<'v1' | 'v2'>('contextualDataVersion', 'v2')
    };
}

let _current: Config;

export function sync() {
    _current = load();
}

export function current(): Config {
    if (!_current) {
        sync();
    }
    return _current!;
}
