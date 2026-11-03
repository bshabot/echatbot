alter table dropship_jobs
  add column if not exists detail jsonb,
  add column if not exists customer_order_number text,
  add column if not exists os_status text,
  add column if not exists os_substatus text;
