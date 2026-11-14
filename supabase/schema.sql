-- Controle de Cartões no Supabase.
-- Rode este arquivo inteiro uma vez em: Supabase → SQL Editor → New query → Run.
-- Pode rodar de novo depois de uma atualização do app: ele só cria o que falta e troca as funções.
--
-- Como os dados ficam:
--   * dados pessoais (o antigo dados.json): tabela `pessoal` (uma linha por usuário) e as tabelas
--     pessoas, cartoes, regras, faturas, lancamentos, divisoes, grupos, grupo_participantes,
--     grupo_pagamentos e cobrancas. Cada linha tem a coluna `dono` (o usuário do login) e o RLS
--     só deixa cada um ver e alterar as próprias linhas.
--   * casa e viagens (o antigo compartilhado.json): tabela `espacos` (um por casal), `espaco_usuarios`
--     (quem tem acesso) e membros, etapas, etapa_pagamentos, saldos, viagens e viagem_itens.
--   * o app lê e grava pelas funções carregar_pessoal/salvar_pessoal e carregar_comp/salvar_comp,
--     que trocam o conjunto inteiro numa transação e recusam a gravação (HTTP 409) se outro aparelho
--     salvou antes (coluna `revisao`).
--   * campos que o app venha a criar e que ainda não têm coluna própria ficam na coluna `extra`
--     (jsonb) da mesma linha, para nada se perder.

create schema if not exists privado;
grant usage on schema privado to authenticated, service_role;

-- ======================= conversão JSON -> colunas =======================
-- Cada função devolve NULL quando o valor não é do tipo esperado; nesse caso o valor original
-- fica guardado em `extra` (ver privado.resto), sem erro e sem perda.
create or replace function privado.txt(v jsonb) returns text language sql immutable as
$$ select case when jsonb_typeof(v) = 'string' then v #>> '{}' end $$;

