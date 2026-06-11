/**
 * Hugo source-format preprocessor.
 *
 * Strips Hugo shortcodes before chunking so retrieved snippets don't carry
 * `{{< ... >}}` literals (which pollute both retrieval signal and the
 * grounded prompt).
 *
 * Two shortcode delimiters are supported per Hugo docs:
 *   - `{{< name args >}} ... {{< /name >}}`  — block shortcodes
 *   - `{{% name args %}} ... {{% /name %}}`  — Markdown-mode shortcodes
 *
 * Both opening and closing tags are stripped; inner content between paired
 * tags is preserved. Self-closing shortcodes (e.g. `{{< image src="..." >}}`)
 * disappear entirely.
 *
 * Limitation: this is a regex pass, not a parser. Shortcodes whose arguments
 * contain literal `>` or `%` characters within quoted strings may not strip
 * cleanly. In practice, technical docs avoid these. Comments stay verbatim.
 */

const HUGO_ANGLE = /\{\{<[\s\S]*?>\}\}/g
const HUGO_PERCENT = /\{\{%[\s\S]*?%\}\}/g

export function hugoPreprocess(markdown: string): string {
  return markdown.replace(HUGO_ANGLE, '').replace(HUGO_PERCENT, '')
}
