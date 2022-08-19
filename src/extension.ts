import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import * as dataset from '@git-emoji/dataset-js';
import { GitExtension } from './git';

const localize = nls.config()();

const _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT = 10;

export function activate(context: vscode.ExtensionContext) {
    const disposables = [
        vscode.commands.registerCommand('vscode-git-emoji.suggest', () => suggest()),
        vscode.commands.registerCommand('vscode-git-emoji.list-emojis', () => listEmojis()),
    ];
    context.subscriptions.push(...disposables);
}

export function deactivate() { }

type Emoji = (typeof dataset.emoji)['_1234'];

interface IndexedDataset {
    keyword2emoji: Map<string, Set<Emoji>>;
    emoji2keyword: Map<Emoji, Set<string>>;
}

let _indexed: IndexedDataset | undefined = undefined;

function indexed() {
    return _indexed || (_indexed = makeIndexed());
}

function makeIndexed(): IndexedDataset {
    const keyword2emoji = new Map<string, Set<Emoji>>();
    const emoji2keyword = new Map<Emoji, Set<string>>();

    for (const key of Object.keys(dataset.emoji)) {
        const emoji = dataset.emoji[key as keyof typeof dataset.emoji];
        emoji2keyword.set(emoji, new Set<string>());
    }

    for (const ctx of dataset.context) {
        for (const keyword of ctx.keyword) {
            const normalized = normalizeWord(keyword);
            if (!keyword2emoji.has(normalized)) {
                keyword2emoji.set(normalized, new Set<Emoji>());
            }
            const s = keyword2emoji.get(normalized)!;
            for (const emoji of ctx.emoji) {
                s.add(emoji);
            }
        }
        for (const emoji of ctx.emoji) {
            const s = emoji2keyword.get(emoji)!;
            for (const keyword of ctx.keyword) {
                s.add(normalizeWord(keyword));
            }
        }
    }

    for (const key of Object.keys(dataset.emoji)) {
        const emoji = dataset.emoji[key as keyof typeof dataset.emoji];
        const normalized = normalizeWord(emoji.id);
        emoji2keyword.get(emoji)!.add(normalized);
        if (!keyword2emoji.has(normalized)) {
            keyword2emoji.set(normalized, new Set());
        }
        keyword2emoji.get(normalized)!.add(emoji);
    }

    return { keyword2emoji, emoji2keyword };
}

function normalizeWord(word: string) {
    return word.trim().toLowerCase();
}

async function suggest() {
    const seed = readActiveTextEditorSelection() || readCommitMessageInputBox();
    const commitMessage = await readCommitMessage(seed);
    if (!commitMessage) {
        return;
    }

    const emojis = suggestEmojiForMessage(commitMessage);
    if (!emojis.length) {
        vscode.window.showErrorMessage(localize('no-suggestion', 'No suggestion found'));
        return;
    }

    const selected = await pickEmoji(emojis);
    if (!selected || !selected.length) {
        vscode.window.showErrorMessage(localize('no-emoji-selected', 'No emoji selected'));
        return;
    }

    const combined = await pickConcatStyle(selected, commitMessage);
    if (!combined) {
        return;
    }

    const action = await pickEmitAction();
    if (!action) {
        return;
    }

    await emit(action, combined);
}

async function emit(action: EmitAction, value: string) {
    switch (action) {
        case 'type-in-terminal':
            emitToTerminal(value);
            break;
        case 'type-in-git-input-box':
            emitToCommitMessageInputBox(value);
            break;
        case 'type-in-new-document':
            await emitToNewDocument(value);
            break;
        case 'copy':
        default:
            emitToClipboard(value);
            break;
    }
}

function readActiveTextEditorSelection(): string | undefined {
    const ate = vscode.window.activeTextEditor;
    return ate?.selection ? ate.document.getText(ate.selection) : undefined;
}

function readCommitMessageInputBox(): string | undefined {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
    if (!gitExtension) {
        return;
    }
    const git = gitExtension.getAPI(1);
    for (const repo of git.repositories) {
        if (repo.inputBox.value) {
            return repo.inputBox.value;
        }
    }
}

function emitToCommitMessageInputBox(text: string) {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
    if (!gitExtension) {
        return;
    }
    const git = gitExtension.getAPI(1);
    if (git.repositories.length) {
        git.repositories[0].inputBox.value = text;
    }
}

async function readCommitMessage(seed?: string): Promise<string | undefined> {
    return new Promise(resolve => {
        const box = vscode.window.createInputBox();
        const suggestOnValue = (value: string) => {
            const emojis = suggestEmojiForMessage(value);
            if (!emojis.length) {
                box.title = '';
                return;
            }
            box.title = emojis.slice(0, _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT).map(x => x.s).join('')
                + (emojis.length <= _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT ? '' : ' ' + localize('plus_more_emojis', "+{0}", emojis.length - _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT));
        };
        box.onDidChangeValue(e => suggestOnValue(e));
        box.onDidAccept(e => {
            if (!box.value) {
                return;
            }
            const result = box.value;
            box.dispose();
            resolve(result);
        });
        box.onDidHide(e => {
            if (box.value) {
                return;
            }
            box.dispose();
            resolve(undefined);
        });
        box.ignoreFocusOut = true;
        if (seed) {
            box.value = seed;
            suggestOnValue(box.value);
        }
        box.show();
    });
}