create or replace function privado.num(v jsonb) returns numeric language sql immutable as
$$ select case when jsonb_typeof(v) = 'number' then (v #>> '{}')::numeric end $$;

create or replace function privado.int(v jsonb) returns int language sql immutable as
$$ select case when jsonb_typeof(v) = 'number' and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
                 and abs((v #>> '{}')::numeric) < 2147483647 then (v #>> '{}')::numeric::int end $$;

create or replace function privado.bool(v jsonb) returns boolean language sql immutable as
$$ select case when jsonb_typeof(v) = 'boolean' then (v #>> '{}')::boolean end $$;

create or replace function privado.obj(v jsonb) returns jsonb language sql immutable as
$$ select case when jsonb_typeof(v) = 'object' then v end $$;

create or replace function privado.lista(v jsonb) returns jsonb language sql immutable as
$$ select case when jsonb_typeof(v) = 'array' then v else '[]'::jsonb end $$;

-- Data no formato AAAA-MM-DD, e só se for uma data válida que volta igual ao texto.
create or replace function privado.data(v jsonb) returns date language plpgsql immutable as $$
declare s text := case when jsonb_typeof(v) = 'string' then v #>> '{}' end; d date;
begin
  if s is null or s !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  d := s::date;
  return case when to_char(d, 'YYYY-MM-DD') = s then d end;
exception when others then return null;
end $$;

-- {"n": 2, "total": 3} vira parcela_n/parcela_total; qualquer outro formato fica em extra.
create or replace function privado.parcela_ok(v jsonb) returns boolean language sql immutable as
$$ select jsonb_typeof(v) = 'object' and privado.int(v -> 'n') is not null and privado.int(v -> 'total') is not null
          and v = jsonb_build_object('n', privado.int(v -> 'n'), 'total', privado.int(v -> 'total')) $$;

create or replace function privado.cabe(v jsonb, tipo text) returns boolean language sql immutable as $$
  select case tipo
    when 'txt' then privado.txt(v) is not null
    when 'num' then privado.num(v) is not null
    when 'int' then privado.int(v) is not null
    when 'bool' then privado.bool(v) is not null
    when 'data' then privado.data(v) is not null
    when 'obj' then jsonb_typeof(v) = 'object'
    when 'lista' then jsonb_typeof(v) = 'array'
    when 'parcela' then privado.parcela_ok(v)
    else false end $$;

-- O que sobra do objeto depois de tirar os campos que cabem nas colunas (inclui campos com null).
create or replace function privado.resto(o jsonb, tipos jsonb) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(k, v), '{}'::jsonb)
  from jsonb_each(case when jsonb_typeof(o) = 'object' then o else '{}'::jsonb end) e(k, v)
  where not (tipos ? k and privado.cabe(v, tipos ->> k)) $$;

-- Remonta o objeto: extra + colunas (só as não nulas, no primeiro nível).
create or replace function privado.junta(extra jsonb, campos jsonb) returns jsonb language sql immutable as $$
  select coalesce(extra, '{}'::jsonb) || coalesce(
    (select jsonb_object_agg(k, v) from jsonb_each(campos) e(k, v) where jsonb_typeof(v) <> 'null'), '{}'::jsonb) $$;

-- ======================= dados pessoais =======================
create table if not exists public.pessoal (
  dono uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  revisao bigint not null default 1,
  versao int,
  atualizado_em text,
  config jsonb,
  orcamento jsonb,
  extra jsonb not null default '{}',
  criado_em timestamptz not null default now()
);

create table if not exists public.pessoas (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  id text not null, ordem int not null,
  nome text, telefone text,
  extra jsonb not null default '{}',
  primary key (dono, id)
);

create table if not exists public.cartoes (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  id text not null, ordem int not null,
  nome text, fechamento int, vencimento int, cor text, pix jsonb,
  extra jsonb not null default '{}',
  primary key (dono, id)
);

create table if not exists public.regras (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  id text not null, ordem int not null,
  contem text, pessoa text, modo text, fixo boolean,
  extra jsonb not null default '{}',
  primary key (dono, id)
);

create table if not exists public.faturas (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  id text not null, ordem int not null,
  cartao text, venc date, origem text, importada_em text,
  valor_informado numeric, total_declarado numeric,
  extra jsonb not null default '{}',
  primary key (dono, id)
);

create table if not exists public.lancamentos (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  id text not null, ordem int not null,
  cartao text, venc date, data date, descricao text, valor numeric, tipo text,
  parcela_n int, parcela_total int, fixo boolean, fixo_encerrado boolean,
  grupo text, obs text, origem text, ref_venc date,
  extra jsonb not null default '{}',
  primary key (dono, id)
);
create index if not exists lancamentos_venc on public.lancamentos (dono, cartao, venc);

create table if not exists public.divisoes (
  dono uuid not null,
  lancamento text not null, ordem int not null,
  pessoa text, valor numeric, pago boolean, pago_em date,
  extra jsonb not null default '{}',
  primary key (dono, lancamento, ordem),
  foreign key (dono, lancamento) references public.lancamentos (dono, id) on delete cascade
);
create index if not exists divisoes_pessoa on public.divisoes (dono, pessoa);

create table if not exists public.grupos (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  id text not null, ordem int not null,
  nome text, cartao text, desc_contem text, rotulo_peso text, parcelado jsonb, avista jsonb,
  extra jsonb not null default '{}',
  primary key (dono, id)
);

create table if not exists public.grupo_participantes (
  dono uuid not null,
  grupo text not null, ordem int not null,
  pessoa text, peso numeric,
  extra jsonb not null default '{}',
  primary key (dono, grupo, ordem),
  foreign key (dono, grupo) references public.grupos (dono, id) on delete cascade
);

create table if not exists public.grupo_pagamentos (
  dono uuid not null,
  grupo text not null, ordem int not null,
  id text, pessoa text, valor numeric, data date, ref text,
  extra jsonb not null default '{}',
  primary key (dono, grupo, ordem),
  foreign key (dono, grupo) references public.grupos (dono, id) on delete cascade
);

create table if not exists public.cobrancas (
  dono uuid not null references public.pessoal (dono) on delete cascade,
  ordem int not null,
  pessoa text, cartao text, venc date, em date, total numeric,
  extra jsonb not null default '{}',
  primary key (dono, ordem)
);

-- ======================= casa e viagens (compartilhado) =======================
create table if not exists public.espacos (
  id uuid primary key default gen_random_uuid(),
  codigo text not null unique,
  criado_por uuid default auth.uid() references auth.users (id) on delete set null,
  criado_em timestamptz not null default now(),
  revisao bigint not null default 1,
  versao int,
  atualizado_em text,
  casa_extra jsonb,
  extra jsonb not null default '{}'
);

create table if not exists public.espaco_usuarios (
  espaco uuid not null references public.espacos (id) on delete cascade,
  usuario uuid not null references auth.users (id) on delete cascade,
  entrou_em timestamptz not null default now(),
  primary key (espaco, usuario)
);
create index if not exists espaco_usuarios_usuario on public.espaco_usuarios (usuario);

create table if not exists public.membros (
  espaco uuid not null references public.espacos (id) on delete cascade,
  id text not null, ordem int not null,
  nome text,
  extra jsonb not null default '{}',
  primary key (espaco, id)
);

create table if not exists public.etapas (
  espaco uuid not null references public.espacos (id) on delete cascade,
  id text not null, ordem int not null,
  nome text, previsto numeric, concluida boolean,
  extra jsonb not null default '{}',
  primary key (espaco, id)
);

create table if not exists public.etapa_pagamentos (
  espaco uuid not null,
  etapa text not null, ordem int not null,
  id text, data date, valor numeric, descricao text, quem text,
  extra jsonb not null default '{}',
  primary key (espaco, etapa, ordem),
  foreign key (espaco, etapa) references public.etapas (espaco, id) on delete cascade
);

create table if not exists public.saldos (
  espaco uuid not null references public.espacos (id) on delete cascade,
  id text not null, ordem int not null,
  membro text, data date, valor numeric, em text,
  extra jsonb not null default '{}',
  primary key (espaco, id)
);

create table if not exists public.viagens (
  espaco uuid not null references public.espacos (id) on delete cascade,
  id text not null, ordem int not null,
  nome text, destino text, ida date, volta date, limite numeric, criada_por text,
  extra jsonb not null default '{}',
  primary key (espaco, id)
);

create table if not exists public.viagem_itens (
  espaco uuid not null,
  viagem text not null, ordem int not null,
  id text, categoria text, descricao text, valor numeric, pagador text, parte_outro numeric,
  forma text, cartao text, parcelas int, data date, status text, lancamento text,
  extra jsonb not null default '{}',
  primary key (espaco, viagem, ordem),
  foreign key (espaco, viagem) references public.viagens (espaco, id) on delete cascade
);

-- ======================= RLS =======================
create or replace function privado.sou_membro(p_espaco uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.espaco_usuarios u where u.espaco = p_espaco and u.usuario = auth.uid())
$$;
grant execute on function privado.sou_membro(uuid) to authenticated;

do $$
declare t text;
begin
  foreach t in array array['pessoal','pessoas','cartoes','regras','faturas','lancamentos','divisoes','grupos','grupo_participantes','grupo_pagamentos','cobrancas'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists dono on public.%I', t);
    execute format('create policy dono on public.%I for all to authenticated using (dono = auth.uid()) with check (dono = auth.uid())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant select on public.%I to service_role', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
  foreach t in array array['membros','etapas','etapa_pagamentos','saldos','viagens','viagem_itens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists membro on public.%I', t);
    execute format('create policy membro on public.%I for all to authenticated using (privado.sou_membro(espaco)) with check (privado.sou_membro(espaco))', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;

alter table public.espacos enable row level security;
drop policy if exists membro_le on public.espacos;
drop policy if exists membro_altera on public.espacos;
create policy membro_le on public.espacos for select to authenticated using (privado.sou_membro(id));
create policy membro_altera on public.espacos for update to authenticated using (privado.sou_membro(id)) with check (privado.sou_membro(id));
grant select, update on public.espacos to authenticated;
revoke all on public.espacos from anon;

alter table public.espaco_usuarios enable row level security;
drop policy if exists ve_o_espaco on public.espaco_usuarios;
drop policy if exists sai_do_espaco on public.espaco_usuarios;
create policy ve_o_espaco on public.espaco_usuarios for select to authenticated using (privado.sou_membro(espaco));
create policy sai_do_espaco on public.espaco_usuarios for delete to authenticated using (usuario = auth.uid());
grant select, delete on public.espaco_usuarios to authenticated;
revoke all on public.espaco_usuarios from anon;

-- ======================= montar / gravar (pessoal) =======================
create or replace function privado.montar_pessoal(p_dono uuid) returns jsonb
language sql stable set search_path = '' as $$
  select privado.junta(m.extra, jsonb_build_object('versao', m.versao, 'atualizadoEm', m.atualizado_em, 'config', m.config, 'orcamento', m.orcamento))
    || jsonb_build_object(
      'pessoas', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'nome', x.nome, 'telefone', x.telefone)) order by x.ordem)
                           from public.pessoas x where x.dono = p_dono), '[]'),
      'cartoes', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'nome', x.nome, 'fechamento', x.fechamento, 'vencimento', x.vencimento, 'cor', x.cor, 'pix', x.pix)) order by x.ordem)
                           from public.cartoes x where x.dono = p_dono), '[]'),
      'regras', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'contem', x.contem, 'pessoa', x.pessoa, 'modo', x.modo, 'fixo', x.fixo)) order by x.ordem)
                          from public.regras x where x.dono = p_dono), '[]'),
      'faturas', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'cartao', x.cartao, 'venc', x.venc, 'origem', x.origem, 'importadaEm', x.importada_em,
                             'valorInformado', x.valor_informado, 'totalDeclarado', x.total_declarado)) order by x.ordem)
                           from public.faturas x where x.dono = p_dono), '[]'),
      'lancamentos', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'cartao', x.cartao, 'venc', x.venc, 'data', x.data, 'desc', x.descricao,
                                 'valor', x.valor, 'tipo', x.tipo,
                                 'parcela', case when x.parcela_n is not null then jsonb_build_object('n', x.parcela_n, 'total', x.parcela_total) end,
                                 'fixo', x.fixo, 'fixoEncerrado', x.fixo_encerrado, 'grupo', x.grupo, 'obs', x.obs, 'origem', x.origem, 'refVenc', x.ref_venc,
                                 'divisao', case when not (x.extra ? 'divisao') then coalesce((
                                   select jsonb_agg(privado.junta(d.extra, jsonb_build_object('pessoa', d.pessoa, 'valor', d.valor, 'pago', d.pago, 'pagoEm', d.pago_em)) order by d.ordem)
                                   from public.divisoes d where d.dono = x.dono and d.lancamento = x.id), '[]') end)) order by x.ordem)
                               from public.lancamentos x where x.dono = p_dono), '[]'),
      'grupos', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'nome', x.nome, 'cartao', x.cartao, 'descContem', x.desc_contem,
                            'parcelado', x.parcelado, 'avista', x.avista, 'rotuloPeso', x.rotulo_peso,
                            'participantes', case when not (x.extra ? 'participantes') then coalesce((
                              select jsonb_agg(privado.junta(p.extra, jsonb_build_object('pessoa', p.pessoa, 'peso', p.peso)) order by p.ordem)
                              from public.grupo_participantes p where p.dono = x.dono and p.grupo = x.id), '[]') end,
                            'pagamentos', case when not (x.extra ? 'pagamentos') then coalesce((
                              select jsonb_agg(privado.junta(p.extra, jsonb_build_object('id', p.id, 'pessoa', p.pessoa, 'valor', p.valor, 'data', p.data, 'ref', p.ref)) order by p.ordem)
                              from public.grupo_pagamentos p where p.dono = x.dono and p.grupo = x.id), '[]') end)) order by x.ordem)
                          from public.grupos x where x.dono = p_dono), '[]'),
      'cobrancas', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('pessoa', x.pessoa, 'cartao', x.cartao, 'venc', x.venc, 'em', x.em, 'total', x.total)) order by x.ordem)
                             from public.cobrancas x where x.dono = p_dono), '[]'))
  from public.pessoal m where m.dono = p_dono
