/**
 * Template Engine
 *
 * Shared template parsing engine for token-based string expansion.
 * Supports {key}, {key?then:else}, {key:default} syntax.
 * Used by both TabTitleProvider (tab titles) and CommandManager (command templates).
 */

export type TokenResolver = (key: string) => string | null;

export class TemplateEngine {
  /**
   * Parse and resolve template string using the given token resolver.
   *
   * Token syntax:
   *   {key}            - replaced with resolved value, or left as-is if unknown
   *   {key:default}    - resolved value, or default if null
   *   {key?then}       - "then" text if value is non-null, empty otherwise
   *   {key?then:else}  - "then" if non-null, "else" if null
   *
   * Nested tokens are resolved iteratively (innermost first).
   * Unknown tokens (resolver returns null and token not registered) are left as-is.
   */
  static render(template: string, resolver: TokenResolver, maxIterations = 50): string {
    const tokenRe = /\{([^{}]+)\}/g;
    let prev = "";
    let out = template;
    let guard = 0;
    while (out !== prev && guard++ < maxIterations) {
      prev = out;
      out = out.replace(tokenRe, (_m, content: string) =>
        TemplateEngine.resolveToken(content, resolver),
      );
    }
    return out;
  }

  /**
   * Resolve a single token content (without outer braces).
   */
  private static resolveToken(content: string, resolver: TokenResolver): string {
    const q = content.indexOf("?");
    const c = content.indexOf(":");
    const cutIdx = Math.min(q === -1 ? Infinity : q, c === -1 ? Infinity : c);
    const key = cutIdx === Infinity ? content : content.slice(0, cutIdx);
    const rest = cutIdx === Infinity ? "" : content.slice(cutIdx);

    const val = resolver(key);

    if (rest.startsWith("?")) {
      const body = rest.slice(1);
      const delim = body.indexOf(":");
      const thenText = delim === -1 ? body : body.slice(0, delim);
      const elseText = delim === -1 ? "" : body.slice(delim + 1);
      return val ? thenText : elseText;
    }

    if (rest.startsWith(":")) {
      const defText = rest.slice(1);
      return val || defText;
    }

    // Known token (resolver returned a value) -> use it
    if (val !== null) {
      return val;
    }

    // Unknown token -> leave as-is so user sees what's wrong
    return `{${content}}`;
  }
}
