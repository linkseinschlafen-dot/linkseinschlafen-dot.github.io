-- D1 Schema — AI视频资产管理
CREATE TABLE IF NOT EXISTS assets (
  id              TEXT PRIMARY KEY,
  type            TEXT NOT NULL,          -- 场景 / 人物 / 道具
  name            TEXT NOT NULL,          -- 资产名称
  owner           TEXT NOT NULL,          -- 负责人
  note            TEXT DEFAULT '',        -- 备注
  file_name       TEXT,                   -- 原始文件名
  file_size       TEXT,                   -- 可读大小
  file_size_bytes INTEGER,               -- 字节大小
  file_ext        TEXT,                   -- 文件扩展名
  r2_key          TEXT,                   -- R2 存储路径
  created_at      TEXT NOT NULL           -- 创建时间 ISO8601
);

CREATE INDEX IF NOT EXISTS idx_assets_type ON assets(type);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);
