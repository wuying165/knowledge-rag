import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, List, Space, Tag, Typography, message } from 'antd'
import { notificationApi } from '../api'
import { ApiError } from '../api/client'
import type { NotificationItem } from '../types'
import { formatTime } from '../utils'

const TYPE_LABEL: Record<string, string> = {
  like: '点赞',
  comment: '评论',
  system: '站内',
}

export default function NotificationsPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<NotificationItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 20

  async function load(nextPage = page) {
    try {
      const res = await notificationApi.list(nextPage, pageSize)
      setItems(res.items)
      setTotal(res.total)
      setPage(nextPage)
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    }
  }

  useEffect(() => {
    void load(1)
  }, [])

  async function open(item: NotificationItem) {
    try {
      if (!item.isRead) {
        await notificationApi.markRead(item.id)
        setItems((prev) => prev.map((row) => (row.id === item.id ? { ...row, isRead: true } : row)))
      }
    } catch {
      // 已读失败仍允许跳转
    }
    if (item.documentId) navigate(`/documents/${item.documentId}`)
  }

  return (
    <div className="kh-page">
      <Space style={{ marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>通知</h2>
        <Button
          onClick={async () => {
            try {
              await notificationApi.markAllRead()
              setItems((prev) => prev.map((row) => ({ ...row, isRead: true })))
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : '操作失败')
            }
          }}
        >
          全部已读
        </Button>
      </Space>
      <List
        dataSource={items}
        pagination={{ current: page, pageSize, total, onChange: (p) => void load(p) }}
        locale={{ emptyText: '暂无通知' }}
        renderItem={(item) => (
          <List.Item
            style={{ cursor: item.documentId ? 'pointer' : 'default', background: item.isRead ? undefined : '#f6ffed' }}
            onClick={() => void open(item)}
          >
            <List.Item.Meta
              title={
                <Space>
                  {!item.isRead ? <Tag color="green">未读</Tag> : null}
                  <Tag>{TYPE_LABEL[item.type] || item.type}</Tag>
                  <span>{item.title}</span>
                </Space>
              }
              description={
                <div>
                  {item.content ? <div>{item.content}</div> : null}
                  <Typography.Text type="secondary">
                    {item.senderName ? `${item.senderName} · ` : ''}
                    {formatTime(item.createdAt)}
                  </Typography.Text>
                </div>
              }
            />
          </List.Item>
        )}
      />
    </div>
  )
}
