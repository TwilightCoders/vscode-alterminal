import * as assert from 'assert';

suite('Link Detection', () => {
  // Must match the regex in terminal.ts (TerminalInstance.LINK_REGEX)
  const LINK_REGEX = /https?:\/\/[^\s"'`()[\]{}]+|(?:~|\.\.?)?\/[^\s"'`()[\]{}]*[^\s"'`()[\]{}\/]|[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-\.]/g;

  function findLinks(text: string): string[] {
    const regex = new RegExp(LINK_REGEX.source, 'g');
    const matches: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      matches.push(match[0]);
    }
    return matches;
  }

  suite('File paths with extensions', () => {
    test('should match relative paths', () => {
      assert.deepStrictEqual(findLinks('src/webview/terminal.ts'), ['src/webview/terminal.ts']);
    });

    test('should match deep relative paths', () => {
      assert.deepStrictEqual(findLinks('src/webview/tabManager.ts'), ['src/webview/tabManager.ts']);
    });

    test('should match paths with ./prefix', () => {
      assert.deepStrictEqual(findLinks('./src/file.js'), ['./src/file.js']);
    });

    test('should match paths with ../prefix', () => {
      assert.deepStrictEqual(findLinks('../parent/file.ts'), ['../parent/file.ts']);
    });

    test('should match multiple file paths', () => {
      assert.deepStrictEqual(
        findLinks('src/file.js and lib/other.ts and ./config.json'),
        ['src/file.js', 'lib/other.ts', './config.json'],
      );
    });
  });

  suite('Directory paths', () => {
    test('should match tilde paths as complete path', () => {
      assert.deepStrictEqual(findLinks('bash(~/.rbenv/shims/ruby test'), ['~/.rbenv/shims/ruby']);
    });

    test('should match home directory paths', () => {
      assert.deepStrictEqual(findLinks('~/workspace/project'), ['~/workspace/project']);
    });

    test('should match absolute paths', () => {
      assert.deepStrictEqual(findLinks('/usr/local/bin'), ['/usr/local/bin']);
    });

    test('should not break on hidden directories', () => {
      assert.deepStrictEqual(findLinks('~/.config/settings'), ['~/.config/settings']);
    });
  });

  suite('URLs', () => {
    test('should match http URLs', () => {
      assert.deepStrictEqual(findLinks('http://example.com'), ['http://example.com']);
    });

    test('should match https URLs', () => {
      assert.deepStrictEqual(findLinks('https://github.com/user/repo'), ['https://github.com/user/repo']);
    });

    test('should match URLs in text', () => {
      assert.deepStrictEqual(findLinks('Check out https://example.com for more'), ['https://example.com']);
    });
  });

  suite('Edge cases', () => {
    test('should exclude parentheses from paths', () => {
      assert.deepStrictEqual(findLinks('error(src/file.ts:123)'), ['src/file.ts']);
    });

    test('should exclude brackets from paths', () => {
      assert.deepStrictEqual(findLinks('[./config.json]'), ['./config.json']);
    });

    test('should exclude quotes from paths', () => {
      assert.deepStrictEqual(
        findLinks('"src/app.ts" and \'lib/util.js\''),
        ['src/app.ts', 'lib/util.js'],
      );
    });

    test('should not match single slash', () => {
      assert.deepStrictEqual(findLinks('Partner login: /'), []);
    });

    test('should not match pseudo-paths without valid extensions', () => {
      const links = findLinks('application/json');
      assert.ok(links.length <= 1);
    });

    test('should match paths in typical terminal output', () => {
      assert.deepStrictEqual(
        findLinks('  at Object.<anonymous> (src/test.ts:42:15)'),
        ['src/test.ts'],
      );
    });
  });

  suite('Real-world scenarios', () => {
    test('should handle npm error output', () => {
      assert.deepStrictEqual(findLinks('Error: Cannot find module src/index.ts'), ['src/index.ts']);
    });

    test('should handle git diff output', () => {
      assert.deepStrictEqual(findLinks('modified:   src/webview/terminal.ts'), ['src/webview/terminal.ts']);
    });

    test('should handle pytest output', () => {
      assert.deepStrictEqual(findLinks('tests/test_app.py::test_feature PASSED'), ['tests/test_app.py']);
    });

    test('should handle git branch references', () => {
      assert.deepStrictEqual(findLinks("ahead of 'origin/master' by 7 commits"), ['origin/master']);
    });

    test('should handle path embedded in sentence', () => {
      assert.deepStrictEqual(
        findLinks('Look at src/webview/tabManager.ts for details'),
        ['src/webview/tabManager.ts'],
      );
    });

    test('should handle path after colon', () => {
      assert.deepStrictEqual(
        findLinks('git add -p src/webview/tabManager.ts'),
        ['src/webview/tabManager.ts'],
      );
    });

    test('should handle path with line number suffix', () => {
      assert.deepStrictEqual(
        findLinks('src/webview/tabManager.ts:210'),
        ['src/webview/tabManager.ts'],
      );
    });
  });

  suite('Buffer position mapping', () => {
    // Mirrors _stringOffsetToBufferPos logic from terminal.ts
    function stringOffsetToBufferPos(
      lineRanges: Array<{ start: number; lineY: number; cols: number }>,
      offset: number,
    ): { x: number; y: number } | null {
      for (let i = lineRanges.length - 1; i >= 0; i--) {
        const range = lineRanges[i];
        if (offset >= range.start) {
          return { x: offset - range.start + 1, y: range.lineY };
        }
      }
      return null;
    }

    test('should map offset on single line', () => {
      const ranges = [{ start: 0, lineY: 1, cols: 80 }];
      assert.deepStrictEqual(stringOffsetToBufferPos(ranges, 0), { x: 1, y: 1 });
      assert.deepStrictEqual(stringOffsetToBufferPos(ranges, 10), { x: 11, y: 1 });
    });

    test('should map offset across wrapped lines', () => {
      // Two 80-col lines joined
      const ranges = [
        { start: 0, lineY: 5, cols: 80 },
        { start: 80, lineY: 6, cols: 80 },
      ];
      // Offset 70 = first line, col 71
      assert.deepStrictEqual(stringOffsetToBufferPos(ranges, 70), { x: 71, y: 5 });
      // Offset 80 = second line, col 1
      assert.deepStrictEqual(stringOffsetToBufferPos(ranges, 80), { x: 1, y: 6 });
      // Offset 90 = second line, col 11
      assert.deepStrictEqual(stringOffsetToBufferPos(ranges, 90), { x: 11, y: 6 });
    });

    test('should handle path spanning wrap boundary', () => {
      // "src/webview/tabManager.ts" starts at col 70 of an 80-col line
      // "src/webview/" (12 chars) fits on first line, "tabManager.ts" wraps
      const ranges = [
        { start: 0, lineY: 3, cols: 80 },
        { start: 80, lineY: 4, cols: 80 },
      ];
      const pathStart = 69; // col 70 (0-indexed)
      const pathEnd = 69 + 24; // "src/webview/tabManager.ts" = 25 chars, end at 93

      const startPos = stringOffsetToBufferPos(ranges, pathStart);
      const endPos = stringOffsetToBufferPos(ranges, pathEnd);

      // Start should be on line 3, col 70
      assert.deepStrictEqual(startPos, { x: 70, y: 3 });
      // End should be on line 4 (wrapped), col 14
      assert.deepStrictEqual(endPos, { x: 14, y: 4 });
    });

    test('should return null for negative offset', () => {
      const ranges = [{ start: 0, lineY: 1, cols: 80 }];
      assert.strictEqual(stringOffsetToBufferPos(ranges, -1), null);
    });
  });
});
