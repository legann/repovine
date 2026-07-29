/** A compiled glob. `test` reports whether a `/`-separated path matches the whole glob. */
export interface GlobMatcher {
  test(path: string): boolean;
}

type GlobToken =
  | { kind: 'lit'; ch: string } // an ordinary character, matched verbatim
  | { kind: 'single' } // `?` — exactly one character other than `/`
  | { kind: 'star' } // `*` — any run of characters, none of them `/`
  | { kind: 'globstar' }; // `**` — any run of characters, `/` included

function tokenizeGlob(glob: string): GlobToken[] {
  const tokens: GlobToken[] = [];
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        tokens.push({ kind: 'globstar' });
        i += 2;
        if (glob[i] === '/') i++; // `**/` also spans zero directories, so it absorbs the slash
      } else {
        tokens.push({ kind: 'star' });
        i++;
      }
    } else if (c === '?') {
      tokens.push({ kind: 'single' });
      i++;
    } else {
      tokens.push({ kind: 'lit', ch: c });
      i++;
    }
  }
  return tokens;
}

/**
 * Compile a glob like `**\/*.controller.ts` to a linear matcher, anchored to the whole string.
 * Supports: `*` (any chars except `/`), `**` (any chars including `/`), `?` (single non-`/` char);
 * every other character is literal. Brace expansion is NOT supported — keep globs simple.
 *
 * Ships in the SDK because `build.scan` globs are matched on both sides of the boundary: the engine
 * compiles what the user wrote and a producer applies the compiled patterns while it walks. One
 * implementation means a path the engine calls excluded is the path a producer skips.
 *
 * Matching is a two-row dynamic program over (tokens × path length): O(tokens · path) time, no
 * backtracking. A regex translation (`**` → `.*`) backtracks catastrophically when globstars are
 * separated by literals (`**a**a…**b`) against a long non-matching path — a committed
 * `repovine.config.json` glob runs on the discovery main thread, so that path stays linear here.
 */
export function compileGlob(glob: string): GlobMatcher {
  const tokens = tokenizeGlob(glob);
  return {
    test(path: string): boolean {
      const n = path.length;
      // reach[j] = the tokens consumed so far match exactly the first j characters of the path.
      let reach = new Array<boolean>(n + 1).fill(false);
      reach[0] = true;
      for (const token of tokens) {
        const next = new Array<boolean>(n + 1).fill(false);
        // j === 0: only the wildcards that accept an empty run can extend a match with no input left.
        next[0] = (token.kind === 'star' || token.kind === 'globstar') && reach[0];
        for (let j = 1; j <= n; j++) {
          const ch = path[j - 1];
          switch (token.kind) {
            case 'lit':
              next[j] = ch === token.ch && reach[j - 1];
              break;
            case 'single':
              next[j] = ch !== '/' && reach[j - 1];
              break;
            case 'star':
              next[j] = reach[j] || (ch !== '/' && next[j - 1]);
              break;
            case 'globstar':
              next[j] = reach[j] || next[j - 1];
              break;
          }
        }
        reach = next;
      }
      return reach[n];
    },
  };
}
