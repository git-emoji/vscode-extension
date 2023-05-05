import * as assert from 'assert';
import { getFirstWhitespaceAfterFirstWord, normalizeWord } from '../../util';

const se: typeof assert.strictEqual = assert.strictEqual;

test('normalizeWord', () => {
    const sut = normalizeWord;
    se(sut(''), '', 'empty');
    se(sut(' '), '', 'whitespace 1');
    se(sut('   '), '', 'whitespace 2');
    se(sut(' pre-whitespace'), 'pre-whitespace');
    se(sut('post-whitespace '), 'post-whitespace');
    se(sut('  wrapped-by-whitespace  '), 'wrapped-by-whitespace');
    se(sut('mixed-CASEs'), 'mixed-cases');
    se(sut(' mixed-CASEs-with-whitespace '), 'mixed-cases-with-whitespace');
});

test('getFirstWhitespaceAfterFirstWord', () => {
    const sut = getFirstWhitespaceAfterFirstWord;
    se(sut(''), -1, 'empty');
    se(sut(' '), -1, 'whitespace');
    se(sut('     '), -1, 'whitespace+');
    se(sut('  \t '), -1, 'whitespace+ (including tabs)');
    se(sut('something'), 9, 'word');
    se(sut(' something'), 10, 'whitespace+word 1');
    se(sut('\tsomething'), 10, 'whitespace+word 2');
    se(sut(' \t something'), 12, 'whitespace+word 3');
    se(sut(' something '), 10, 'whitespace+word+whitespace');
});