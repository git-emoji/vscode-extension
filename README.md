# Git-Emoji Extension

Part of the [`git-emoji`][git-emoji] project and relying on its [emoji dataset][git-emoji-dataset], this simple extension helps you with using emojis in VS Code environment. Just do these 3 steps to get emoji suggestions matching with the context of your contribution.

1. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
1. Select the `Git-Emoji: Suggest` command
1. Write your commit message
1. Get emoji suggestions 🎁

[git-emoji]: https://github.com/git-emoji
[git-emoji-dataset]: https://github.com/git-emoji/dataset-js

![Suggest emoji for git commit message](/images/capture-suggest.gif)

## Inline suggestions in commit message input box

For VS Code v1.78.0 (or newer), the extension also suggests you emojis when you type in your commit message in the VS Code's source control side bar. As in the screen capture below, you can then hover over the blue squiggly line and click on *Quick Fix...* (or simply use the <kbd>Ctrl</kbd>+<kbd>.</kbd> keyboard shortcut) to see the suggestions:

![Suggest emoji in git commit message input box](/images/capture-scminput.gif)

## All emojis list

Just:

1. Press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd>
1. Select the `Git-Emoji: List Emojis` command
1. Search for your keyword or contextual data
1. Receive selected emojis 📋

## Changing the underlying dataset version

You can tell the extension which contextual dataset version to use. For this, you need to go the settings and find the "Contextual data version" configuration property. Learn more about the dataset versions at the dataset's [docs][git-emoji-dataset].

## Thank you

Love to see your contributions! 🍏
