-- アルバム作成アクション（PDFダウンロード・共有URLコピー）の使用ログ
CREATE TABLE IF NOT EXISTS usage_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  action     TEXT NOT NULL,  -- 'pdf_download' | 'share_copy'
  album_id   UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_logs_owner" ON usage_logs
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());
