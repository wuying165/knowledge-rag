import { useEffect, useState } from 'react'
import { Button, Form, Input, Select, message } from 'antd'
import { notificationApi, userApi } from '../../api'
import { ApiError } from '../../api/client'
import type { UserVO } from '../../types'

export default function BroadcastPage() {
  const [users, setUsers] = useState<UserVO[]>([])
  const [form] = Form.useForm()

  useEffect(() => {
    userApi
      .page({ page: 1, pageSize: 100, status: 1 })
      .then((res) => setUsers(res.items))
      .catch(() => undefined)
  }, [])

  return (
    <div className="kh-page">
      <h2 style={{ marginTop: 0 }}>发送站内通知</h2>
      <p className="kh-access-hint">不选接收人时，发给所有启用中的用户。</p>
      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 640 }}
        onFinish={async (values: { title: string; content: string; userIds?: string[] }) => {
          try {
            const res = await notificationApi.broadcast({
              title: values.title,
              content: values.content,
              userIds: values.userIds?.length ? values.userIds : undefined,
            })
            message.success(`已发送给 ${res.count} 人`)
            form.resetFields()
          } catch (error) {
            message.error(error instanceof ApiError ? error.message : '发送失败')
          }
        }}
      >
        <Form.Item name="title" label="标题" rules={[{ required: true, message: '请填写标题' }]}>
          <Input maxLength={100} />
        </Form.Item>
        <Form.Item name="content" label="内容" rules={[{ required: true, message: '请填写内容' }]}>
          <Input.TextArea rows={5} maxLength={2000} />
        </Form.Item>
        <Form.Item name="userIds" label="接收人">
          <Select
            mode="multiple"
            allowClear
            placeholder="不选则发给所有人"
            optionFilterProp="label"
            options={users.map((user) => ({
              value: user.id,
              label: user.realName ? `${user.realName}（${user.username}）` : user.username,
            }))}
          />
        </Form.Item>
        <Button type="primary" htmlType="submit">
          发送
        </Button>
      </Form>
    </div>
  )
}
