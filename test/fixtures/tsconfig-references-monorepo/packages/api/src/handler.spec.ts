import { handleRequest } from './handler';

describe('handleRequest', () => {
  it('returns ok', () => {
    expect(handleRequest()).toBe('ok');
  });
});
