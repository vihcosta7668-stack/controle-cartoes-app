# Controle de Cartões

App web (PWA) para acompanhar faturas do Nubank e do Itaú, quem me deve, compras em grupo e o que já está comprometido nos próximos meses. Funciona no navegador do notebook e do celular (pode ser instalado na tela inicial).

Este repositório é **público e só contém código**. Os dados ficam em um repositório **privado** separado (`controle-cartoes-dados`), lidos e gravados pela API do GitHub com um token que só tem acesso a ele.

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

## Como as faturas entram

- **Nubank**: exporte a fatura em CSV (`Nubank_AAAA-MM-DD.csv`; a data do nome é o vencimento) e importe. Pode reimportar quantas vezes quiser no mês: o que você marcou é mantido.
- **Pagamentos no CSV do Nubank**: pagamento feito até o vencimento da fatura anterior conta para a anterior; depois disso, é antecipação da atual. Na importação dá para trocar e informar o valor que aparece no app do banco — o app mostra a diferença e, se existir, a combinação de pagamentos que fecha o valor.
- **Itaú**: importe o PDF da fatura fechada. O app confere a soma com o total do PDF e cria as parcelas da próxima fatura como "previstas". Compras do dia a dia você lança à mão; quando o PDF seguinte chegar, as lançadas à mão que baterem (mesmo valor, até 3 dias de diferença) são substituídas pelas do PDF mantendo a divisão.
- Parcela seguinte de uma compra herda automaticamente a pessoa/divisão da anterior. Regras (Ajustes) cobrem compras recorrentes.

## Arquivos

| Arquivo | Função |
|---|---|
| `js/parsers.js` | leitura do CSV Nubank e do PDF Itaú |
| `js/importer.js` | junta a fatura importada com os dados existentes |
| `js/calc.js` | faturas, previsões, quem me deve, grupos, cobranças |
| `js/pix.js` | Pix copia e cola (BR Code) com valor |
| `js/store.js` | GitHub + cifra do token |
| `js/app.js`, `js/ui.js`, `css/app.css` | interface |

Ao alterar `calc.js`, `util.js` ou `pix.js`, copie também para `scripts/lib/` do repositório de dados (o lembrete diário usa os mesmos cálculos).
