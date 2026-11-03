create table if not exists dropship_files (
  file_id text primary key,
  file_name text,
  file_type text,
  fetched_at timestamptz default now(),
  bytes int,
  content_type text,
  pdf_b64 text,
  note text
);
alter table dropship_files enable row level security;
create policy "auth read files" on dropship_files for select to authenticated using (true);
