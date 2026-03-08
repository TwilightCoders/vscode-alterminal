/**
 * Template Engine
 *
 * Shared template parsing engine for token-based string expansion.
 * Supports {key}, {key?then:else}, {key:default} syntax with nesting.
 * Used by both TabTitleProvider (tab titles) and CommandManager (command templates).
 */

/**
 * Token resolver function.
 * Return a string for known values, null for known-but-empty tokens,
 * or undefined for truly unknown tokens (rendered as literal {key}).
 */
export type TokenResolver = (key: string) => string | null | undefined;

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
   * Nested tokens (e.g. {p? • {p}}) are handled via balanced-brace parsing.
   * The engine resolves outermost tokens first, recursively expanding inner
   * tokens only in the branch that is selected.
   */
  static render(template: string, resolver: TokenResolver): string {
    return TemplateEngine.expand(template, resolver);
  }

  /**
   * Expand all top-level tokens in the template string.
   * Uses balanced-brace scanning so nested tokens work correctly.
   */
  private static expand(template: string, resolver: TokenResolver): string {
    let result = "";
    let i = 0;
    while (i < template.length) {
      if (template[i] === "{") {
        // Find the matching closing brace (respecting nesting)
        const end = TemplateEngine.findMatchingBrace(template, i);
        if (end === -1) {
          // Unmatched brace, output literally
          result += template[i];
          i++;
        } else {
          const inner = template.slice(i + 1, end);
          result += TemplateEngine.resolveToken(inner, resolver);
          i = end + 1;
        }
      } else {
        result += template[i];
        i++;
      }
    }
    return result;
  }

  /**
   * Find the index of the closing brace matching the opening brace at `start`.
   * Returns -1 if no match found.
   */
  private static findMatchingBrace(str: string, start: number): number {
    let depth = 0;
    for (let i = start; i < str.length; i++) {
      if (str[i] === "{") depth++;
      else if (str[i] === "}") {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * Resolve a single token content (without outer braces).
   * Inner content may contain nested {tokens} which are expanded recursively.
   */
  private static resolveToken(content: string, resolver: TokenResolver): string {
    // Extract the key: everything before the first top-level ? or :
    const { key, rest } = TemplateEngine.extractKey(content);

    const val = resolver(key);

    if (rest.startsWith("?")) {
      const body = rest.slice(1);
      // Split on the first top-level colon to get then/else branches
      const delimIdx = TemplateEngine.findTopLevelColon(body);
      const thenText = delimIdx === -1 ? body : body.slice(0, delimIdx);
      const elseText = delimIdx === -1 ? "" : body.slice(delimIdx + 1);
      // Only expand the selected branch
      return val
        ? TemplateEngine.expand(thenText, resolver)
        : TemplateEngine.expand(elseText, resolver);
    }

    if (rest.startsWith(":")) {
      const defText = rest.slice(1);
      return val || TemplateEngine.expand(defText, resolver);
    }

    // Simple token: {key}
    if (typeof val === "string") {
      return val;
    }

    // null = known token with no current value → render empty
    if (val === null) {
      return "";
    }

    // undefined = unknown token → leave as-is so user sees what's wrong
    return `{${content}}`;
  }

  /**
   * Extract the token key from content, stopping at the first top-level ? or :.
   * "Top-level" means not inside nested braces.
   */
  private static extractKey(content: string): { key: string; rest: string } {
    let depth = 0;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === "{") depth++;
      else if (content[i] === "}") depth--;
      else if (depth === 0 && (content[i] === "?" || content[i] === ":")) {
        return { key: content.slice(0, i), rest: content.slice(i) };
      }
    }
    return { key: content, rest: "" };
  }

  /**
   * Find the index of the first colon at brace depth 0.
   */
  private static findTopLevelColon(str: string): number {
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      if (str[i] === "{") depth++;
      else if (str[i] === "}") depth--;
      else if (depth === 0 && str[i] === ":") return i;
    }
    return -1;
  }
}
