import * as dataset from '@git-emoji/dataset-js';

import { normalizeWord } from './util';

export type Emoji = (typeof dataset.emoji)['_1234'];

interface IndexedDataset {
    keyword2emoji: Map<string, Set<Emoji>>;
    emoji2keyword: Map<Emoji, Set<string>>;
}

let _indexed: IndexedDataset | undefined = undefined;

export function indexed() {
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
        const enhancedKeywords = getEnhanceKeywordsOfContextEntry(ctx);
        for (const keyword of enhancedKeywords) {
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
            for (const keyword of enhancedKeywords) {
                s.add(normalizeWord(keyword));
            }
        }
    }

    return { keyword2emoji, emoji2keyword };
}

function getEnhanceKeywordsOfContextEntry(ctx: { keyword: string[]; emoji: { id: string; s: string; }[] }): string[] {
    const result = new Set<string>();

    // Adding similar words
    for (const keyword of ctx.keyword) {
        result.add(keyword);
        const data = (dataset.word as any)[keyword];
        if (data?.cover) {
            data.cover.forEach((x: string) => result.add(x));
        }
    }

    // Adding emoji ids
    for (const emoji of ctx.emoji) {
        const normalized = normalizeWord(emoji.id);
        result.add(normalized);
    }

    return Array.from(result);
}