$$;

create or replace function privado.gravar_pessoal(p_dono uuid, d jsonb) returns void
language plpgsql set search_path = '' as $$
begin
  -- apaga e regrava o conjunto (as tabelas filhas saem junto, por cascade)
  delete from public.pessoas where dono = p_dono;
  delete from public.cartoes where dono = p_dono;
  delete from public.regras where dono = p_dono;
  delete from public.faturas where dono = p_dono;
  delete from public.lancamentos where dono = p_dono;
  delete from public.grupos where dono = p_dono;
  delete from public.cobrancas where dono = p_dono;

  insert into public.pessoas (dono, id, ordem, nome, telefone, extra)
  select p_dono, privado.txt(o -> 'id'), i, privado.txt(o -> 'nome'), privado.txt(o -> 'telefone'),
         privado.resto(o, '{"id":"txt","nome":"txt","telefone":"txt"}')
  from jsonb_array_elements(privado.lista(d -> 'pessoas')) with ordinality e(o, i);

  insert into public.cartoes (dono, id, ordem, nome, fechamento, vencimento, cor, pix, extra)
  select p_dono, privado.txt(o -> 'id'), i, privado.txt(o -> 'nome'), privado.int(o -> 'fechamento'), privado.int(o -> 'vencimento'),
         privado.txt(o -> 'cor'), privado.obj(o -> 'pix'),
         privado.resto(o, '{"id":"txt","nome":"txt","fechamento":"int","vencimento":"int","cor":"txt","pix":"obj"}')
  from jsonb_array_elements(privado.lista(d -> 'cartoes')) with ordinality e(o, i);

  insert into public.regras (dono, id, ordem, contem, pessoa, modo, fixo, extra)
  select p_dono, privado.txt(o -> 'id'), i, privado.txt(o -> 'contem'), privado.txt(o -> 'pessoa'), privado.txt(o -> 'modo'), privado.bool(o -> 'fixo'),
         privado.resto(o, '{"id":"txt","contem":"txt","pessoa":"txt","modo":"txt","fixo":"bool"}')
  from jsonb_array_elements(privado.lista(d -> 'regras')) with ordinality e(o, i);

  insert into public.faturas (dono, id, ordem, cartao, venc, origem, importada_em, valor_informado, total_declarado, extra)
  select p_dono, privado.txt(o -> 'id'), i, privado.txt(o -> 'cartao'), privado.data(o -> 'venc'), privado.txt(o -> 'origem'),
         privado.txt(o -> 'importadaEm'), privado.num(o -> 'valorInformado'), privado.num(o -> 'totalDeclarado'),
         privado.resto(o, '{"id":"txt","cartao":"txt","venc":"data","origem":"txt","importadaEm":"txt","valorInformado":"num","totalDeclarado":"num"}')
  from jsonb_array_elements(privado.lista(d -> 'faturas')) with ordinality e(o, i);

  insert into public.lancamentos (dono, id, ordem, cartao, venc, data, descricao, valor, tipo, parcela_n, parcela_total, fixo, fixo_encerrado,
                                  grupo, obs, origem, ref_venc, extra)
  select p_dono, privado.txt(o -> 'id'), i, privado.txt(o -> 'cartao'), privado.data(o -> 'venc'), privado.data(o -> 'data'),
         privado.txt(o -> 'desc'), privado.num(o -> 'valor'), privado.txt(o -> 'tipo'),
         case when privado.parcela_ok(o -> 'parcela') then privado.int(o -> 'parcela' -> 'n') end,
         case when privado.parcela_ok(o -> 'parcela') then privado.int(o -> 'parcela' -> 'total') end,
         privado.bool(o -> 'fixo'), privado.bool(o -> 'fixoEncerrado'), privado.txt(o -> 'grupo'), privado.txt(o -> 'obs'),
         privado.txt(o -> 'origem'), privado.data(o -> 'refVenc'),
         privado.resto(o, '{"id":"txt","cartao":"txt","venc":"data","data":"data","desc":"txt","valor":"num","tipo":"txt","parcela":"parcela",
                            "fixo":"bool","fixoEncerrado":"bool","grupo":"txt","obs":"txt","origem":"txt","refVenc":"data","divisao":"lista"}')
  from jsonb_array_elements(privado.lista(d -> 'lancamentos')) with ordinality e(o, i);

  insert into public.divisoes (dono, lancamento, ordem, pessoa, valor, pago, pago_em, extra)
  select p_dono, privado.txt(l -> 'id'), j, privado.txt(x -> 'pessoa'), privado.num(x -> 'valor'), privado.bool(x -> 'pago'), privado.data(x -> 'pagoEm'),
         privado.resto(x, '{"pessoa":"txt","valor":"num","pago":"bool","pagoEm":"data"}')
  from jsonb_array_elements(privado.lista(d -> 'lancamentos')) l,
       jsonb_array_elements(privado.lista(l -> 'divisao')) with ordinality e(x, j);

  insert into public.grupos (dono, id, ordem, nome, cartao, desc_contem, rotulo_peso, parcelado, avista, extra)
  select p_dono, privado.txt(o -> 'id'), i, privado.txt(o -> 'nome'), privado.txt(o -> 'cartao'), privado.txt(o -> 'descContem'),
         privado.txt(o -> 'rotuloPeso'), privado.obj(o -> 'parcelado'), privado.obj(o -> 'avista'),
         privado.resto(o, '{"id":"txt","nome":"txt","cartao":"txt","descContem":"txt","rotuloPeso":"txt","parcelado":"obj","avista":"obj",
                            "participantes":"lista","pagamentos":"lista"}')
  from jsonb_array_elements(privado.lista(d -> 'grupos')) with ordinality e(o, i);

  insert into public.grupo_participantes (dono, grupo, ordem, pessoa, peso, extra)
  select p_dono, privado.txt(g -> 'id'), j, privado.txt(x -> 'pessoa'), privado.num(x -> 'peso'),
         privado.resto(x, '{"pessoa":"txt","peso":"num"}')
  from jsonb_array_elements(privado.lista(d -> 'grupos')) g,
       jsonb_array_elements(privado.lista(g -> 'participantes')) with ordinality e(x, j);

  insert into public.grupo_pagamentos (dono, grupo, ordem, id, pessoa, valor, data, ref, extra)
  select p_dono, privado.txt(g -> 'id'), j, privado.txt(x -> 'id'), privado.txt(x -> 'pessoa'), privado.num(x -> 'valor'),
         privado.data(x -> 'data'), privado.txt(x -> 'ref'),
         privado.resto(x, '{"id":"txt","pessoa":"txt","valor":"num","data":"data","ref":"txt"}')
  from jsonb_array_elements(privado.lista(d -> 'grupos')) g,
       jsonb_array_elements(privado.lista(g -> 'pagamentos')) with ordinality e(x, j);

  insert into public.cobrancas (dono, ordem, pessoa, cartao, venc, em, total, extra)
  select p_dono, i, privado.txt(o -> 'pessoa'), privado.txt(o -> 'cartao'), privado.data(o -> 'venc'), privado.data(o -> 'em'), privado.num(o -> 'total'),
         privado.resto(o, '{"pessoa":"txt","cartao":"txt","venc":"data","em":"data","total":"num"}')
  from jsonb_array_elements(privado.lista(d -> 'cobrancas')) with ordinality e(o, i);
