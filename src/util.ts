const _FIRST_NON_WHITESPACE_SEQUENCE = /^\s*[^\s]+/u;

/**
 * @returns Index of the first whitespace character following the first word; otherwise, returns -1.
 */
export function getFirstWhitespaceAfterFirstWord(s: string): number {
    const match = s.match(_FIRST_NON_WHITESPACE_SEQUENCE);
    if (!match) {
        return -1;
    }
    return match[0].length;
}

export function normalizeWord(word: string) {
    return word.trim().toLowerCase();
}
