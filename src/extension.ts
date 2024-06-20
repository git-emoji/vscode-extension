import * as nls from 'vscode-nls';
import * as vscode from 'vscode';
import TelemetryReporter from '@vscode/extension-telemetry';

import { current, sync } from './config';
import { Emoji, WordTag, indexedV1, indexedV2 } from './dataset';
import { GitExtension } from './git';
import { getFirstWhitespaceAfterFirstWord, normalizeWord } from './util';

const localize = nls.config()();

const _TELEMETRY_CONNECTION_STRING = 'InstrumentationKey=c27b4b51-f390-44a7-b330-e523188c22bf;IngestionEndpoint=https://eastus-8.in.applicationinsights.azure.com/;LiveEndpoint=https://eastus.livediagnostics.monitor.azure.com/;ApplicationId=d6489f95-cbd5-4b65-bed1-5005dbce9980';
let _reporter: TelemetryReporter;

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

const _EMOJI_IN_MESSAGE_BOUNDARIES_REGEX = /^\s*\p{Extended_Pictographic}|\p{Extended_Pictographic}\s*\r?$/ug;
const _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS = 10;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        _reporter = new TelemetryReporter(context.extensionMode === vscode.ExtensionMode.Production ? _TELEMETRY_CONNECTION_STRING : '' )
    );

    sync();
    const disposables = [
        vscode.commands.registerCommand('vscode-git-emoji.suggest', () => {
            _reporter.sendTelemetryEvent('command.suggest');
            suggest();
        }),
        vscode.commands.registerCommand('vscode-git-emoji.list-emojis', () => {
            _reporter.sendTelemetryEvent('command.listEmojis');
            listEmojis();
        }),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('vscode-git-emoji')) {
                sync();
            }
        }),
    ];
    context.subscriptions.push(...disposables);

    const scmInputDiagnostics = vscode.languages.createDiagnosticCollection('git-emoji:scminput');
    const scmInputCodeActionProvider = new GitCommitInputCodeActionProvider(scmInputDiagnostics);
    context.subscriptions.push(
        scmInputDiagnostics,
        vscode.languages.registerCodeActionsProvider(['scminput', 'git-commit'], scmInputCodeActionProvider, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    );
}

export function deactivate() { }

function getIndexedDataset() {
    return current().contextualDataVersion === "v1" ? indexedV1() : indexedV2();
}

let _lastIncompleteMessage: string | undefined = undefined;

async function suggest(overrideSeed?: string | undefined, skipUserInput?: boolean | undefined, overrideEmit?: EmitAction | undefined) {
    const seed = overrideSeed !== undefined ? overrideSeed : readLastIncompleteMessage() || readActiveTextEditorSelection() || readCommitMessageInputBox();
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
        case 'type-in-active-document':
            await emitToActiveDocument(value);
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

function readLastIncompleteMessage(): string | undefined {
    if (_lastIncompleteMessage) {
        _reporter.sendTelemetryEvent('read.lastIncompleteMessage');
    }
    return _lastIncompleteMessage;
}

function readActiveTextEditorSelection(): string | undefined {
    const ate = vscode.window.activeTextEditor;
    const result = ate?.selection ? ate.document.getText(ate.selection) : undefined;
    if (result) {
        _reporter.sendTelemetryEvent('read.activeTextEditor');
    }
    return result;
}

function readCommitMessageInputBox(): string | undefined {
    const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git')?.exports;
    if (!gitExtension) {
        return;
    }
    const git = gitExtension.getAPI(1);
    for (const repo of git.repositories) {
        if (repo.inputBox.value) {
            _reporter.sendTelemetryEvent('read.scmInput');
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
        _reporter.sendTelemetryEvent('emit.scmInput');
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
            if (result) {
                _reporter.sendTelemetryEvent('read.input');
            }
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

type EmitAction = 'copy' | 'type-in-terminal' | 'type-in-git-input-box' | 'type-in-new-document' | 'type-in-active-document' | ((message: string) => void);

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
            {
                label: localize('pick-emit-action-type-in-active-document', "Type in active document"),
                action: 'type-in-active-document',
            },
        ],
        {
            ignoreFocusOut: true,
            title: localize('pick-emit-action-title', "Emit commit message"),
        }
    ))?.action;
}

function emitToTerminal(text: string) {
    _reporter.sendTelemetryEvent('emit.terminal');
    const terminal = vscode.window.activeTerminal || vscode.window.createTerminal();
    terminal.sendText(text, false);
    terminal.show();
}

