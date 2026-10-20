-- Estado da pelada: uma única linha (id = 1) com todo o JSON do sistema.
-- "version" faz o controle otimista de concorrência (duas ações ao mesmo tempo não se sobrescrevem).
create table if not exists public.pelada_state (
  id         int primary key check (id = 1),
  data       jsonb not null,
  version    int not null default 0,
  updated_at timestamptz not null default now()
);

-- A tabela guarda o nível dos jogadores e o segredo do login do admin, então NINGUÉM lê pelo navegador:
-- RLS ligado e nenhuma policy. Só a função do Netlify acessa, com a chave service_role (que ignora o RLS).
alter table public.pelada_state enable row level security;
revoke all on public.pelada_state from anon, authenticated;
