import * as assert from 'assert';
import { normalizeWord } from '../../util';

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
