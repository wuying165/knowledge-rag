import { useEffect, useState } from 'react'
import { Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Table, message } from 'antd'
import { categoryApi } from '../../api'
import { ApiError } from '../../api/client'
import type { CategoryNode } from '../../types'
import { flattenCategories } from '../../utils'

function stripEmpty(nodes: CategoryNode[]): CategoryNode[] {
  return nodes.map((node) => {
    const children = node.children?.length ? stripEmpty(node.children) : undefined
    return { ...node, children }
  })
}

export default function CategoriesPage() {
  const [tree, setTree] = useState<CategoryNode[]>([])
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<CategoryNode | null>(null)
  const [form] = Form.useForm()

  async function load() {
    try {
      setTree(await categoryApi.tree())
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : '加载失败')
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const parentOptions = flattenCategories(tree)
    .filter((item) => item.id !== editing?.id)
    .map((item) => ({ value: item.id, label: item.label }))

  return (
    <div className="kh-page">
      <Button
        type="primary"
        style={{ marginBottom: 16 }}
        onClick={() => {
          setEditing(null)
          form.resetFields()
          setOpen(true)
        }}
      >
        新建分类
      </Button>
      <Table
        rowKey="id"
        dataSource={stripEmpty(tree)}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '排序', dataIndex: 'sort', width: 80 },
          { title: '说明', dataIndex: 'description', render: (v?: string) => v || '-' },
          {
            title: '操作',
            width: 180,
            render: (_: unknown, row: CategoryNode) => (
              <>
                <a
                  onClick={() => {
                    setEditing(row)
                    form.setFieldsValue({
                      name: row.name,
                      parentId: row.parentId && row.parentId !== '0' ? row.parentId : undefined,
                      sort: row.sort,
                      description: row.description,
                    })
                    setOpen(true)
                  }}
                >
                  编辑
                </a>
                <Popconfirm
                  title="确认删除该分类？"
                  onConfirm={async () => {
                    try {
                      await categoryApi.remove(row.id)
                      message.success('已删除')
                      void load()
                    } catch (error) {
                      message.error(error instanceof ApiError ? error.message : '删除失败')
                    }
                  }}
                >
                  <a style={{ marginLeft: 12 }}>删除</a>
                </Popconfirm>
              </>
            ),
          },
        ]}
      />
      <Modal
        title={editing ? '编辑分类' : '新建分类'}
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => form.submit()}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={async (values: {
            name: string
            parentId?: string
            sort?: number
            description?: string
          }) => {
            try {
              const body = {
                name: values.name,
                parentId: values.parentId || '0',
                sort: values.sort ?? 0,
                description: values.description,
              }
              if (editing) await categoryApi.update(editing.id, body)
              else await categoryApi.create(body)
              message.success('已保存')
              setOpen(false)
              void load()
            } catch (error) {
              message.error(error instanceof ApiError ? error.message : '保存失败')
            }
          }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="parentId" label="上级分类">
            <Select allowClear placeholder="不选则为一级分类" options={parentOptions} />
          </Form.Item>
          <Form.Item name="sort" label="排序">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
