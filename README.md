# Controle de Cartões

App web (PWA) para acompanhar faturas do Nubank, do Itaú e do Mercado Pago, quem me deve, compras em grupo, o que já está comprometido nos próximos meses, a obra da casa e as viagens do casal. Funciona no navegador do notebook e do celular (pode ser instalado na tela inicial).

Este repositório é **público e só contém código**. Os dados ficam num banco SQL (Postgres) no seu projeto do **Supabase**, com Row Level Security: cada linha tem dono e só quem entrou com aquela conta enxerga ou altera.

## Quem vê o quê

| Dado | Onde fica | Quem acessa |
|---|---|---|
| Faturas, cartões, renda, contas fixas, quem me deve | tabelas `pessoal`, `cartoes`, `faturas`, `lancamentos`, `divisoes`, `pessoas`, `regras`, `grupos`, `grupo_participantes`, `grupo_pagamentos`, `cobrancas` | só o dono da conta |
| Casa (etapas, pagamentos, saldo guardado de cada um) e viagens | tabelas `espacos`, `membros`, `etapas`, `etapa_pagamentos`, `saldos`, `viagens`, `viagem_itens` | quem entrou no espaço do casal (`espaco_usuarios`) |

O esquema completo está em `supabase/schema.sql`. Campos que o app venha a criar e que ainda não têm coluna própria ficam na coluna `extra` (jsonb) da linha, para nada se perder.

## Configurar o Supabase (uma vez)

1. Crie um projeto em supabase.com.
2. *SQL Editor → New query*: cole o conteúdo de `supabase/schema.sql` e rode. Pode rodar de novo depois de atualizar o app; ele só cria o que falta e troca as funções.
3. *Authentication → Users → Add user*: crie o seu usuário com e-mail e senha (e o da outra pessoa, se forem usar casa e viagens). Marque *Auto Confirm User*.
4. *Authentication → Sign In / Providers*: desligue *Allow new users to sign up*, para ninguém mais criar conta no seu projeto.
5. *Project Settings → API*: copie o endereço do projeto (`https://xxxx.supabase.co`) e a chave **anon** (pública). A chave `service_role` nunca vai no app.
6. Coloque o endereço e a chave anon em `js/config.js` e publique. A partir daí, cada aparelho só pede e-mail, senha e PIN. Com `js/config.js` vazio, a tela de entrada pede também o endereço e a chave.

A chave anon fica visível no código (este repositório é público), e isso é esperado no Supabase: ela não dá acesso a nenhum dado sem login, por causa do RLS. Por isso o passo 4 (cadastro desligado) é obrigatório: com ele ligado, qualquer pessoa com a chave poderia criar uma conta no seu projeto.

### Trazer os dados da versão com GitHub

No primeiro acesso, o app oferece *Importar dados.json*. Baixe o `dados.json` do repositório `controle-cartoes-dados` (ou use *Baixar cópia* na versão antiga) e escolha o arquivo. Para casa e viagens, em *Ajustes → Casa e viagens → Criar o espaço*, escolha o `compartilhado.json` do repositório `casa-viagens-dados`.

## Publicar

1. Suba o conteúdo desta pasta neste repositório (branch `main`).
2. *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*.
3. O endereço fica `https://SEU-USUARIO.github.io/controle-cartoes/`.

## Segurança

- Nenhum dado financeiro, nome ou chave Pix está neste repositório.
- RLS em todas as tabelas: dados pessoais só com `dono = auth.uid()`; casa e viagens só para quem está em `espaco_usuarios`. A chave anon sozinha não lê nada.
- A sessão do Supabase (refresh token) fica no aparelho cifrada com AES-GCM; a chave vem do seu PIN (PBKDF2, 310 mil iterações). Sem o PIN, o que está salvo no navegador não abre.
- O app trava depois de 10 minutos em segundo plano, a não ser que o aparelho esteja marcado como *Manter conectado* (opção na tela do PIN e em Ajustes). Nesse caso a chave derivada do PIN fica no IndexedDB do navegador como chave não exportável: a sessão continua cifrada, mas quem abrir o app nesse aparelho entra sem PIN. *Bloquear agora* desliga a opção e volta a pedir o PIN.
- CSV e PDF são lidos no próprio aparelho (pdf.js incluído em `vendor/`, sem CDN). Da fatura do Itaú só são extraídos os lançamentos; CPF, endereço e código de barras são ignorados.
- Política de segurança (CSP) só permite conexão com `*.supabase.co`; nenhum script de terceiros.
- Gravações usam a coluna `revisao`: se outro aparelho salvou antes, o Supabase recusa (409) e o app pergunta qual versão manter, sem sobrescrever às cegas.
- Se perder o aparelho: em *Authentication → Users*, troque a senha do usuário ou use *Sign out user* para derrubar as sessões.

## Casa e viagens (uma vez)

1. Os dois precisam de usuário no mesmo projeto do Supabase (passo 3 acima).
2. Um de vocês: *Ajustes → Casa e viagens* → seu nome → *Criar o espaço* (opcionalmente importando o `compartilhado.json`). O app mostra um código de 8 caracteres.
3. O outro: entra no app com a própria conta → *Ajustes → Casa e viagens* → seu nome → *Entrar com código*.

Use sempre o mesmo nome; é por ele que o app sabe quem você é. Quando os dois editam ao mesmo tempo, o app baixa a versão do outro, reaplica a sua alteração e salva de novo.

## Lembrete diário de cobranças

