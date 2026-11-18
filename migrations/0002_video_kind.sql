-- 0002 视频分类（已应用到线上 schema 7，migration 01a10b33-8c83-71b4-ad65-0d7597cbb0d6）
--
-- 平台只允许受限 DDL：不能写 NOT NULL / DEFAULT / CHECK。所以 kind 建成可空，
-- "没填就是真实教学"由函数判定（functions/catalog.mjs 的 kindInput），
-- 取值白名单也在那里，不指望数据库约束。
ALTER TABLE app.videos ADD COLUMN kind text;
CREATE INDEX videos_kind_idx ON app.videos (kind);
