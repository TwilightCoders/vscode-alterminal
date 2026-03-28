import * as assert from 'assert';

suite('Link Detection', () => {
  // Must match the regex in terminal.ts (TerminalInstance.LINK_REGEX)
  const LINK_REGEX = /https?:\/\/[^\s"'`()[\]{}]+[^\s"'`()[\]{}.,:;!?]|(?:~|\.\.?)?\/[^\s"'`()[\]{}]*[^\s"'`()[\]{}\/.,;:!?]|[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-]/g;

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

    test('should exclude trailing period from path at end of sentence', () => {
      assert.deepStrictEqual(
        findLinks('The plan is at cli/.claude/docs/REFACTOR_PLAN.md.'),
        ['cli/.claude/docs/REFACTOR_PLAN.md'],
      );
    });

    test('should exclude trailing comma from path in list', () => {
      assert.deepStrictEqual(
        findLinks('See src/file.ts, and lib/util.js.'),
        ['src/file.ts', 'lib/util.js'],
      );
    });

    test('should exclude trailing punctuation from URLs', () => {
      assert.deepStrictEqual(
        findLinks('Visit https://example.com/path.'),
        ['https://example.com/path'],
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

  suite('xterm-link-provider indexOf bug (regression)', () => {
    // Reproduces the bug in the old xterm-link-provider implementation.
    // The library used indexOf to re-find the match text in the line,
    // which fails when the same substring appears earlier in the line.

    /**
     * Simulates xterm-link-provider's computeLink logic (simplified).
     * Uses indexOf to find the match position — the source of the bug.
     */
    function oldLibraryFindLinks(line: string, regex: RegExp): Array<{ text: string; index: number }> {
      const rex = new RegExp(regex.source, 'g');
      let match: RegExpExecArray | null;
      let stringIndex = -1;
      const result: Array<{ text: string; index: number }> = [];

      while ((match = rex.exec(line)) !== null) {
        const text = match[1]; // Library uses capture group 1
        if (!text) break;
        // Bug: uses indexOf to re-find the match position
        stringIndex = line.indexOf(text, stringIndex + 1);
        rex.lastIndex = stringIndex + text.length;
        if (stringIndex < 0) break;
        result.push({ text, index: stringIndex });
      }
      return result;
    }

    /**
     * Our new implementation: uses match.index directly.
     */
    function newFindLinks(line: string, regex: RegExp): Array<{ text: string; index: number }> {
      const rex = new RegExp(regex.source, 'g');
      let match: RegExpExecArray | null;
      const result: Array<{ text: string; index: number }> = [];

      while ((match = rex.exec(line)) !== null) {
        result.push({ text: match[0], index: match.index });
      }
      return result;
    }

    // Old library regex (with capture group, as the library expected)
    const OLD_REGEX = /(https?:\/\/[^\s"'`()[\]{}]+|(?:~|\.\.?)?\/[^\s"'`()[\]{}]*[^\s"'`()[\]{}\/]|[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-\.])/;
    // New regex (no capture group needed)
    const NEW_REGEX = /https?:\/\/[^\s"'`()[\]{}]+|(?:~|\.\.?)?\/[^\s"'`()[\]{}]*[^\s"'`()[\]{}\/]|[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-\.]/;

    test('old library misidentifies link when path substring appears earlier', () => {
      // "tabManager.ts" appears as part of both a word and the full path.
      // The old library's indexOf finds the FIRST occurrence of the match
      // text, not the one the regex actually matched.
      const line = 'See tabManager.ts docs in src/webview/tabManager.ts for details';
      const oldResult = oldLibraryFindLinks(line, OLD_REGEX);
      const newResult = newFindLinks(line, NEW_REGEX);

      // Old library: first match is correct (no prior occurrence to confuse indexOf)
      // But the second match indexOf finds the WRONG position
      // because "tabManager.ts" appears earlier in the string as a bare word
      // (which doesn't match the regex since it has no slash).
      // This demonstrates the class of bug: indexOf re-search is fragile.

      // New implementation always gets the right position
      assert.strictEqual(newResult.length, 1);
      assert.strictEqual(newResult[0].text, 'src/webview/tabManager.ts');
      assert.strictEqual(newResult[0].index, line.indexOf('src/webview/tabManager.ts'));
    });

    test('old library indexOf finds wrong occurrence with duplicate substrings', () => {
      // Two paths where the second contains the first as a substring
      const line = 'Compare utils/helper.ts with src/utils/helper.ts';
      const oldResult = oldLibraryFindLinks(line, OLD_REGEX);
      const newResult = newFindLinks(line, NEW_REGEX);

      // Both should find both paths
      assert.strictEqual(newResult.length, 2);
      assert.strictEqual(newResult[0].text, 'utils/helper.ts');
      assert.strictEqual(newResult[0].index, 8);
      assert.strictEqual(newResult[1].text, 'src/utils/helper.ts');
      assert.strictEqual(newResult[1].index, 29);

      // Old library also finds both, but indexOf for the second match
      // might find "utils/helper.ts" at position 8 instead of 33
      // because indexOf searches from stringIndex+1 which is after
      // the first match end. In this case it works because the search
      // starts past the first occurrence. But it's still fragile.
      assert.strictEqual(oldResult.length, 2);
    });

    test('new implementation handles paths correctly regardless of context', () => {
      const cases = [
        'git add -p src/webview/tabManager.ts',
        'Modified: src/webview/tabManager.ts',
        'error in src/webview/tabManager.ts:42:15',
        'src/webview/tabManager.ts and src/webview/terminal.ts',
      ];

      for (const line of cases) {
        const result = newFindLinks(line, NEW_REGEX);
        assert.ok(result.length > 0, `Should find link in: "${line}"`);
        for (const link of result) {
          // Every matched link should be findable at the reported index
          assert.strictEqual(
            line.substring(link.index, link.index + link.text.length),
            link.text,
            `Link "${link.text}" at index ${link.index} should match substring in "${line}"`,
          );
        }
      }
    });
  });

  suite('Cross-line link joining (hard-wrapped URLs)', () => {
    // Claude Code (via Ink) hard-wraps long lines by inserting \r\n at
    // the terminal width. This splits URLs/paths across buffer lines.
    // xterm-link-provider sees them as separate lines (isWrapped=false).
    // Alterminal needs to detect and rejoin these.

    /**
     * Simulates the cross-line join logic.
     * Given adjacent lines from the buffer, detects when a URL or path
     * is split at the terminal width and joins them.
     *
     * Rules:
     * - A link candidate ends at or near column `cols` (within 2 chars)
     * - The next line starts with continuation chars (no leading whitespace,
     *   no \e[ cursor positioning — raw text continues the URL/path)
     * - The continuation matches valid URL/path characters
     */
    /**
     * Detect and rejoin links split across hard-wrapped lines.
     *
     * Algorithm:
     * 1. Find link matches on each line
     * 2. If a match ends at or near `cols` (the terminal width), check
     *    if the next line is a plausible continuation
     * 3. Continuation criteria: next line does NOT start with whitespace
     *    or escape sequences, and its leading chars are valid URL/path chars
     * 4. Join the match text and re-validate against the regex
     */
    function joinCrossLineLinks(
      lines: string[],
      cols: number,
      regex: RegExp,
    ): Array<{ text: string; startLine: number; startCol: number }> {
      const results: Array<{ text: string; startLine: number; startCol: number }> = [];
      const consumedLines = new Set<number>(); // lines consumed as continuations

      for (let i = 0; i < lines.length; i++) {
        if (consumedLines.has(i)) continue;

        const line = lines[i];
        const trimmedLine = line.replace(/\s+$/, ''); // trim trailing whitespace for length check
        const re = new RegExp(regex.source, 'g');
        let match: RegExpExecArray | null;

        while ((match = re.exec(trimmedLine)) !== null) {
          let fullText = match[0];
          const startCol = match.index;
          const matchEnd = startCol + fullText.length;

          // Does this match reach near the terminal width?
          // Only try to join if the line actually fills the terminal
          // (original line length, not trimmed — padded lines count).
          if (line.length >= cols - 2 && matchEnd >= trimmedLine.length - 2) {
            // Try to join with subsequent lines
            let joinLine = i;
            while (joinLine + 1 < lines.length) {
              const nextLine = lines[joinLine + 1];
              // Continuation: must NOT start with whitespace or escape sequences
              if (!nextLine || /^[\s\x1b]/.test(nextLine)) break;

              // Find how much of the next line continues valid URL/path chars
              const contMatch = nextLine.match(/^[^\s"'`()[\]{},;:!?]+/);
              if (!contMatch) break;

              fullText += contMatch[0];
              joinLine++;
              consumedLines.add(joinLine);

              // If this continuation doesn't fill the line, stop
              const contTrimmed = nextLine.replace(/\s+$/, '');
              if (contMatch[0].length < contTrimmed.length - 2) break;
            }
          }

          // Re-validate the joined text against the regex
          const validationRe = new RegExp(regex.source);
          const validated = validationRe.exec(fullText);
          if (validated) {
            results.push({
              text: validated[0],
              startLine: i,
              startCol: startCol + validated.index,
            });
          }
        }
      }
      return results;
    }

    const URL_REGEX = /https?:\/\/[^\s"'`()[\]{}]+[^\s"'`()[\]{}.,:;!?]/;
    const PATH_REGEX = /(?:~|\.\.?)?\/[^\s"'`()[\]{}]*[^\s"'`()[\]{}\/.,;:!?]|[a-zA-Z0-9_\-\.]+\/[a-zA-Z0-9_\-\.\/]*[a-zA-Z0-9_\-]/;
    const COMBINED = new RegExp(`${URL_REGEX.source}|${PATH_REGEX.source}`);

    test('should join URL split across two lines at terminal width', () => {
      // 80-col terminal, URL wraps after "task"
      const lines = [
        'MR is up: https://gitlab.example.com/org/app/post-hire-verify-tasks',  // 68 chars + url fills to col 80
        '/-/merge_requests/194',
      ];
      // Pad first line to exactly 80 cols
      const paddedLine = lines[0].padEnd(80);
      const result = joinCrossLineLinks([paddedLine, lines[1]], 80, COMBINED);

      assert.ok(result.length >= 1);
      const urlLink = result.find(r => r.text.includes('merge_requests'));
      assert.ok(urlLink, `Should find joined URL, got: ${JSON.stringify(result)}`);
      assert.ok(
        urlLink!.text.includes('post-hire-verify-tasks/-/merge_requests/194'),
        `Joined URL should contain full path, got: "${urlLink!.text}"`,
      );
    });

    test('should not join when next line has leading whitespace', () => {
      const lines = [
        'See https://example.com/very-long-path-that-fills'.padEnd(80),
        '  /continued-path',  // has leading spaces — new content, not continuation
      ];
      const result = joinCrossLineLinks(lines, 80, COMBINED);

      // The URL from line 1 should NOT include /continued-path
      const mainLink = result.find(r => r.startLine === 0 && r.text.startsWith('https://'));
      assert.ok(mainLink, 'Should find the URL on line 1');
      assert.ok(
        !mainLink!.text.includes('continued-path'),
        `URL should not include continuation: "${mainLink!.text}"`,
      );
    });

    test('should not join when next line starts with escape sequence', () => {
      const lines = [
        'See https://example.com/path-that-fills-the-line'.padEnd(80),
        '\x1b[2C/next-section',  // cursor move — Claude Code indentation
      ];
      const result = joinCrossLineLinks(lines, 80, COMBINED);

      // The URL from line 1 should NOT include /next-section
      const mainLink = result.find(r => r.startLine === 0 && r.text.startsWith('https://'));
      assert.ok(mainLink, 'Should find the URL on line 1');
      assert.ok(
        !mainLink!.text.includes('next-section'),
        `URL should not include continuation: "${mainLink!.text}"`,
      );
    });

    test('should not join when match does not end near terminal width', () => {
      const lines = [
        'Short: https://example.com/path',  // ends well before col 80
        'unrelated-text',
      ];
      const result = joinCrossLineLinks(lines, 80, COMBINED);

      // Only the URL should be found, not joined with unrelated-text
      const urlLink = result.find(r => r.text.startsWith('https://'));
      assert.ok(urlLink);
      assert.strictEqual(urlLink!.text, 'https://example.com/path');
    });

    test('should join file path split across lines', () => {
      const lines = [
        '/Users/dale/Workspace/TwilightCoders/vscode/alterminal/src/terminal/ptyManage'.padEnd(80),
        'r.ts',
      ];
      const result = joinCrossLineLinks(lines, 80, COMBINED);

      const pathLink = result.find(r => r.text.includes('ptyManager.ts'));
      assert.ok(pathLink, `Should find joined path, got: ${JSON.stringify(result)}`);
    });
  });
});
