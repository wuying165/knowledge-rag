import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button, Table, Tag, message } from 'antd'
import { documentApi, favoriteApi } from '../api'
import { ApiError } from '../api/client'
import type { DocumentItem } from '../types'
import { DOC_STATUS, formatTime, visibilityMeta } from '../utils'

export default function FavoritesPage() {
  const navigate = useNavigate()
  const [items, setItems] = useState<DocumentItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const pageSize = 10

  async function load(nextPage = page) {
    try {
      const res = await favoriteApi.list(nextPage, pageSize)
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

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>我的收藏</h2>
      <Table
        rowKey="id"
        dataSource={items}
        pagination={{ current: page, pageSize, total, onChange: (p) => void load(p) }}
        columns={[
          {
            title: '标题',
            dataIndex: 'title',
            render: (value: string, row: DocumentItem) => (
              <a onClick={() => navigate(`/documents/${row.id}`)}>{value}</a>
            ),
          },
          {
            title: '状态',
            dataIndex: 'status',
            width: 100,
            render: (s: number) => <Tag color={DOC_STATUS[s]?.color}>{DOC_STATUS[s]?.label}</Tag>,
          },
          {
            title: '可见性',
            width: 110,
            render: (_: unknown, row: DocumentItem) => {
              const vis = visibilityMeta(row)
              return <Tag color={vis.color}>{vis.label}</Tag>
            },
          },
          { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: formatTime },
          {
            title: '操作',
            width: 100,
            render: (_: unknown, row: DocumentItem) => (
              <Button
                type="link"
                onClick={async () => {
                  try {
                    await documentApi.toggleFavorite(row.id)
                    message.success('已取消收藏')
                    void load()
                  } catch (error) {
                    message.error(error instanceof ApiError ? error.message : '操作失败')
                  }
                }}
              >
                取消收藏
              </Button>
            ),
          },
        ]}
      />
    </div>
  )
}
