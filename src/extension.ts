import * as nls from 'vscode-nls';
import * as vscode from 'vscode';

import { GitExtension } from './git';
import { indexed, Emoji, WordTag } from './dataset';
import { normalizeWord } from './util';
import { current, sync } from './config';

const localize = nls.config()();

const _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT = 10;
const _SUGGESTION_PREVIEW_REFRESH_INTERVAL_MS = 250;

const [_VERB, _ACRONYM]: WordTag[] = ['verb', 'acronym'];
const _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_DEFAULT = 5;
const _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_BY_TAG = {
    [_VERB]: 10,
    [_ACRONYM]: 20,
};

const _SUGGESTION_PREVIEW_WEIGHT_SUB_WORD = 1;

export function activate(context: vscode.ExtensionContext) {
    sync();
    const disposables = [
        vscode.commands.registerCommand('vscode-git-emoji.suggest', () => suggest()),
        vscode.commands.registerCommand('vscode-git-emoji.list-emojis', () => listEmojis()),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('vscode-git-emoji')) {
                sync();
            }
        }),
    ];
    context.subscriptions.push(...disposables);
}

export function deactivate() { }

let _lastIncompleteMessage: string | undefined = undefined;

async function suggest() {
    const seed = _lastIncompleteMessage || readActiveTextEditorSelection() || readCommitMessageInputBox();
    const commitMessage = await readCommitMessage(seed);
    if (!commitMessage) {
        return;
    }

    _lastIncompleteMessage = commitMessage;

    const emojis = suggestEmojiForMessage(commitMessage);
    if (!emojis) {
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

    _lastIncompleteMessage = undefined;
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
    const MAX = _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT;
    return new Promise(resolve => {
        const box = vscode.window.createInputBox();
        const suggestOnValue = (value: string) => {
            const emojis = suggestEmojiForMessage(value);
            return emojis.length
                ? emojis.slice(0, MAX).map(x => x.s).join('') + (emojis.length <= MAX ? '' : ' ' + localize('plus_more_emojis', "+{0}", emojis.length - MAX))
                : '';
        };
        const intervalId = setInterval(() => {
            const value = box.value;
            if (!value) { return; };
            const newTitle = suggestOnValue(value);
            if (newTitle !== box.title) {
                box.title = newTitle;
            }
        }, _SUGGESTION_PREVIEW_REFRESH_INTERVAL_MS);
        const dispose = () => {
            clearInterval(intervalId);
            box.dispose();
        };
        let accepted = false;
        box.onDidAccept(e => {
            if (!box.value) {
                return;
            }
            accepted = true;
            const result = box.value;
            dispose();
            resolve(result);
        });
        box.onDidHide(e => {
            if (accepted) {
                return;
            }
            dispose();
            resolve(undefined);
        });
        box.ignoreFocusOut = true;
        if (seed) {
            box.value = seed;
            box.title = suggestOnValue(box.value);
        }
        box.show();
    });
}

function suggestEmojiForMessage(message: string): Emoji[] {
    const usage = new Map<Emoji, number>();
    const increment = (e: Emoji, value: number) => {
        if (!usage.has(e)) {
            usage.set(e, 0);
        }
        usage.set(e, value + usage.get(e)!);
    };

    // Whole-word matching
    const words = message.split(/\b(\w+)\b/g).map(x => x.trim()).filter(x => x.length > 0);
    for (const w of words) {
        const normalized = normalizeWord(w);
        const emojis = indexed().keyword2emoji.get(normalized)?.values() || [];

        let weight = 0;
        for (const t of indexed().keyword2tag.get(normalized) || []) {
            weight += _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_BY_TAG[t] || 0;
        }

        for (const e of emojis) {
            increment(e, weight || _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_DEFAULT);
        }
    }

    // Sub-word (i.e., any) matching
    const normalizedMessage = message.toLowerCase();
    for (const [keyword, emojis] of indexed().keyword2emoji.entries()) {
        if (-1 === normalizedMessage.indexOf(keyword)) { continue; }
        for (const e of emojis) { increment(e, _SUGGESTION_PREVIEW_WEIGHT_SUB_WORD); }
    }

    const entries = Array.from(usage.entries());
    entries.sort((a, b) => a[1] - b[1]);
    return entries.reverse().map(x => x[0]);
}

async function pickEmoji(suggestedEmojis: Emoji[], allowMultiple?: boolean): Promise<Emoji[] | undefined> {
    type Item = EmojiListItem & { isSelectMultiple?: true };
    const items: Item[] = [
        ...(!suggestedEmojis.length ? [] : [
            { label: localize('pick-emoji-suggested-emojis', "Suggested emojis"), kind: vscode.QuickPickItemKind.Separator },
            ...suggestedEmojis.map(x => ({ label: x.s, description: x.id, emoji: x })),
        ]),
        { label: localize('pick-emoji-other-emojis', "Other emojis"), kind: vscode.QuickPickItemKind.Separator },
        ...getEmojisListItems([]), /* Show all emojis, even the already suggested ones */
    ];
    if (!allowMultiple) {
        const selectMultiple: Item = {
            label: localize('select-multiple-emojis', "Select multiple emojis..."),
            isSelectMultiple: true,
        };
        const selected = await vscode.window.showQuickPick<Item>([selectMultiple, ...items], {
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
        });
        return !selected
            ? undefined
            : selected.isSelectMultiple ? await pickEmoji(suggestedEmojis, true) : [selected.emoji!];
    } else {
        const selected = await vscode.window.showQuickPick<Item>(items, {
            canPickMany: true,
            ignoreFocusOut: true,
            matchOnDescription: true,
            matchOnDetail: true,
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

type EmojiListItem = vscode.QuickPickItem & { emoji?: Emoji; };

function getEmojisListItems(except?: Emoji[]): EmojiListItem[] {
    const result = Array.from(indexed().emoji2keyword.entries()).filter(([e]) => !except?.includes(e)).map(([e, s]): EmojiListItem => ({
        label: e.s,
        description: `:${e.id}:`,
        detail: sortAndJoin(s.values(), '|'),
        emoji: e,
    }));
    result.sort((a, b) => a.emoji!.id.localeCompare(b.emoji!.id));
    return result;
}

async function pickEmojisList(allowMultiple?: boolean): Promise<undefined | Emoji[]> {
    type Item = EmojiListItem & { isSelectMultiple?: true };
    const items: Item[] = getEmojisListItems();

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