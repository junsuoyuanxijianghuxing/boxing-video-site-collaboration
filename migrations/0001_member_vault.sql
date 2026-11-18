-- 会员制加密视频站：初始结构
-- 目标：Qoder Sites 托管数据库（Supabase/PostgreSQL），表建在 app schema。
-- 迁移接口只接受受限子集：CREATE TABLE / ALTER TABLE ADD COLUMN / 普通 CREATE INDEX；
-- 不允许 DEFAULT、CHECK、外键、生成列、数组和 varchar(n)。所有 id、时间戳和签名都由 Function 写入。
CREATE TABLE app.users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text,
  pw_cipher text,
  created_at timestamptz NOT NULL,
  disabled_at timestamptz,
  last_login_at timestamptz,
  failed_count integer,
  locked_until timestamptz,
  contact_qq text,
  note text
);
CREATE INDEX users_created_idx ON app.users (created_at);

CREATE TABLE app.sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  device_label text,
  ua_hash text,
  ip_prefix text
);
CREATE INDEX sessions_user_idx ON app.sessions (user_id);

CREATE TABLE app.plans (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  tier_rank integer NOT NULL,
  price_cents integer,
  price_text text,
  duration_days integer,
  description text,
  enabled boolean,
  sort_order integer,
  created_at timestamptz,
  signature text
);

CREATE TABLE app.keys (
  id uuid PRIMARY KEY,
  code_cipher text,
  code_tail text,
  fingerprint text UNIQUE,
  plan_id uuid,
  batch_id uuid,
  status text,
  created_at timestamptz,
  created_by uuid,
  expires_at timestamptz,
  redeemed_user_id uuid,
  redeemed_at timestamptz,
  note text
);
CREATE INDEX keys_status_idx ON app.keys (status);
CREATE INDEX keys_batch_idx ON app.keys (batch_id);

CREATE TABLE app.memberships (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  plan_id uuid NOT NULL,
  tier_rank integer NOT NULL,
  source text,
  key_id uuid UNIQUE,
  starts_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz,
  revoked_at timestamptz,
  signature text
);
CREATE INDEX memberships_user_idx ON app.memberships (user_id);
CREATE INDEX memberships_expiry_idx ON app.memberships (expires_at);

CREATE TABLE app.videos (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text,
  object_prefix text NOT NULL,
  content_type text NOT NULL,
  plain_size bigint,
  enc_size bigint,
  chunk_size integer,
  chunk_total integer,
  duration_seconds integer,
  preview_seconds integer,
  tier_rank integer,
  key_cipher text,
  cipher_version text,
  faststart boolean,
  status text NOT NULL,
  published_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  poster_path text,
  access_signature text
);
CREATE INDEX videos_status_idx ON app.videos (status);
CREATE INDEX videos_published_idx ON app.videos (published_at);

CREATE TABLE app.requests (
  id uuid PRIMARY KEY,
  email text,
  plan_id uuid,
  note text,
  contact_qq text,
  status text,
  created_at timestamptz,
  updated_at timestamptz,
  handled_by uuid,
  batch_id uuid
);
CREATE INDEX requests_status_idx ON app.requests (status);
CREATE INDEX requests_created_idx ON app.requests (created_at);

CREATE TABLE app.watch_logs (
  id uuid PRIMARY KEY,
  user_id uuid,
  video_id uuid,
  session_id uuid,
  access_mode text,
  position_seconds integer,
  created_at timestamptz,
  updated_at timestamptz
);
CREATE INDEX watch_logs_video_idx ON app.watch_logs (video_id);
CREATE INDEX watch_logs_user_idx ON app.watch_logs (user_id);

CREATE TABLE app.settings (
  id uuid PRIMARY KEY,
  config_key text NOT NULL UNIQUE,
  value jsonb,
  updated_at timestamptz,
  signature text
);

CREATE TABLE app.audit (
  id uuid PRIMARY KEY,
  actor_id uuid,
  action text,
  target text,
  ip_prefix text,
  created_at timestamptz,
  detail jsonb
);
CREATE INDEX audit_created_idx ON app.audit (created_at);
CREATE INDEX audit_action_idx ON app.audit (action);
