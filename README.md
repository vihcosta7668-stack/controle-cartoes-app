# Controle de Cartões

App web (PWA) para acompanhar faturas do Nubank, do Itaú e do Mercado Pago, quem me deve, compras em grupo, o que já está comprometido nos próximos meses, a obra da casa e as viagens do casal. Funciona no navegador do notebook e do celular (pode ser instalado na tela inicial).

Este repositório é **público e só contém código**. Os dados ficam em um repositório **privado** separado (`controle-cartoes-dados`), lidos e gravados pela API do GitHub com um token que só tem acesso a ele.

## Quem vê o quê

| Dado | Onde fica | Quem acessa |
|---|---|---|
| Faturas, cartões, renda, contas fixas, quem me deve | `controle-cartoes-dados` (privado, na conta pessoal de cada um) | só o dono |
| Casa (etapas, pagamentos, saldo guardado de cada um) e viagens | `casa-viagens-dados` (privado, na conta de um dos dois, com o outro como colaborador) | os dois |

Cada pessoa usa o mesmo endereço do app, com o próprio repositório pessoal. O token fine-grained só enxerga repositórios do próprio dono e não funciona para colaborador; por isso quem é colaborador do repositório compartilhado usa um token clássico.

## Publicar

1. Suba o conteúdo desta pasta neste repositório (branch `main`).
2. *Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)`*.
3. O endereço fica `https://SEU-USUARIO.github.io/controle-cartoes/`.

## Segurança

- Nenhum dado financeiro, nome ou chave Pix está neste repositório.
- O app recusa conectar a um repositório de dados público.
- O token (fine-grained, só o repositório de dados, permissão *Contents: Read and write*) fica no aparelho cifrado com AES-GCM; a chave vem do seu PIN (PBKDF2, 310 mil iterações). Sem o PIN, o que está salvo no navegador não abre.
- O app trava depois de 10 minutos em segundo plano.
- CSV e PDF são lidos no próprio aparelho (pdf.js incluído em `vendor/`, sem CDN). Da fatura do Itaú só são extraídos os lançamentos; CPF, endereço e código de barras são ignorados.
- Política de segurança (CSP) só permite conexão com `api.github.com`; nenhum script de terceiros.
- Se perder o aparelho: revogue o token em *GitHub → Settings → Developer settings → Personal access tokens* e gere outro.

## Casa e viagens (uma vez)

1. Na sua conta, crie o repositório **privado** `casa-viagens-dados` (pode ser vazio; o app cria o `compartilhado.json`).
2. *Settings → Collaborators → Add people* → convide a outra pessoa. Ela precisa aceitar o convite (e-mail ou github.com/notifications).
3. Tokens:
   - Dono do repositório: edite o token fine-grained que o app já usa (*Settings → Developer settings → Fine-grained tokens*) e acrescente `casa-viagens-dados` em *Repository access*. O mesmo token serve para os dois campos.
   - Colaborador: crie um token **clássico** (*Personal access tokens → Tokens (classic) → Generate new token*) com o escopo `repo` e uma data de validade. Esse tipo de token alcança todos os repositórios privados da conta dele; fica no aparelho cifrado pelo PIN, mas se vazar, revogue na hora.
4. No app: *Ajustes → Casa e viagens* → dono do repositório (o seu usuário), repositório, token, seu nome e o PIN deste aparelho. Use sempre o mesmo nome; é por ele que o app sabe quem você é.

Quando os dois editam ao mesmo tempo, o app baixa a versão do outro, reaplica a sua alteração e salva de novo.

## Como funciona "cabe no bolso"

Para cada mês: renda − contas fixas fora do cartão − o que você separa para a casa − sua parte das faturas (parcelas e fixos já conhecidos; no mês atual, também a fatura que já fechou) − sua parte dos gastos de viagem ainda não comprados. Gasto no seu cartão cai no mês do vencimento pelo ciclo do cartão; no cartão do outro, a sua parte começa no mês seguinte à compra; Pix/débito no mês da compra. Abaixo da margem fica amarelo; negativo, vermelho. Renda e faturas não saem do seu repositório.

Ao marcar um gasto de viagem como comprado no cartão, o app lança a 1ª parcela na sua fatura (com a parte do outro em "Me devem"). Quando a fatura do banco for importada, esse lançamento é trocado pelo do banco se o valor bater e a data tiver até 3 dias de diferença; se não bater, a importação avisa e você apaga o duplicado.

## Como as faturas entram

- **Nubank**: exporte a fatura em CSV (`Nubank_AAAA-MM-DD.csv`; a data do nome é o vencimento) e importe. Pode reimportar quantas vezes quiser no mês: o que você marcou é mantido.
- **Pagamentos no CSV do Nubank**: pagamento feito até o vencimento da fatura anterior conta para a anterior; depois disso, é antecipação da atual. Na importação dá para trocar e informar o valor que aparece no app do banco — o app mostra a diferença e, se existir, a combinação de pagamentos que fecha o valor.
- **Itaú**: importe o PDF da fatura fechada. O app confere a soma com o total do PDF e cria as parcelas da próxima fatura como "previstas". Compras do dia a dia você lança à mão; quando o PDF seguinte chegar, as lançadas à mão que baterem (mesmo valor, até 3 dias de diferença) são substituídas pelas do PDF mantendo a divisão.
- **Mercado Pago**: importe o PDF da fatura. O app confere a soma com consumos + encargos do resumo. Pagamentos da fatura anterior entram como pagamento; o número do cartão e o nome do titular são ignorados. O PDF do Mercado Pago não lista as parcelas da próxima fatura uma a uma; elas são projetadas a partir de "Parcela n de m".
- Parcela seguinte de uma compra herda automaticamente a pessoa/divisão da anterior. Regras (Ajustes) cobrem compras recorrentes.

## Arquivos

| Arquivo | Função |
|---|---|
| `js/parsers.js` | leitura do CSV Nubank e dos PDFs Itaú e Mercado Pago |
| `js/planos.js` | casa, viagens e a checagem "cabe no bolso" |
| `js/importer.js` | junta a fatura importada com os dados existentes |
| `js/calc.js` | faturas, previsões, quem me deve, grupos, cobranças |
| `js/pix.js` | Pix copia e cola (BR Code) com valor |
| `js/store.js` | GitHub + cifra do token (um para o repositório pessoal, outro para o compartilhado) |
| `js/app.js`, `js/ui.js`, `css/app.css` | interface |

Ao alterar `calc.js`, `util.js` ou `pix.js`, copie também para `scripts/lib/` do repositório de dados (o lembrete diário usa os mesmos cálculos).
