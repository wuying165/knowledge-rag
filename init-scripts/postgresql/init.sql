-- 文档元数据表
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    content_id VARCHAR NOT NULL UNIQUE,
    summary VARCHAR,
    category_id BIGINT,
    team_id BIGINT,
    author_id BIGINT,
    cover_image VARCHAR,
    tags VARCHAR,
    status SMALLINT NOT NULL DEFAULT 0,
    remark VARCHAR,
    view_count INT NOT NULL DEFAULT 0,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favourite_count INT NOT NULL DEFAULT 0,
    word_count INT NOT NULL DEFAULT 0,
    publish_time TIMESTAMP,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- 文档发布审核记录
-- 一次「提交审核」一行；approve/reject 后 review_result 非空，不再出现在待办列表
CREATE TABLE IF NOT EXISTS kh_document_review (
    id BIGINT PRIMARY KEY,                          -- 审核记录 ID（雪花）
    document_id BIGINT NOT NULL,                    -- 被审文档 ID → kh_document.id
    reviewer_id BIGINT,                             -- 审核人 ID；待审时为 NULL
    reviewer_name VARCHAR,                          -- 审核人姓名
    review_result SMALLINT,                         -- NULL=待审 1=通过 2=驳回
    review_comment VARCHAR,                         -- 审核意见（驳回必填）
    before_status SMALLINT NOT NULL,                -- 提审前文档 status（0 草稿 / 1 已发布）
    reviewed_at TIMESTAMP,                          -- 审核完成时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW()     -- 提交审核时间
);
-- 按文档查审核历史
CREATE INDEX IF NOT EXISTS idx_kh_document_review_document_id ON kh_document_review(document_id);
-- 待办列表：仅 review_result IS NULL 的行
CREATE INDEX IF NOT EXISTS idx_kh_document_review_pending ON kh_document_review(review_result) WHERE review_result IS NULL;

-- ==================== 用户与角色 ====================

CREATE TABLE IF NOT EXISTS kh_user (
    id BIGINT PRIMARY KEY,                          -- 用户 ID（雪花）
    username VARCHAR(50) NOT NULL,                  -- 登录用户名
    password VARCHAR(255) NOT NULL,                 -- 密码（bcrypt 哈希）
    email VARCHAR(100),                             -- 邮箱（可选）
    real_name VARCHAR(50),                          -- 真实姓名 / 显示名
    avatar VARCHAR(500),                            -- 头像 URL
    email_verified SMALLINT NOT NULL DEFAULT 1,     -- 0 未验证 1 已验证
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    last_login_at TIMESTAMP,                        -- 最后登录时间
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 创建时间
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 更新时间
    deleted BOOLEAN NOT NULL DEFAULT false          -- 软删除标记
);
-- 未删除用户名唯一
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_username ON kh_user(username) WHERE deleted = false;

CREATE TABLE IF NOT EXISTS kh_role (
    id BIGINT PRIMARY KEY,                          -- 角色 ID（雪花）
    role_name VARCHAR(50) NOT NULL,                 -- 角色名称（展示用）
    role_code VARCHAR(50) NOT NULL UNIQUE,          -- 角色编码，如 ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER
    description VARCHAR(200),                     -- 角色描述
    status SMALLINT NOT NULL DEFAULT 1              -- 0 禁用 1 启用
);