O script `scripts/cobrancas.mjs` do repositório de dados lê do Supabase quando recebe `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (chave `service_role` ou `sb_secret_…`, só nos secrets do GitHub Actions) e `SUPABASE_USER_ID` (o UID do seu usuário em *Authentication → Users*). A função `pessoal_de` só aceita a chave de serviço.

## Como funciona "cabe no bolso"

Para cada mês: renda − contas fixas fora do cartão − o que você separa para a casa − sua parte das faturas (parcelas e fixos já conhecidos; no mês atual, também a fatura que já fechou) − sua parte dos gastos de viagem ainda não comprados. Gasto no seu cartão cai no mês do vencimento pelo ciclo do cartão; no cartão do outro, a sua parte começa no mês seguinte à compra; Pix/débito no mês da compra. Abaixo da margem fica amarelo; negativo, vermelho. Renda e faturas não saem das suas tabelas.

Ao marcar um gasto de viagem como comprado no cartão, o app lança a 1ª parcela na sua fatura (com a parte do outro em "Me devem"). Quando a fatura do banco for importada, esse lançamento é trocado pelo do banco se o valor bater e a data tiver até 3 dias de diferença; se não bater, a importação avisa e você apaga o duplicado.

## Salário x faturas

Em *Ajustes → Renda e compromissos* ficam os dois pagamentos do mês (adiantamento e salário): o valor que cai na conta, já sem os descontos do holerite, e o dia (dia do mês ou N-ésimo dia útil; dia fixo no fim de semana conta na sexta anterior, feriados não). No Resumo, cada pagamento aparece com as faturas que vencem até o pagamento seguinte, a sua parte de cada uma, as contas fixas e a casa (no pagamento escolhido) e quanto sobra. Se ainda te devem nessas faturas, mostra quanto você precisa adiantar caso não paguem antes do vencimento. Com os dois pagamentos preenchidos, a renda do mês passa a ser a soma deles (também na checagem "cabe no bolso").

## Como as faturas entram

- **Nubank**: exporte a fatura em CSV (`Nubank_AAAA-MM-DD.csv`; a data do nome é o vencimento) e importe. Pode reimportar quantas vezes quiser no mês: o que você marcou é mantido.
- **Pagamentos no CSV do Nubank**: pagamento feito até o vencimento da fatura anterior conta para a anterior; depois disso, é antecipação da atual. Na importação dá para trocar e informar o valor que aparece no app do banco — o app mostra a diferença e, se existir, a combinação de pagamentos que fecha o valor.
- **Itaú**: importe o PDF da fatura fechada. O app confere a soma com o total do PDF e cria as parcelas da próxima fatura como "previstas". Compras do dia a dia você lança à mão; quando o PDF seguinte chegar, as lançadas à mão que baterem (mesmo valor, até 3 dias de diferença) são substituídas pelas do PDF mantendo a divisão.
- **Itaú, fatura aberta (planilha)**: no site do Itaú, baixe a fatura aberta em Excel (.xlsx) e escolha o arquivo em *Importar*. O app confere a soma das compras com o "Valor (parcial)" da planilha, usa o vencimento dela, deixa desmarcado o que já está na mesma fatura ou já é previsto (parcelas pelo número; fixos pelo valor, aceitando até 15% de diferença de câmbio quando a descrição tem palavra em comum) e ignora os pagamentos. Os lançamentos entram como "lançado à mão" e são trocados pelos do PDF quando a fatura fechar. Pode importar de novo depois: o que já entrou não repete.
- **Mercado Pago**: importe o PDF da fatura. O app confere a soma com consumos + encargos do resumo. Pagamentos da fatura anterior entram como pagamento; o número do cartão e o nome do titular são ignorados. O PDF do Mercado Pago não lista as parcelas da próxima fatura uma a uma; elas são projetadas a partir de "Parcela n de m".
- **Fatura ainda aberta (antes de o banco liberar o PDF/CSV)**: em Faturas → *Colar lançamentos*, cole o texto copiado da tela de lançamentos do banco ou digite uma compra por linha (`05/11 Uber 23,90`). O app mostra o que leu antes de lançar, deixa desmarcado o que já está no app (mesmo valor, até 3 dias) e as parcelas que já são previstas, e ignora pagamentos. Os colados entram como "lançado à mão", com as regras automáticas, e são trocados pelos do banco quando a fatura fechada for importada.
- Parcela seguinte de uma compra herda automaticamente a pessoa/divisão da anterior. Regras (Ajustes) cobrem compras recorrentes.

## Arquivos

| Arquivo | Função |
|---|---|
| `js/parsers.js` | leitura do CSV Nubank e dos PDFs Itaú e Mercado Pago |
| `js/planos.js` | casa, viagens e a checagem "cabe no bolso" |
| `js/importer.js` | junta a fatura importada com os dados existentes |
| `js/calc.js` | faturas, previsões, quem me deve, grupos, cobranças |
| `js/pix.js` | Pix copia e cola (BR Code) com valor |
| `js/config.js` | endereço e chave anon do projeto do Supabase |
| `js/store.js` | login no Supabase, chamadas às funções SQL e cifra da sessão pelo PIN |
| `supabase/schema.sql` | tabelas, RLS e funções `carregar_*`/`salvar_*` |
| `js/app.js`, `js/ui.js`, `css/app.css` | interface |

Ao alterar `calc.js`, `util.js` ou `pix.js`, copie também para `scripts/lib/` do repositório de dados (o lembrete diário usa os mesmos cálculos).