end $$;

-- ======================= montar / gravar (casa e viagens) =======================
create or replace function privado.montar_comp(p_espaco uuid) returns jsonb
language sql stable set search_path = '' as $$
  select privado.junta(s.extra, jsonb_build_object('versao', s.versao, 'atualizadoEm', s.atualizado_em,
    'membros', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'nome', x.nome)) order by x.ordem)
                         from public.membros x where x.espaco = p_espaco), '[]'),
    'casa', case when s.casa_extra is not null then s.casa_extra || jsonb_build_object(
      'etapas', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'nome', x.nome, 'previsto', x.previsto, 'concluida', x.concluida,
                            'pagamentos', case when not (x.extra ? 'pagamentos') then coalesce((
                              select jsonb_agg(privado.junta(p.extra, jsonb_build_object('id', p.id, 'data', p.data, 'valor', p.valor, 'desc', p.descricao, 'quem', p.quem)) order by p.ordem)
                              from public.etapa_pagamentos p where p.espaco = x.espaco and p.etapa = x.id), '[]') end)) order by x.ordem)
                          from public.etapas x where x.espaco = p_espaco), '[]'),
      'saldos', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'membro', x.membro, 'data', x.data, 'valor', x.valor, 'em', x.em)) order by x.ordem)
                          from public.saldos x where x.espaco = p_espaco), '[]')) end,
    'viagens', coalesce((select jsonb_agg(privado.junta(x.extra, jsonb_build_object('id', x.id, 'nome', x.nome, 'destino', x.destino, 'ida', x.ida, 'volta', x.volta,
                           'limite', x.limite, 'criadaPor', x.criada_por,
                           'itens', case when not (x.extra ? 'itens') then coalesce((
                             select jsonb_agg(privado.junta(i.extra, jsonb_build_object('id', i.id, 'categoria', i.categoria, 'desc', i.descricao, 'valor', i.valor,
                               'pagador', i.pagador, 'parteOutro', i.parte_outro, 'forma', i.forma, 'cartao', i.cartao, 'parcelas', i.parcelas,
                               'data', i.data, 'status', i.status, 'lancamento', i.lancamento)) order by i.ordem)
                             from public.viagem_itens i where i.espaco = x.espaco and i.viagem = x.id), '[]') end)) order by x.ordem)
                         from public.viagens x where x.espaco = p_espaco), '[]')))
  from public.espacos s where s.id = p_espaco
