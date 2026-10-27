import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Button, Card, Form, Input, Spin, Typography, message } from 'antd'
import { shareApi } from '../api'
import { ApiError } from '../api/client'
import { DocumentMarkdown } from '../components/DocumentMarkdown'
import { BrandLogo } from '../components/BrandLogo'

export default function SharePage() {
  const { code = '' } = useParams()
  const [title, setTitle] = useState('')
  const [needPassword, setNeedPassword] = useState(false)
  const [content, setContent] = useState<string | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    shareApi
      .preview(code)
      .then(async (preview) => {
        setTitle(preview.title)
        setNeedPassword(preview.needPassword)
        if (!preview.needPassword) {
          const doc = await shareApi.access(code)
          setContent(doc.content)
          setSummary(doc.summary ?? null)
        }
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : '分享不可用')
      })
      .finally(() => setLoading(false))
  }, [code])

  return (
    <div className="kh-login">
      <Card className="kh-login-card" style={{ width: 860, maxWidth: '92vw' }}>
        <div className="kh-login-title">
          <BrandLogo size={36} />
          <h1>{title || '文档分享'}</h1>
        </div>
        {loading ? <Spin /> : null}
        {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
        {!loading && needPassword && content == null && !error ? (
          <Form
            layout="vertical"
            onFinish={async (values: { password: string }) => {
              try {
                const doc = await shareApi.access(code, values.password)
                setTitle(doc.title)
                setSummary(doc.summary ?? null)
                setContent(doc.content)
              } catch (err) {
                message.error(err instanceof ApiError ? err.message : '无法打开')
              }
            }}
          >
            <Form.Item name="password" label="访问密码" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
            <Button type="primary" htmlType="submit">
              打开
            </Button>
          </Form>
        ) : null}
        {content != null ? (
          <>
            {summary ? <Typography.Paragraph type="secondary">{summary}</Typography.Paragraph> : null}
            <DocumentMarkdown content={content} />
          </>
        ) : null}
      </Card>
    </div>
  )
}
