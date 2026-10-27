import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Button, Empty, List, Space, Spin, Typography, message } from 'antd'
import { documentApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentVersion } from '../types'
import { DocumentMarkdown } from '../components/DocumentMarkdown'
import { formatTime } from '../utils'

export default function DocumentVersionsPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const [items, setItems] = useState<DocumentVersion[]>([])
  const [current, setCurrent] = useState<DocumentVersion | null>(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    setLoading(true)
    try {
      const rows = await documentApi.versions(id)
      setItems(rows)
      setCurrent(rows[0] ?? null)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [id])

  if (loading) {
    return (
      <div className="kh-page">
        <Spin />
      </div>
    )
  }

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }}>
        <Button onClick={() => navigate(`/documents/${id}`)}>返回文档</Button>
      </Space>
      <h2 style={{ marginTop: 0 }}>历史版本</h2>
      <p className="kh-access-hint">回滚会把选中版本的正文写成一条新版本，原来的记录仍保留。</p>
      {!items.length ? <Empty description="还没有版本记录。编辑并保存正文后会出现在这里。" /> : null}
      <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
        <List
          style={{ width: 280, flex: 'none' }}
          dataSource={items}
          renderItem={(item) => (
            <List.Item
              style={{
                cursor: 'pointer',
                background: current?.id === item.id ? '#f5f5f5' : undefined,
              }}
              onClick={() => setCurrent(item)}
            >
              <div>
                <div>v{item.version} {item.title}</div>
                <Typography.Text type="secondary">{formatTime(item.createdAt)}</Typography.Text>
              </div>
            </List.Item>
          )}
        />
        {current ? (
          <div style={{ flex: 1, minWidth: 0 }}>
            <Space style={{ marginBottom: 12 }}>
              <Typography.Text strong>{current.title}</Typography.Text>
              <Button
                type="primary"
                onClick={async () => {
                  try {
                    await documentApi.restoreVersion(id, current.id)
                    message.success('已回滚为新版本')
                    void load()
                  } catch (error) {
                    message.error(error instanceof ApiError ? error.message : '回滚失败')
                  }
                }}
              >
                回滚到此版本
              </Button>
            </Space>
            <DocumentMarkdown content={current.content || ''} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