$$;

create or replace function privado.gravar_comp(p_espaco uuid, d jsonb) returns void
language plpgsql set search_path = '' as $$
declare casa jsonb := privado.obj(d -> 'casa');
begin
  update public.espacos set
    versao = privado.int(d -> 'versao'), atualizado_em = privado.txt(d -> 'atualizadoEm'),
    casa_extra = case when casa is not null then privado.resto(casa, '{"etapas":"lista","saldos":"lista"}') end,
    extra = privado.resto(d, '{"versao":"int","atualizadoEm":"txt","membros":"lista","casa":"obj","viagens":"lista"}')
  where id = p_espaco;

  delete from public.membros where espaco = p_espaco;
  delete from public.etapas where espaco = p_espaco;
  delete from public.saldos where espaco = p_espaco;
  delete from public.viagens where espaco = p_espaco;

  insert into public.membros (espaco, id, ordem, nome, extra)
  select p_espaco, privado.txt(o -> 'id'), i, privado.txt(o -> 'nome'), privado.resto(o, '{"id":"txt","nome":"txt"}')
  from jsonb_array_elements(privado.lista(d -> 'membros')) with ordinality e(o, i);

  insert into public.etapas (espaco, id, ordem, nome, previsto, concluida, extra)
  select p_espaco, privado.txt(o -> 'id'), i, privado.txt(o -> 'nome'), privado.num(o -> 'previsto'), privado.bool(o -> 'concluida'),
         privado.resto(o, '{"id":"txt","nome":"txt","previsto":"num","concluida":"bool","pagamentos":"lista"}')
  from jsonb_array_elements(privado.lista(casa -> 'etapas')) with ordinality e(o, i);

  insert into public.etapa_pagamentos (espaco, etapa, ordem, id, data, valor, descricao, quem, extra)
  select p_espaco, privado.txt(t -> 'id'), j, privado.txt(x -> 'id'), privado.data(x -> 'data'), privado.num(x -> 'valor'),
         privado.txt(x -> 'desc'), privado.txt(x -> 'quem'),
         privado.resto(x, '{"id":"txt","data":"data","valor":"num","desc":"txt","quem":"txt"}')
  from jsonb_array_elements(privado.lista(casa -> 'etapas')) t,
       jsonb_array_elements(privado.lista(t -> 'pagamentos')) with ordinality e(x, j);

  insert into public.saldos (espaco, id, ordem, membro, data, valor, em, extra)
  select p_espaco, privado.txt(o -> 'id'), i, privado.txt(o -> 'membro'), privado.data(o -> 'data'), privado.num(o -> 'valor'), privado.txt(o -> 'em'),
         privado.resto(o, '{"id":"txt","membro":"txt","data":"data","valor":"num","em":"txt"}')
  from jsonb_array_elements(privado.lista(casa -> 'saldos')) with ordinality e(o, i);

  insert into public.viagens (espaco, id, ordem, nome, destino, ida, volta, limite, criada_por, extra)
  select p_espaco, privado.txt(o -> 'id'), i, privado.txt(o -> 'nome'), privado.txt(o -> 'destino'), privado.data(o -> 'ida'), privado.data(o -> 'volta'),
         privado.num(o -> 'limite'), privado.txt(o -> 'criadaPor'),
         privado.resto(o, '{"id":"txt","nome":"txt","destino":"txt","ida":"data","volta":"data","limite":"num","criadaPor":"txt","itens":"lista"}')
  from jsonb_array_elements(privado.lista(d -> 'viagens')) with ordinality e(o, i);

  insert into public.viagem_itens (espaco, viagem, ordem, id, categoria, descricao, valor, pagador, parte_outro, forma, cartao, parcelas, data, status, lancamento, extra)
  select p_espaco, privado.txt(v -> 'id'), j, privado.txt(x -> 'id'), privado.txt(x -> 'categoria'), privado.txt(x -> 'desc'), privado.num(x -> 'valor'),
         privado.txt(x -> 'pagador'), privado.num(x -> 'parteOutro'), privado.txt(x -> 'forma'), privado.txt(x -> 'cartao'), privado.int(x -> 'parcelas'),
         privado.data(x -> 'data'), privado.txt(x -> 'status'), privado.txt(x -> 'lancamento'),
         privado.resto(x, '{"id":"txt","categoria":"txt","desc":"txt","valor":"num","pagador":"txt","parteOutro":"num","forma":"txt","cartao":"txt",
                            "parcelas":"int","data":"data","status":"txt","lancamento":"txt"}')
  from jsonb_array_elements(privado.lista(d -> 'viagens')) v,
       jsonb_array_elements(privado.lista(v -> 'itens')) with ordinality e(x, j);
