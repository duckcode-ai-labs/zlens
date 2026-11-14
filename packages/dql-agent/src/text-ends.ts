/**
 * Trimming a run of characters off either end of a text, in one pass over the characters. A regular expression
 * such as `/[.\s]+$/` is tried again at every position of a long run that does not reach the end, which is
 * quadratic on text a person or a model wrote; these loops are linear.
 */

const isWhitespace = (char: string): boolean => /\s/.test(char);

/** The text without the whitespace and the given characters at its end: `withoutTrailing('in 2015?. ', '.')` is "in 2015?". */
export function withoutTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0) {
    const char = text.charAt(end - 1);
    if (!isWhitespace(char) && !chars.includes(char)) break;
    end -= 1;
  }
  return text.slice(0, end);
}

/** The text without the whitespace and the given characters at its start. */
export function withoutLeading(text: string, chars: string): string {
  let start = 0;
  while (start < text.length) {
    const char = text.charAt(start);
    if (!isWhitespace(char) && !chars.includes(char)) break;
    start += 1;
  }
  return text.slice(start);
}

/** The text without the given characters (and no whitespace) at either end: `withoutEnds('__a_b__', '_')` is "a_b". */
export function withoutEnds(text: string, chars: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && chars.includes(text.charAt(start))) start += 1;
  while (end > start && chars.includes(text.charAt(end - 1))) end -= 1;
  return text.slice(start, end);
}