async function emitToNewDocument(text: string) {
    _reporter.sendTelemetryEvent('emit.newDocument');
    await vscode.workspace.openTextDocument({ content: text });
}

async function emitToActiveDocument(text: string) {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        return emitToNewDocument(text);
    }
    await editor.edit(builder => {
        _reporter.sendTelemetryEvent('emit.activeDocument');
        builder.replace(editor.selection, text);
    });
}

function emitToClipboard(text: string) {
    _reporter.sendTelemetryEvent('emit.clipboard');
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

abstract class CustomQuickFix extends vscode.CodeAction {
    abstract apply(): void;
}

class InsertEmojiQuickFix extends CustomQuickFix {
    constructor(readonly document: vscode.TextDocument, readonly emoji: string, title: string) {
        super(title, vscode.CodeActionKind.QuickFix);
    }

    apply(): void {
        _reporter.sendTelemetryEvent('quickfix.insert');
        const edit = new vscode.WorkspaceEdit();
        edit.insert(this.document.uri, new vscode.Position(0, 0), `${this.emoji} `);
        vscode.workspace.applyEdit(edit);
    }
}

class PickEmojiQuickFix extends CustomQuickFix {
    constructor(readonly document: vscode.TextDocument, readonly firstLine: string, title: string) {
        super(title, vscode.CodeActionKind.QuickFix);
    }

    apply(): void {
        _reporter.sendTelemetryEvent('quickfix.pick');
        suggest(this.firstLine.trim(), true, (newText: string) => {
            const edit = new vscode.WorkspaceEdit();
            edit.replace(this.document.uri, new vscode.Range(new vscode.Position(0, 0), this.document.positionAt(this.firstLine.length)), newText);
            return vscode.workspace.applyEdit(edit);
        });
    }
}

class GitCommitInputCodeActionProvider implements vscode.CodeActionProvider<CustomQuickFix> {
    private _map = new WeakMap<vscode.Uri, { text: string; actions: ReturnType<GitCommitInputCodeActionProvider['_provideCodeActions']> }>();

    constructor(private readonly diagnostics: vscode.DiagnosticCollection) { }

    async provideCodeActions(document: vscode.TextDocument, range: vscode.Selection | vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): Promise<CustomQuickFix[]> {
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

    private _provideCodeActions(text: string, document: vscode.TextDocument, range: vscode.Selection | vscode.Range, context: vscode.CodeActionContext, token: vscode.CancellationToken): CustomQuickFix[] {
        const lines = text.split('\n'); // No need to include `\r`, since it's taken care of in the RegExp.
        const firstLine = lines[0];
        if (!firstLine || firstLine.match(_EMOJI_IN_MESSAGE_BOUNDARIES_REGEX)) {
            this.diagnostics.delete(document.uri);
            return [];
        }

        const emojis = suggestEmojiForMessage(firstLine);
        if (!emojis.length) {
            this.diagnostics.delete(document.uri);
            return [];
        }

        const firstWhitespace = getFirstWhitespaceAfterFirstWord(firstLine);
        const diagRange = new vscode.Range(new vscode.Position(0, 0), document.positionAt(firstWhitespace !== -1 ? firstWhitespace : firstLine.length));
        let diags = this.diagnostics.get(document.uri);
        if (!diags || !diags.length || diags.some(x => !x.range.isEqual(diagRange))) {
            diags = [new vscode.Diagnostic(diagRange, 'Missing emoji in commit message', vscode.DiagnosticSeverity.Information)];
            this.diagnostics.set(document.uri, diags);
        }

        const pickEmojiCodeActionTitle = emojis.length <= _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS
            ? localize('git-commit.quickfix.pick-emoji', "Pick Emoji...")
            : localize('git-commit.quickfix.pick-emoji-with-more-items', "Pick Emoji ({0} More)...", emojis.length - _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS);
        const pickEmojiCodeAction = new PickEmojiQuickFix(document, firstLine, pickEmojiCodeActionTitle);
        pickEmojiCodeAction.isPreferred = true;

        const actions: CustomQuickFix[] = [pickEmojiCodeAction];
        for (const x of emojis.slice(0, _MAX_SCMINPUT_QUICKFIX_EMOJI_SUGGESTIONS)) {
            const action = new InsertEmojiQuickFix(document, x.s, localize('git-commit.quickfix.insert-emoji', "Insert Emoji: {0}", x.s));
            action.diagnostics = [...diags];
            actions.push(action);
        }
        return actions;
    }

    resolveCodeAction(codeAction: CustomQuickFix, token: vscode.CancellationToken): vscode.ProviderResult<CustomQuickFix> {
        codeAction.apply();
        return;
    }
}
