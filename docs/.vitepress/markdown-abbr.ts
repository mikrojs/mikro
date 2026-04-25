import type MarkdownIt from 'markdown-it'

import {abbreviations} from './abbreviations.js'

/**
 * markdown-it plugin that wraps known acronyms in <Abbr> Vue components with tooltips.
 * Only matches whole words, skips content inside code spans/blocks and links.
 */
export function abbrPlugin(md: MarkdownIt): void {
  // Build a single regex that matches any known acronym as a whole word.
  // Sort by length descending so longer matches take priority (e.g. "mDNS" before "DNS").
  const terms = Object.keys(abbreviations).sort((a, b) => b.length - a.length)
  const pattern = new RegExp(`\\b(${terms.join('|')})\\b`, 'g')

  md.core.ruler.after('inline', 'abbr_replace', (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const token = state.tokens[i]!
      if (token.type !== 'inline' || !token.children) continue

      // Skip headings: abbreviations in headings break VitePress sidebar anchors
      const prev = state.tokens[i - 1]
      if (prev && prev.type === 'heading_open') continue

      const newChildren: typeof token.children = []

      for (const child of token.children) {
        // Only process plain text tokens
        if (child.type !== 'text') {
          newChildren.push(child)
          continue
        }

        const text = child.content
        let lastIndex = 0
        let match: RegExpExecArray | null

        pattern.lastIndex = 0
        while ((match = pattern.exec(text)) !== null) {
          const acronym = match[0]!
          const title = abbreviations[acronym]
          if (!title) continue

          // Push text before the match
          if (match.index > lastIndex) {
            const before = new state.Token('text', '', 0)
            before.content = text.slice(lastIndex, match.index)
            newChildren.push(before)
          }

          // Push <Abbr title="..."> open
          const open = new state.Token('html_inline', '', 0)
          open.content = `<Abbr title="${title}">`
          newChildren.push(open)

          // Push acronym text
          const abbrText = new state.Token('text', '', 0)
          abbrText.content = acronym
          newChildren.push(abbrText)

          // Push </Abbr> close
          const close = new state.Token('html_inline', '', 0)
          close.content = '</Abbr>'
          newChildren.push(close)

          lastIndex = match.index + acronym.length
        }

        // Push remaining text
        if (lastIndex === 0) {
          // No matches in this text node
          newChildren.push(child)
        } else if (lastIndex < text.length) {
          const remaining = new state.Token('text', '', 0)
          remaining.content = text.slice(lastIndex)
          newChildren.push(remaining)
        }
      }

      token.children = newChildren
    }
  })
}
