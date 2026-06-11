/**
 * Unit tests for the Hugo source-format preset.
 *
 * Goal: strip both shortcode delimiter styles so retrieved snippets and the
 * grounded prompt don't carry literal `{{< ... >}}` tokens.
 */

import { describe, expect, it } from 'vitest'

import { hugoPreprocess } from '../src/grounding/presets/hugo.js'
import { ingestMarkdown } from '../src/grounding/ingest.js'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('hugoPreprocess', () => {
  it('strips self-closing angle-bracket shortcodes', () => {
    const input = 'Before {{< image src="cat.jpg" alt="cat" >}} after.'
    expect(hugoPreprocess(input)).toBe('Before  after.')
  })

  it('strips self-closing percent shortcodes', () => {
    const input = 'Before {{% callout %}} after.'
    expect(hugoPreprocess(input)).toBe('Before  after.')
  })

  it('preserves inner content of paired angle-bracket shortcodes', () => {
    const input = '{{< note >}}\nKeep this content.\n{{< /note >}}'
    expect(hugoPreprocess(input)).toBe('\nKeep this content.\n')
  })

  it('preserves inner content of paired percent shortcodes', () => {
    const input =
      '{{% admonition warning %}}\nKeep this content.\n{{% /admonition %}}'
    expect(hugoPreprocess(input)).toBe('\nKeep this content.\n')
  })

  it('strips multiple shortcodes in one document', () => {
    const input = [
      '# Title',
      '',
      '{{< note >}}',
      'Real prose stays.',
      '{{< /note >}}',
      '',
      'Inline {{< ref "page.md" >}} reference.',
      '',
      '{{% callout %}}',
      'More prose.',
      '{{% /callout %}}',
    ].join('\n')

    const out = hugoPreprocess(input)
    expect(out).not.toContain('{{<')
    expect(out).not.toContain('{{%')
    expect(out).toContain('Real prose stays.')
    expect(out).toContain('More prose.')
    expect(out).toContain('Inline  reference.')
  })

  it('is a no-op on Markdown without shortcodes', () => {
    const md = '# Heading\n\nJust plain markdown.\n\n- item\n- item\n'
    expect(hugoPreprocess(md)).toBe(md)
  })

  it('handles shortcodes spanning multiple lines', () => {
    const input = [
      '{{< multiline',
      '  arg1="value1"',
      '  arg2="value2"',
      '>}}',
      'content',
      '{{< /multiline >}}',
    ].join('\n')
    const out = hugoPreprocess(input)
    expect(out).not.toContain('{{<')
    expect(out).toContain('content')
  })
})

describe('ingestMarkdown with --preset hugo', () => {
  it('removes Hugo shortcodes before chunking', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-hugo-'))
    await writeFile(
      join(dir, 'doc.md'),
      [
        '## Section',
        '',
        '{{< note >}}',
        'This is real prose that should survive.',
        '{{< /note >}}',
        '',
        '{{< image src="/img.png" alt="example" >}}',
        '',
        'Inline text after the image.',
      ].join('\n'),
    )

    const result = await ingestMarkdown({ source: dir, preset: 'hugo' })
    expect(result.chunks).toHaveLength(1)
    const text = result.chunks[0]!.text
    expect(text).not.toContain('{{<')
    expect(text).not.toContain('{{%')
    expect(text).toContain('This is real prose that should survive.')
    expect(text).toContain('Inline text after the image.')
  })

  it('vanilla preset leaves shortcodes intact (for comparison)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ingest-vanilla-'))
    await writeFile(
      join(dir, 'doc.md'),
      '## Section\n\n{{< note >}}content{{< /note >}}\n',
    )

    const result = await ingestMarkdown({ source: dir, preset: 'vanilla' })
    expect(result.chunks[0]!.text).toContain('{{<')
  })
})
