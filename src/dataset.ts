import * as dataset from '@git-emoji/dataset-js';

import { normalizeWord } from './util';

export type Emoji = (typeof dataset.emoji)['_1234'];
export type WordTag = dataset.WordTag;

interface IndexedDataset {
    keyword2emoji: Map<string, Set<Emoji>>;
    emoji2keyword: Map<Emoji, Set<string>>;
    keyword2tag: Map<string, Set<dataset.WordTag>>;
}

let _indexedV1: IndexedDataset | undefined = undefined;
let _indexedV2: IndexedDataset | undefined = undefined;

export function indexedV1() {
    return _indexedV1 || (_indexedV1 = makeIndexed('v1'));
}

export function indexedV2() {
    return _indexedV2 || (_indexedV2 = makeIndexed('v2'));
}

function makeIndexed(contextVersion: 'v1' | 'v2'): IndexedDataset {
    const keyword2emoji = new Map<string, Set<Emoji>>();
    const emoji2keyword = new Map<Emoji, Set<string>>();

    for (const key of Object.keys(dataset.emoji)) {
        const emoji = dataset.emoji[key as keyof typeof dataset.emoji];
        emoji2keyword.set(emoji, new Set<string>());
    }

    const context = contextVersion === 'v1' ? dataset.contextV1 : dataset.contextV2;

    for (const ctx of context) {
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

    const keyword2tag = new Map<string, Set<dataset.WordTag>>();
    for (const k in dataset.word) {
        const w = dataset.word[k as keyof typeof dataset.word] as dataset.WordEntry;
        for (const x of [k, ...w.cover]) {
            if (!keyword2tag.has(x)) {
                keyword2tag.set(x, new Set<dataset.WordTag>());
            }
            for (const t of w.tag) {
                keyword2tag.get(x)!.add(t);
            }
        }
    }

    return { keyword2emoji, emoji2keyword, keyword2tag };
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
