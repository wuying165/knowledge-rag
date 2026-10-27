import type { ComponentProps } from 'react'
import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'

type MarkdownComponents = ComponentProps<typeof Markdown>['components']

const components: MarkdownComponents = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  img: ({ src, alt }) => <img src={src ?? ''} alt={alt ?? ''} />,
  table: ({ children }) => (
    <div className="kh-md-table-wrap">
      <table>{children}</table>
    </div>
  ),
}

/** 文档正文：GFM + MinerU 的 HTML 表格 + $ / $$ 公式 */
export function DocumentMarkdown({ content }: { content: string }) {
  return (
    <div className="kh-md kh-doc">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeRaw,
          rehypeSanitize,
          [rehypeKatex, { throwOnError: false, strict: 'ignore' }],
        ]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  )
}