CREATE TABLE IF NOT EXISTS kh_user_role (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    user_id BIGINT NOT NULL REFERENCES kh_user(id), -- 用户 ID
    role_id BIGINT NOT NULL REFERENCES kh_role(id), -- 角色 ID
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 分配时间
    UNIQUE (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_user_role_user_id ON kh_user_role(user_id);

-- 预置角色
INSERT INTO kh_role (id, role_name, role_code, description) VALUES
    (2000000000000000001, '管理员', 'ROLE_ADMIN', '系统管理'),
    (2000000000000000002, '审核员', 'ROLE_REVIEWER', '文档审核'),
    (2000000000000000003, '普通用户', 'ROLE_USER', '默认角色')
ON CONFLICT (id) DO NOTHING;

-- 测试账号（密码均为 123456，bcrypt）
INSERT INTO kh_user (id, username, password, email, real_name, status) VALUES
    (1000000000000000001, 'admin', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'admin@company.com', '系统管理员', 1),
    (1000000000000000002, 'reviewer', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'reviewer@company.com', '审核员张三', 1),
    (1000000000000000003, 'user', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'user@company.com', '普通用户李四', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_user_role (id, user_id, role_id) VALUES
    (3000000000000000001, 1000000000000000001, 2000000000000000001),  -- admin → 管理员
    (3000000000000000002, 1000000000000000001, 2000000000000000002),  -- admin → 审核员
    (3000000000000000003, 1000000000000000002, 2000000000000000002),  -- reviewer → 审核员
    (3000000000000000004, 1000000000000000003, 2000000000000000003)   -- user → 普通用户
ON CONFLICT (id) DO NOTHING;

-- ==================== 权限 RBAC ====================

CREATE TABLE IF NOT EXISTS kh_permission (
    id BIGINT PRIMARY KEY,                          -- 权限 ID（雪花）
    parent_id BIGINT NOT NULL DEFAULT 0,            -- 父权限 ID，0 为根
    permission_name VARCHAR(50) NOT NULL,           -- 权限名称
    permission_code VARCHAR(100) NOT NULL UNIQUE,   -- 权限编码（运行时校验）
    permission_type SMALLINT NOT NULL,              -- 1 菜单 2 按钮 3 接口
    menu_url VARCHAR(200),                          -- 菜单路径
    api_url VARCHAR(500),                           -- 接口 URL 模式
    method VARCHAR(10),                             -- HTTP 方法
    icon VARCHAR(50),                               -- 图标
    sort INT NOT NULL DEFAULT 0,
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS kh_role_permission (
    id BIGINT PRIMARY KEY,
    role_id BIGINT NOT NULL REFERENCES kh_role(id),
    permission_id BIGINT NOT NULL REFERENCES kh_permission(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS kh_user_permission (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES kh_user(id),
    permission_id BIGINT NOT NULL REFERENCES kh_permission(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, permission_id)
);

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, icon, sort) VALUES
    (4000000000000000001, 0, '首页', 'dashboard', 1, '/dashboard', 'DashboardOutlined', 1),
    (4000000000000000002, 0, '文档中心', 'document', 1, '/documents', 'FileTextOutlined', 2),
    (4000000000000000003, 0, '搜索', 'search', 1, '/search', 'SearchOutlined', 3),
    (4000000000000000004, 0, '个人中心', 'profile', 1, '/profile', 'UserOutlined', 4),
    (4000000000000000005, 0, '系统管理', 'system', 1, '/admin', 'SettingOutlined', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000011, 4000000000000000002, '文档列表', 'document:list', 2, 1),
    (4000000000000000012, 4000000000000000002, '创建文档', 'document:create', 2, 2),
    (4000000000000000013, 4000000000000000002, '编辑文档', 'document:edit', 2, 3),
    (4000000000000000014, 4000000000000000002, '删除文档', 'document:delete', 2, 4),
    (4000000000000000015, 4000000000000000002, '文档审核', 'document:review', 2, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, sort) VALUES
    (4000000000000000021, 4000000000000000005, '用户管理', 'system:user', 1, '/admin/users', 1),
    (4000000000000000022, 4000000000000000005, '角色管理', 'system:role', 1, '/admin/roles', 2),
    (4000000000000000023, 4000000000000000005, '权限管理', 'system:permission', 1, '/admin/permissions', 3),
    (4000000000000000024, 4000000000000000005, '团队管理', 'system:team', 1, '/admin/teams', 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000041, 4000000000000000023, '新增权限', 'system:permission:create', 2, 1),
    (4000000000000000042, 4000000000000000023, '编辑权限', 'system:permission:edit', 2, 2),
    (4000000000000000043, 4000000000000000023, '删除权限', 'system:permission:delete', 2, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000001, 2000000000000000002, 4000000000000000011),
    (4100000000000000002, 2000000000000000002, 4000000000000000015),
    (4100000000000000003, 2000000000000000003, 4000000000000000001),
    (4100000000000000004, 2000000000000000003, 4000000000000000002),
    (4100000000000000005, 2000000000000000003, 4000000000000000011),
    (4100000000000000006, 2000000000000000003, 4000000000000000012),
    (4100000000000000007, 2000000000000000003, 4000000000000000003),
    (4100000000000000008, 2000000000000000003, 4000000000000000004),
    (4100000000000000009, 2000000000000000003, 4000000000000000013),
    (4100000000000000010, 2000000000000000003, 4000000000000000014),
    (4100000000000000011, 2000000000000000002, 4000000000000000003)
ON CONFLICT (id) DO NOTHING;

-- ==================== 团队 ====================

CREATE TABLE IF NOT EXISTS kh_team (
    id BIGINT PRIMARY KEY,                          -- 团队 ID（雪花）
    team_name VARCHAR(100) NOT NULL,                -- 团队名称
    team_code VARCHAR(50),                          -- 团队编码
    description VARCHAR(500),                       -- 描述
    leader_id BIGINT,                               -- 负责人 → kh_user.id
    parent_id BIGINT NOT NULL DEFAULT 0,            -- 父团队 ID，0 为根
    sort INT NOT NULL DEFAULT 0,                    -- 排序
    status SMALLINT NOT NULL DEFAULT 1,             -- 0 禁用 1 启用
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_team_parent_id ON kh_team(parent_id);

CREATE TABLE IF NOT EXISTS kh_team_member (
    id BIGINT PRIMARY KEY,                          -- 关联 ID（雪花）
    team_id BIGINT NOT NULL REFERENCES kh_team(id),
    user_id BIGINT NOT NULL REFERENCES kh_user(id),
    member_role VARCHAR(20) NOT NULL DEFAULT 'member', -- leader / member
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_team_member_user_id ON kh_team_member(user_id);

INSERT INTO kh_team (id, team_name, team_code, description, leader_id, parent_id, sort) VALUES
    (8000000000000000001, '技术中心', 'TECH_CENTER', '研发与技术团队', 1000000000000000001, 0, 1),
    (8000000000000000002, '后端开发组', 'BACKEND_TEAM', '后端开发', 1000000000000000001, 8000000000000000001, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_team_member (id, team_id, user_id, member_role) VALUES
    (9000000000000000001, 8000000000000000001, 1000000000000000001, 'leader'),
    (9000000000000000002, 8000000000000000002, 1000000000000000001, 'leader'),
    (9000000000000000003, 8000000000000000002, 1000000000000000003, 'member')
ON CONFLICT (id) DO NOTHING;

-- ==================== AI 会话 ====================

CREATE TABLE IF NOT EXISTS kh_ai_session (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    title VARCHAR(80) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_ai_session_user_updated
    ON kh_ai_session(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kh_ai_message (
    id BIGINT PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES kh_ai_session(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    sources JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_ai_message_session_id
    ON kh_ai_message(session_id, created_at);

-- ==================== 分类 / 互动 / 分享 / 版本 ====================

CREATE TABLE IF NOT EXISTS kh_category (
    id BIGINT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    parent_id BIGINT NOT NULL DEFAULT 0,
    sort INT NOT NULL DEFAULT 0,
    description VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_category_parent ON kh_category(parent_id);

CREATE TABLE IF NOT EXISTS kh_comment (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    user_name VARCHAR(50) NOT NULL,
    content VARCHAR(2000) NOT NULL,
    parent_id BIGINT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_comment_document ON kh_comment(document_id);

CREATE TABLE IF NOT EXISTS kh_document_like (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, user_id)
);

CREATE TABLE IF NOT EXISTS kh_document_favorite (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_document_favorite_user ON kh_document_favorite(user_id);

-- 已发布文档的分享链接。过期或已关闭后不可访问
CREATE TABLE IF NOT EXISTS kh_document_share (
    id BIGINT PRIMARY KEY,                          -- 分享 ID（雪花）
    document_id BIGINT NOT NULL,                    -- 被分享文档 ID → kh_document.id
    token VARCHAR(64) NOT NULL UNIQUE,              -- 链接短码，全局唯一
    created_by BIGINT NOT NULL,                     -- 创建人 ID → kh_user.id
    expire_at TIMESTAMP,                            -- 过期时间；空表示不过期
    revoked BOOLEAN NOT NULL DEFAULT false,         -- 是否已关闭
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- 创建时间
    require_password BOOLEAN NOT NULL DEFAULT false,-- 创建时是否设置了密码
    password_hash VARCHAR(255)                      -- 密码 bcrypt 哈希；空表示无需密码
);
CREATE INDEX IF NOT EXISTS idx_kh_document_share_document ON kh_document_share(document_id);

CREATE TABLE IF NOT EXISTS kh_document_version (
    id BIGINT PRIMARY KEY,
    document_id BIGINT NOT NULL,
    version INT NOT NULL,
    title VARCHAR NOT NULL,
    content TEXT NOT NULL,
    summary VARCHAR,
    created_by BIGINT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS idx_kh_document_version_document
    ON kh_document_version(document_id, version DESC);

INSERT INTO kh_category (id, name, parent_id, sort, description) VALUES
    (7000000000000000001, '制度规范', 0, 1, '公司制度与流程'),
    (7000000000000000002, '技术文档', 0, 2, '设计、接口与实现说明'),
    (7000000000000000003, '操作手册', 0, 3, '操作步骤与排障')
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000016, 4000000000000000002, '分类管理', 'document:category', 2, 6),
    (4000000000000000019, 4000000000000000002, '分类查询', 'document:category:query', 2, 7),
    (4000000000000000017, 4000000000000000002, '文档版本', 'document:version', 2, 8)
ON CONFLICT (permission_code) DO NOTHING;

CREATE TABLE IF NOT EXISTS kh_notification (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    type VARCHAR(20) NOT NULL,
    title VARCHAR(100) NOT NULL,
    content VARCHAR(2000),
    document_id BIGINT,
    sender_id BIGINT,
    sender_name VARCHAR(50),
    is_read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_notification_user
    ON kh_notification(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_kh_notification_unread
    ON kh_notification(user_id) WHERE is_read = false;
