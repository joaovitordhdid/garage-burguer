# Nota fiscal automática (NFC-e): o que o dono precisa fazer

Cada pedido confirmado no site gera automaticamente uma **NFC-e** (Nota Fiscal de Consumidor Eletrônica, modelo 65) no CPF do cliente.
Hoje o sistema roda em **modo de teste (mock)**: a nota sai "autorizada" na hora, com chave fictícia e o DANFE marcado
**"SEM VALOR FISCAL — AMBIENTE DE TESTE"**. Nada vai para a SEFAZ. Para emitir notas de verdade, siga os passos abaixo.

## 1. Documentos e cadastros (com o seu contador)

| O quê | Para que serve | Onde conseguir |
|---|---|---|
| **CNPJ ativo** com CNAE de lanchonete (ex.: 5611-2/03) | Emitente da nota | Receita Federal / contador |
| **Inscrição Estadual (IE)** | A NFC-e é um documento estadual (ICMS). MEI também precisa de IE para emitir NFC-e | SEFAZ do seu estado / contador |
| **Credenciamento para NFC-e** na SEFAZ | Autoriza o CNPJ a emitir o modelo 65 | Portal da SEFAZ do estado (alguns estados liberam automaticamente) |
| **CSC + ID do token (CSC ID)** | Código de Segurança do Contribuinte, usado para gerar o QR Code da nota. Existe um para **homologação** e outro para **produção** | Portal da SEFAZ do estado, área "NFC-e › CSC" |
| **Certificado digital A1** (arquivo .pfx + senha) | Assina digitalmente cada nota. Tem validade de 1 ano, renove antes de vencer | Autoridade certificadora (Serasa, Certisign, Valid, Soluti…). O A3 (cartão/token) **não serve** para emissão automática na nuvem |
| **Regime tributário** | Simples Nacional (1), Simples com excesso de sublimite (2) ou Regime Normal (3). Define o CSOSN/CST de ICMS e o PIS/COFINS | Contador |
| **NCM de cada produto** | Classificação fiscal obrigatória por item. Padrão do sistema: 21069090 (preparações alimentícias). Bebidas têm NCM próprio (ex.: refrigerante 22021000) e algumas exigem **CEST** | Contador |
| **CFOP** | 5102 (venda de mercadoria adquirida de terceiros) ou **5101** (venda de produção própria, o caso do lanche feito na casa). Confirme com o contador | Contador |

> **Peça ao contador para revisar**: NCM e CFOP de cada item, o CSOSN de ICMS (o sistema usa **102** no Simples),
> o CST de PIS/COFINS (o sistema usa **07**), a forma de lançar a **taxa de entrega** (hoje vai como frete no 1º item)
> e o código de pagamento Pix (o sistema usa **17**; para QR estático existe o **20** desde a NT 2023.004).

## 2. Conta na Focus NFe (o emissor usado pelo sistema)

1. Crie uma conta em **focusnfe.com.br** (há plano gratuito para testes; produção é paga por volume de notas).
2. No painel da Focus, cadastre a **empresa**: CNPJ, IE, regime tributário, endereço, envie o **certificado A1** (.pfx + senha)
   e informe o **CSC e o ID do token** de homologação e de produção.
3. Habilite a emissão de **NFC-e** para a empresa.
4. Copie o **token de API** de homologação (e depois o de produção). O token é secreto: não compartilhe nem mande por WhatsApp.

## 3. Configurar no painel da Garage Burger

No painel (`/admin`), em **Configurações › Nota fiscal**, preencha (chave `nfe` nas configurações):

| Campo | Valor |
|---|---|
| `mode` | `mock` (teste local), `homologacao` (SEFAZ de teste) ou `producao` (notas reais) |
| `provider` | `focusnfe` |
| `token` | token de API da Focus (o de homologação ou o de produção, de acordo com o `mode`) |
| `cnpj` | CNPJ do emitente |
| `inscricao_estadual` | IE |
| `regime_tributario` | `1` Simples Nacional, `2` Simples (excesso de sublimite), `3` Regime Normal |
| `csc_id` / `csc_token` | CSC da SEFAZ (ficam cadastrados na Focus; aqui servem de referência) |
| `auto_emit` | `true` para emitir a nota a cada pedido. Com `false`, você emite pelo botão "Reemitir nota" |
| `uf` *(opcional)* | sigla do estado, ex.: `SP` |
| `razao_social` *(opcional)* | nome que aparece no DANFE de teste |

No servidor, as variáveis de ambiente **`FOCUS_NFE_TOKEN`** e **`NFE_MODE`** têm prioridade sobre o painel. É o jeito mais seguro de guardar o token.

O **NCM e o CFOP de cada produto** ficam no cadastro do produto (colunas `ncm` e `cfop`).

## 4. Testar em homologação antes de valer

1. Coloque `mode = homologacao` com o token de homologação.
2. Faça 3 ou 4 pedidos de teste: Pix, cartão, dinheiro com troco, entrega e retirada.
3. Na tela do pedido, o cartão "Nota fiscal" deve mostrar **Autorizada**, e o botão abre o DANFE gerado pela Focus.
   Em homologação a SEFAZ troca o nome do cliente por "NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL". Isso é normal.
4. Se aparecer **erro**, a mensagem da SEFAZ fica gravada na nota (ex.: "NCM inexistente", "CSC inválido"). Corrija o cadastro
   e use **Reemitir nota** no painel (`POST /api/orders/CODIGO/invoice/retry`, só para administrador). **O pedido nunca é perdido por causa da nota.**
5. Quando tudo sair autorizado, troque para `mode = producao` com o **token de produção**.

## 5. Como funciona no dia a dia

- O cliente confirma o pedido, o sistema recalcula os valores, grava o pedido e envia a NFC-e para a Focus, que assina e transmite para a SEFAZ.
- Se a SEFAZ demorar ("processando"), o sistema consulta de novo sempre que alguém abre o pedido (no acompanhamento ou no painel), no máximo a cada 20 segundos por nota, e a automação do painel também consulta as notas pendentes e reenvia as que deram erro (até 3 tentativas, se "reenvio automático" estiver ligado). Você também pode usar "Reemitir nota", que primeiro consulta o status para não emitir duas vezes.
- O cliente vê o status e abre o DANFE na página do pedido (`/pedido?c=CODIGO`).
- **Cancelamento**: a SEFAZ permite cancelar a NFC-e em até **30 minutos** após a emissão, com justificativa de 15 a 255 caracteres
  (`POST /api/orders/CODIGO/invoice/cancel` com `{ "reason": "..." }`, só para administrador). Depois desse prazo, fale com o contador.
- Guarde os XML: a Focus armazena, mas o contador costuma pedir o envio mensal.

## 6. Pix: confirmação automática

O QR Pix exibido ao cliente é um **BR Code estático** gerado com a chave cadastrada em `pix` (`key`, `merchant_name`, `city`).
Ele já vem com o valor e o código do pedido, mas **não avisa o sistema quando é pago**: confira no app do banco.
Para baixa automática é preciso um PSP com API Pix (Mercado Pago, Efí/Gerencianet, Asaas ou o seu banco). O ponto de integração
já está preparado em `server/nfe/pix.js` (`pspHook`), onde entram o Pix dinâmico e o webhook de confirmação.
