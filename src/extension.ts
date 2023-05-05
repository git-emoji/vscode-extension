import * as nls from 'vscode-nls';
import * as vscode from 'vscode';

import { GitExtension } from './git';
import { indexedV1, indexedV2, Emoji, WordTag } from './dataset';
import { getFirstWhitespaceAfterFirstWord, normalizeWord } from './util';
import { current, sync } from './config';

const localize = nls.config()();

const _SUGGESTION_PREVIEW_MAX_EMOJI_COUNT = 10;
const _SUGGESTION_PREVIEW_REFRESH_INTERVAL_MS = 250;

const [_VERB, _ACRONYM, _ABBR]: WordTag[] = ['verb', 'acronym', 'abbreviation'];
const _SUGGESTION_PREVIEW_WEIGHT_SUB_WORD = 1;
const _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_DEFAULT = 5;
const _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_BY_TAG = {
    [_VERB]: 10,
    [_ACRONYM]: 20,
    [_ABBR]: 20,
};

const _EMOJI_IN_MESSAGE_BOUNDARIES_REGEX = /^\s*\p{Extended_Pictographic}|\p{Extended_Pictographic}\s*$/ugm;
const _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS = 10;

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

    const scmInputDiagnostics = vscode.languages.createDiagnosticCollection('git-emoji:scminput');
    const scmInputCodeActionProvider = new SCMInputCodeActionProvider(scmInputDiagnostics);
    context.subscriptions.push(
        scmInputDiagnostics,
        vscode.languages.registerCodeActionsProvider('scminput', scmInputCodeActionProvider, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    );

    // const provider = new DummyCompletionItemProvider();
    // let alphabet = 'abcdefghijklmnopqrstuvwxyz';
    // const characters = ('0123456789~!@#$%^&*()-_=+{}[]\|\'";:,<.>/?' + alphabet.toLowerCase() + alphabet.toUpperCase()).split('');
    // context.subscriptions.push(vscode.languages.registerCompletionItemProvider('scminput', provider, ' ', ...characters));

}

export function deactivate() { }

class DummyCompletionItemProvider implements vscode.CompletionItemProvider<vscode.CompletionItem> {
    provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext): vscode.ProviderResult<vscode.CompletionList<vscode.CompletionItem> | vscode.CompletionItem[]> {
        const text = document.getText();
        if (!text.trim().length || _EMOJI_IN_MESSAGE_BOUNDARIES_REGEX.test(text)) {
            return;
        }
        const result = new vscode.CompletionItem(
            {
                label: 'Missing emoji',
                description: 'Missing emoji description',
                detail: 'Missing emoji detail',
            },
            vscode.CompletionItemKind.Text,
        );
        result.range = new vscode.Range(0, 0, 0, 2);
        //throw new Error('Method not implemented.');
        return [result];
    }
    resolveCompletionItem?(item: vscode.CompletionItem, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CompletionItem> {
        throw new Error('Method not implemented.');
    }
}

function getIndexedDataset() {
    return current().contextualDataVersion === "v1" ? indexedV1() : indexedV2();
}

let _lastIncompleteMessage: string | undefined = undefined;

