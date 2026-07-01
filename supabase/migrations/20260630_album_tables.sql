-- ============================================================
-- すくすくかるがもアルバム：テーブル定義
-- ============================================================

-- ===== 生徒テーブル =====
CREATE TABLE IF NOT EXISTS students (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  joined_at  DATE,
  photo_path TEXT,               -- Supabaseストレージのパス
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE students ENABLE ROW LEVEL SECURITY;

-- 自分の生徒のみ操作可能
CREATE POLICY "students_owner" ON students
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ===== レッスン記録テーブル =====
CREATE TABLE IF NOT EXISTS lesson_records (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  memo        TEXT,
  recorded_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE lesson_records ENABLE ROW LEVEL SECURITY;

-- 生徒を所有するユーザーのみ操作可能
CREATE POLICY "lesson_records_owner" ON lesson_records
  USING (
    student_id IN (SELECT id FROM students WHERE user_id = auth.uid())
  )
  WITH CHECK (
    student_id IN (SELECT id FROM students WHERE user_id = auth.uid())
  );

-- ===== 記録写真テーブル =====
CREATE TABLE IF NOT EXISTS record_photos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  record_id    UUID NOT NULL REFERENCES lesson_records(id) ON DELETE CASCADE,
  storage_path TEXT NOT NULL,    -- Supabaseストレージのパス
  sort_order   INTEGER DEFAULT 0,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE record_photos ENABLE ROW LEVEL SECURITY;

-- 生徒を所有するユーザーのみ操作可能
CREATE POLICY "record_photos_owner" ON record_photos
  USING (
    record_id IN (
      SELECT lr.id FROM lesson_records lr
      JOIN students s ON s.id = lr.student_id
      WHERE s.user_id = auth.uid()
    )
  )
  WITH CHECK (
    record_id IN (
      SELECT lr.id FROM lesson_records lr
      JOIN students s ON s.id = lr.student_id
      WHERE s.user_id = auth.uid()
    )
  );

-- ===== アルバムテーブル =====
CREATE TABLE IF NOT EXISTS albums (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  title        TEXT NOT NULL DEFAULT '',
  is_finalized BOOLEAN DEFAULT FALSE,
  share_token  TEXT UNIQUE,      -- NULLのとき共有なし
  finalized_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE albums ENABLE ROW LEVEL SECURITY;

-- オーナーは全操作可能
CREATE POLICY "albums_owner" ON albums
  USING (
    student_id IN (SELECT id FROM students WHERE user_id = auth.uid())
  )
  WITH CHECK (
    student_id IN (SELECT id FROM students WHERE user_id = auth.uid())
  );

-- share_tokenが設定された確定済みアルバムは誰でも閲覧可能（共有ページ用）
CREATE POLICY "albums_public_share" ON albums
  FOR SELECT
  USING (share_token IS NOT NULL AND is_finalized = TRUE);

-- ===== アルバム写真テーブル（編集結果） =====
CREATE TABLE IF NOT EXISTS album_photos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  album_id    UUID NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  photo_id    UUID REFERENCES record_photos(id) ON DELETE SET NULL,
  -- 非正規化（共有ページの高速表示用）
  storage_path TEXT,
  memo         TEXT,
  recorded_at  DATE,
  sort_order   INTEGER DEFAULT 0,
  is_excluded  BOOLEAN DEFAULT FALSE,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE album_photos ENABLE ROW LEVEL SECURITY;

-- オーナーは全操作可能
CREATE POLICY "album_photos_owner" ON album_photos
  USING (
    album_id IN (
      SELECT a.id FROM albums a
      JOIN students s ON s.id = a.student_id
      WHERE s.user_id = auth.uid()
    )
  )
  WITH CHECK (
    album_id IN (
      SELECT a.id FROM albums a
      JOIN students s ON s.id = a.student_id
      WHERE s.user_id = auth.uid()
    )
  );

-- 共有アルバムの写真は誰でも閲覧可能
CREATE POLICY "album_photos_public_share" ON album_photos
  FOR SELECT
  USING (
    album_id IN (
      SELECT id FROM albums WHERE share_token IS NOT NULL AND is_finalized = TRUE
    )
  );

-- ============================================================
-- ストレージバケット設定
-- ⚠️ 以下を Supabase ダッシュボード → SQL Editor で実行してください
-- ============================================================

-- バケット作成（公開バケット：共有ページで直接URL参照するため）
INSERT INTO storage.buckets (id, name, public)
VALUES ('album-photos', 'album-photos', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- ストレージRLSを有効化
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

-- 認証ユーザーはアップロード可能
CREATE POLICY "album_photos_insert" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'album-photos');

-- 全ユーザーが読み取り可能（共有ページ・公開アルバム用）
CREATE POLICY "album_photos_select" ON storage.objects
  FOR SELECT
  USING (bucket_id = 'album-photos');

-- 認証ユーザーは削除可能
CREATE POLICY "album_photos_delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'album-photos');

-- 認証ユーザーは更新可能（upsert対応）
CREATE POLICY "album_photos_update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'album-photos')
  WITH CHECK (bucket_id = 'album-photos');

-- ============================================================
-- albumsテーブルへの追加列（既存テーブルに追加する場合）
-- ============================================================
ALTER TABLE albums ADD COLUMN IF NOT EXISTS accent_color    TEXT DEFAULT '#4a7c6f';
ALTER TABLE albums ADD COLUMN IF NOT EXISTS text_color      TEXT DEFAULT '#3d2b1f';
ALTER TABLE albums ADD COLUMN IF NOT EXISTS photos_per_page INTEGER DEFAULT 2;

-- ============================================================
-- アカウント自己削除用RPC（Edge Functionなしで削除できるよう）
-- ============================================================
CREATE OR REPLACE FUNCTION delete_own_account()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  DELETE FROM auth.users WHERE id = auth.uid();
END;
$$;

-- ============================================================
-- profilesテーブルへのtier列追加（既存テーブルに追加する場合）
-- ============================================================
-- ALTER TABLE profiles ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'free';
-- ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;
-- ALTER TABLE profiles ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT;
-- ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT FALSE;