function suggestEmojiForMessage(message: string): Emoji[] {
    const words = message.split(/\b(\w+)\b/g).map(x => x.trim()).filter(x => x.length > 0);
    const usage = new Map<Emoji, number>();
    for (const w of words) {
        const normalized = normalizeWord(w);
        const emojis = indexed().keyword2emoji.get(normalized)?.values() || [];
        for (const e of emojis) {
            if (usage.has(e)) {
                usage.set(e, 1 + usage.get(e)!);
            } else {
                usage.set(e, 1);
            }
        }
    }
    const entries = Array.from(usage.entries());
    entries.sort((a, b) => a[1] - b[1]);
    return entries.reverse().map(x => x[0]);
}

async function pickEmoji(emojis: Emoji[], allowMultiple?: boolean): Promise<Emoji[] | undefined> {
    type Item = vscode.QuickPickItem & { emoji?: Emoji; isSelectMultiple?: true };
    const items: Item[] = emojis.map(x => ({ label: x.s, description: x.id, emoji: x }));
    if (!allowMultiple) {
        const selectMultiple: Item = {
            label: localize('select-multiple-emojis', "Select multiple emojis..."),
            isSelectMultiple: true,
        };
        const selected = await vscode.window.showQuickPick<Item>([selectMultiple, ...items], {
            ignoreFocusOut: true,
        });
        return !selected
            ? undefined
            : selected.isSelectMultiple ? await pickEmoji(emojis, true) : [selected.emoji!];
    } else {
        const selected = await vscode.window.showQuickPick<Item>(items, {
            canPickMany: true,
            ignoreFocusOut: true,
        });
        return selected?.map(x => x.emoji!);
    }
}

async function pickConcatStyle(emojis: Emoji[], message: string): Promise<string | undefined> {
    if (!emojis.length) {
        return message;
    }

    const seq = concatEmojis(emojis);
    return (await vscode.window.showQuickPick(
        [
            {
                label: localize('concat-style-emoji-message', "Emoji first"),
                detail: `${seq} ${message}`
            },
            {
                label: localize('concat-style-emoji-message', "Message first"),
                detail: `${message} ${seq}`
            },
            {
                label: localize('concat-style-emoji-message-emoji', "Sandwich"),
                detail: `${seq} ${message} ${seq}`
            },
        ],
        {
            title: localize('select-style', "Concatenation style"),
            ignoreFocusOut: true,
        }
    ))?.detail;
}

type EmitAction = 'copy' | 'type-in-terminal' | 'type-in-git-input-box' | 'type-in-new-document';

function concatEmojis(emojis: Emoji[]) {
    return emojis.map(x => x.s).join('');
}

async function pickEmitAction(): Promise<undefined | EmitAction> {
    type Item = vscode.QuickPickItem & { action: EmitAction };
    return (await vscode.window.showQuickPick<Item>(
        [
            {
                label: localize('pick-emit-action-copy', "Copy"),
                action: 'copy',
            },
            {
                label: localize('pick-emit-action-type-in-terminal', "Type in terminal"),
                action: 'type-in-terminal',
            },
            {
                label: localize('pick-emit-action-type-in-git-input-box', "Type in Git commit message input box"),
                action: 'type-in-git-input-box',
            },
            {
                label: localize('pick-emit-action-type-in-new-document', "Type in new document"),
                action: 'type-in-new-document',
            },
        ],
        {
            ignoreFocusOut: true,
            title: localize('pick-emit-action-title', "Emit commit message"),
        }
    ))?.action;
}

function emitToTerminal(text: string) {
    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal();
    terminal.sendText(text, false);
    terminal.show();
}

async function emitToNewDocument(text: string) {
    await vscode.workspace.openTextDocument({ content: text });
}

function emitToClipboard(text: string) {
    vscode.env.clipboard.writeText(text);
    vscode.window.showInformationMessage(localize('emit-to-clipboard-done', 'Copied: {0}', text));
}

async function listEmojis() {
    const emojis = await pickEmojisList();
    if (!emojis || !emojis.length) {
        return;
    }

    const action = await pickEmitAction();
    if (!action) {
        return;
    }

    const seq = concatEmojis(emojis);
    await emit(action, seq);
}

async function pickEmojisList(allowMultiple?: boolean): Promise<undefined | Emoji[]> {
    type Item = vscode.QuickPickItem & { emoji?: Emoji; isSelectMultiple?: true };
    const items = Array.from(indexed().emoji2keyword.entries()).map(([e, s]): Item => ({
        label: e.s,
        description: e.id,
        detail: sortAndJoin(s.values(), '|'),
        emoji: e,
    }));
    items.sort((a, b) => a.emoji!.id.localeCompare(b.emoji!.id));

    if (!allowMultiple) {
        const selectMultiple: Item = {
            label: localize('select-multiple-emojis', "Select multiple emojis..."),
            isSelectMultiple: true,
        };
        const selected = await vscode.window.showQuickPick([selectMultiple, ...items], {
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return !selected
            ? undefined
            : selected.isSelectMultiple ? await pickEmojisList(true) : [selected.emoji!];
    } else {
        const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return selected?.map(x => x.emoji!);
    }
}

function sortAndJoin(values: string[] | Iterable<string>, separator?: string) {
    const v = Array.from(values);
    v.sort();
    return v.join(separator);
}