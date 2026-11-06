-- Supabase > SQL Editor で実行（初回のみ）
create table if not exists public.stageflow_showcases (
  id uuid primary key,
  title text not null,
  content jsonb not null,
  edit_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists stageflow_showcases_updated_idx on public.stageflow_showcases(updated_at desc);
alter table public.stageflow_showcases enable row level security;
revoke all on table public.stageflow_showcases from anon, authenticated;
grant select, insert, update on table public.stageflow_showcases to service_role;
-- ブラウザからDBへ直接アクセスさせず、必ず Vercel API で認可します。

-- Storage > New bucket から private bucket stageflow-audio を作成してください。
-- ファイルサイズ上限 50MB、MIME type audio/mpeg に設定。
-- service_role 経由のAPIだけが署名付きアップロード/ダウンロードURLを発行します。
