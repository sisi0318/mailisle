import { expect, it } from 'vitest';
import { searchExpression, tokenize } from './search';

it('stores CJK runs as pairs plus the last character and leaves other scripts alone', () => {
  expect(tokenize('电子发票').trim()).toBe('电子 子发 发票 票');
  expect(tokenize('月').trim()).toBe('月');
  expect(tokenize('invoice 2026').trim()).toBe('invoice 2026');
  expect(tokenize('第3封信').replace(/\s+/g, ' ').trim()).toBe('第 3 封信 信');
});

it('builds one phrase per word, with a prefix match for a single final character', () => {
  expect(searchExpression('发票')).toBe('"发票"');
  expect(searchExpression('电子发票')).toBe('"电子 子发 发票"');
  expect(searchExpression('月')).toBe('"月" *');
  expect(searchExpression('1月')).toBe('"1 月" *');
  expect(searchExpression('第3封')).toBe('"第 3 封" *');
  expect(searchExpression('发票pdf')).toBe('"发票 票 pdf"');
  expect(searchExpression('pdf发票')).toBe('"pdf 发票"');
  expect(searchExpression('alice 发票')).toBe('"alice" "发票"');
  expect(searchExpression('billing@example.com')).toBe('"billing example com"');
});

it('has no expression for input the index cannot hold, and cannot be steered by query syntax', () => {
  expect(searchExpression('%')).toBeNull();
  expect(searchExpression('  ')).toBeNull();
  expect(searchExpression('" OR *')).toBe('"OR"');
  expect(searchExpression('a" NEAR(b')).toBe('"a" "NEAR b"');
});
