import * as assert from "assert";
import { shellEscape } from "../../src/daemon/ptyDaemonClient";

suite("shellEscape", () => {
  test("passes through safe alphanumeric strings", () => {
    assert.strictEqual(shellEscape("hello"), "hello");
    assert.strictEqual(shellEscape("TERM"), "TERM");
    assert.strictEqual(shellEscape("xterm-256color"), "xterm-256color");
  });

  test("passes through safe special characters", () => {
    assert.strictEqual(shellEscape("/usr/bin/zsh"), "/usr/bin/zsh");
    assert.strictEqual(shellEscape("KEY=value"), "KEY=value");
    assert.strictEqual(shellEscape("user@host"), "user@host");
    assert.strictEqual(shellEscape("a.b.c"), "a.b.c");
    assert.strictEqual(shellEscape("a:b"), "a:b");
    assert.strictEqual(shellEscape("under_score"), "under_score");
  });

  test("quotes strings with spaces", () => {
    assert.strictEqual(shellEscape("hello world"), "'hello world'");
  });

  test("quotes strings with special shell characters", () => {
    assert.strictEqual(shellEscape("$HOME"), "'$HOME'");
    assert.strictEqual(shellEscape("a;b"), "'a;b'");
    assert.strictEqual(shellEscape("a&b"), "'a&b'");
    assert.strictEqual(shellEscape("a|b"), "'a|b'");
    assert.strictEqual(shellEscape("a(b)"), "'a(b)'");
    assert.strictEqual(shellEscape("a`b`"), "'a`b`'");
  });

  test("escapes single quotes within the value", () => {
    assert.strictEqual(shellEscape("it's"), "'it'\\''s'");
    assert.strictEqual(shellEscape("a'b'c"), "'a'\\''b'\\''c'");
  });

  test("handles empty string", () => {
    assert.strictEqual(shellEscape(""), "''");
  });

  test("handles newlines", () => {
    assert.strictEqual(shellEscape("a\nb"), "'a\nb'");
  });
});