async function suggest(overrideSeed?: string | undefined, skipUserInput?: boolean | undefined, overrideEmit?: EmitAction | undefined) {
    const seed = overrideSeed !== undefined ? overrideSeed : _lastIncompleteMessage || readActiveTextEditorSelection() || readCommitMessageInputBox();
    const commitMessage = skipUserInput ? seed : await readCommitMessage(seed);
    if (!commitMessage) {
        return;
    }

    _lastIncompleteMessage = commitMessage;

    const emojis = suggestEmojiForMessage(commitMessage);
    const selected = await pickEmoji(emojis);
    if (!selected || !selected.length) {
        vscode.window.showErrorMessage(localize('no-emoji-selected', 'No emoji selected'));
        return;
    }

    const combined = await pickConcatStyle(selected, commitMessage);
    if (!combined) {
        return;
    }

    const action = overrideEmit ? overrideEmit : await pickEmitAction();
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
            emitToClipboard(value);
            break;
        default:
            if (typeof action !== 'function') {
                emitToClipboard(value);
                break;
            }
            action(value);
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
        const emojis = getIndexedDataset().keyword2emoji.get(normalized)?.values() || [];

        let weight = 0;
        for (const t of getIndexedDataset().keyword2tag.get(normalized) || []) {
            weight += _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_BY_TAG[t] || 0;
        }

        for (const e of emojis) {
            increment(e, weight || _SUGGESTION_PREVIEW_WEIGHT_WHOLE_WORD_DEFAULT);
        }
    }

    // Sub-word (i.e., any) matching
    const normalizedMessage = message.toLowerCase();
    for (const [keyword, emojis] of getIndexedDataset().keyword2emoji.entries()) {
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

type EmitAction = 'copy' | 'type-in-terminal' | 'type-in-git-input-box' | 'type-in-new-document' | ((message: string) => void);

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
    const result = Array.from(getIndexedDataset().emoji2keyword.entries()).filter(([e]) => !except?.includes(e)).map(([e, s]): EmojiListItem => ({
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

class PickEmojiQuickFix extends vscode.CodeAction {
    constructor(readonly document: vscode.TextDocument, title: string) {
        super(title, vscode.CodeActionKind.QuickFix);
    }
}

class SCMInputCodeActionProvider implements vscode.CodeActionProvider<vscode.CodeAction> {
    private _map = new WeakMap<vscode.Uri, { text: string; actions: ReturnType<SCMInputCodeActionProvider['_provideCodeActions']> }>();

    constructor(private readonly diagnostics: vscode.DiagnosticCollection) { }

    async provideCodeActions(document: vscode.TextDocument, range: vscode.Selection | vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<vscode.CodeAction[]> {
        const text = document.getText();
        const lastOp = this._map.get(document.uri);
        if (lastOp?.text === text) {
            return lastOp.actions;
        }

        return new Promise(resolve => {
            const actions = this._provideCodeActions(text, document, range, context, token);
            this._map.set(document.uri, { text, actions });
            resolve(actions);
        });
    }

    private _provideCodeActions(text: string, document: vscode.TextDocument, range: vscode.Selection | vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.CodeAction[] {
        if (!text || text.match(_EMOJI_IN_MESSAGE_BOUNDARIES_REGEX)) {
            this.diagnostics.delete(document.uri);
            return [];
        }

        const emojis = suggestEmojiForMessage(text);
        if (!emojis.length) {
            this.diagnostics.delete(document.uri);
            return [];
        }

        const firstWhitespace = getFirstWhitespaceAfterFirstWord(text);
        const diagRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(firstWhitespace !== -1 ? firstWhitespace : text.length));
        let diags = this.diagnostics.get(document.uri);
        if (!diags || !diags.length || diags.some(x => !x.range.isEqual(diagRange))) {
            diags = [new vscode.Diagnostic(diagRange, 'Missing emoji in commit message', vscode.DiagnosticSeverity.Information)];
            this.diagnostics.set(document.uri, diags);
        }

        const pickEmojiCodeActionTitle = emojis.length <= _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS
            ? localize('scminput.quickfix.pick-emoji', "Pick Emoji...")
            : localize('scminput.quickfix.pick-emoji-with-more-items', "Pick Emoji ({0} More)...", emojis.length - _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS);
        const pickEmojiCodeAction = new PickEmojiQuickFix(document, pickEmojiCodeActionTitle);
        pickEmojiCodeAction.isPreferred = true;

        const actions: vscode.CodeAction[] = [pickEmojiCodeAction];
        for (const x of emojis.slice(0, _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS)) {
            const action = new vscode.CodeAction(localize('scminput.quickfix.insert-emoji', "Insert Emoji: {0}", x.s), vscode.CodeActionKind.QuickFix);
            action.edit = new vscode.WorkspaceEdit();
            action.edit.insert(document.uri, new vscode.Position(0, 0), `${x.s} `);
            action.diagnostics = [...diags];
            actions.push(action);
        }
        return actions;
    }

    resolveCodeAction(codeAction: vscode.CodeAction, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeAction> {
        const document = (codeAction as PickEmojiQuickFix).document;
        if (!document) {
            return;
        }
        const text = document.getText();
        suggest(text.trim(), true, (newText: string) => {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(document.uri, new vscode.Range(new vscode.Position(0, 0), document.positionAt(text.length)), newText);
            return vscode.workspace.applyEdit(edit);
        });
    }
}