end $$;

-- ======================= funções chamadas pelo app =======================
-- Erro PT409 vira HTTP 409 no Supabase: outro aparelho salvou antes (o app recarrega e decide).

create or replace function public.carregar_pessoal() returns jsonb
language plpgsql stable set search_path = '' as $$
declare r jsonb;
begin
  if auth.uid() is null then raise exception 'Faça login.' using errcode = '28000'; end if;
  select jsonb_build_object('dados', privado.montar_pessoal(m.dono), 'revisao', m.revisao) into r from public.pessoal m where m.dono = auth.uid();
  return r; -- null: ainda não há dados
end $$;

-- p_revisao null = primeira gravação (falha se já existir).
create or replace function public.salvar_pessoal(p_dados jsonb, p_revisao bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v_dono uuid := auth.uid(); v_rev bigint;
begin
  if v_dono is null then raise exception 'Faça login.' using errcode = '28000'; end if;
  if jsonb_typeof(p_dados) is distinct from 'object' then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  if p_revisao is null then
    insert into public.pessoal (dono) values (v_dono) on conflict (dono) do nothing returning revisao into v_rev;
  else
    update public.pessoal set revisao = revisao + 1 where dono = v_dono and revisao = p_revisao returning revisao into v_rev;
  end if;
  if v_rev is null then raise exception 'conflito' using errcode = 'PT409'; end if;
  update public.pessoal set
    versao = privado.int(p_dados -> 'versao'), atualizado_em = privado.txt(p_dados -> 'atualizadoEm'),
    config = privado.obj(p_dados -> 'config'), orcamento = privado.obj(p_dados -> 'orcamento'),
    extra = privado.resto(p_dados, '{"versao":"int","atualizadoEm":"txt","config":"obj","orcamento":"obj","pessoas":"lista","cartoes":"lista",
                                     "regras":"lista","faturas":"lista","lancamentos":"lista","grupos":"lista","cobrancas":"lista"}')
  where dono = v_dono;
  perform privado.gravar_pessoal(v_dono, p_dados);
  return v_rev;
end $$;

create or replace function public.meus_espacos() returns table (id uuid, codigo text, criado_em timestamptz)
language sql stable set search_path = '' as $$
  select s.id, s.codigo, s.criado_em from public.espacos s
  join public.espaco_usuarios u on u.espaco = s.id and u.usuario = auth.uid()
  order by s.criado_em
$$;

-- Cria o espaço do casal com os dados iniciais e devolve o código para a outra pessoa entrar.
create or replace function public.criar_espaco(p_dados jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_cod text;
begin
  if auth.uid() is null then raise exception 'Faça login.' using errcode = '28000'; end if;
  if jsonb_typeof(p_dados) is distinct from 'object' then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  v_cod := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  insert into public.espacos (codigo, criado_por) values (v_cod, auth.uid()) returning id into v_id;
  insert into public.espaco_usuarios (espaco, usuario) values (v_id, auth.uid());
  perform privado.gravar_comp(v_id, p_dados);
  return jsonb_build_object('id', v_id, 'codigo', v_cod, 'revisao', 1);
end $$;

create or replace function public.entrar_espaco(p_codigo text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Faça login.' using errcode = '28000'; end if;
  select id into v_id from public.espacos where codigo = upper(trim(p_codigo));
  if v_id is null then raise exception 'Código não encontrado.' using errcode = 'PT404'; end if;
  insert into public.espaco_usuarios (espaco, usuario) values (v_id, auth.uid()) on conflict do nothing;
  return v_id;
end $$;

create or replace function public.carregar_comp(p_espaco uuid) returns jsonb
language plpgsql stable set search_path = '' as $$
declare r jsonb;
begin
  if not privado.sou_membro(p_espaco) then raise exception 'Sem acesso a este espaço.' using errcode = 'PT403'; end if;
  select jsonb_build_object('dados', privado.montar_comp(s.id), 'revisao', s.revisao, 'codigo', s.codigo) into r from public.espacos s where s.id = p_espaco;
  return r;
end $$;

create or replace function public.salvar_comp(p_espaco uuid, p_dados jsonb, p_revisao bigint) returns bigint
language plpgsql set search_path = '' as $$
declare v_rev bigint;
begin
  if not privado.sou_membro(p_espaco) then raise exception 'Sem acesso a este espaço.' using errcode = 'PT403'; end if;
  if jsonb_typeof(p_dados) is distinct from 'object' then raise exception 'Dados inválidos.' using errcode = '22023'; end if;
  update public.espacos set revisao = revisao + 1 where id = p_espaco and revisao = p_revisao returning revisao into v_rev;
  if v_rev is null then raise exception 'conflito' using errcode = 'PT409'; end if;
  perform privado.gravar_comp(p_espaco, p_dados);
  return v_rev;
end $$;

-- Para o lembrete diário de cobranças (GitHub Actions), que usa a chave service_role.
create or replace function public.pessoal_de(p_dono uuid) returns jsonb
language sql stable set search_path = '' as $$ select privado.montar_pessoal(p_dono) $$;

revoke execute on all functions in schema privado from public, anon;
grant execute on function privado.sou_membro(uuid) to authenticated;
grant execute on all functions in schema privado to authenticated, service_role;
revoke execute on function public.carregar_pessoal(), public.salvar_pessoal(jsonb, bigint), public.meus_espacos(), public.criar_espaco(jsonb),
  public.entrar_espaco(text), public.carregar_comp(uuid), public.salvar_comp(uuid, jsonb, bigint), public.pessoal_de(uuid) from public, anon;
grant execute on function public.carregar_pessoal(), public.salvar_pessoal(jsonb, bigint), public.meus_espacos(), public.criar_espaco(jsonb),
  public.entrar_espaco(text), public.carregar_comp(uuid), public.salvar_comp(uuid, jsonb, bigint) to authenticated;
grant execute on function public.pessoal_de(uuid) to service_role;
