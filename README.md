# Garage Burger 79 — Cardápio digital

Cardápio online com pedido, checkout, nota fiscal automática (NFC-e) e painel do dono.

- **Cardápio** (`/`): as 10 categorias e 79 itens copiados do InstaDelivery, com fotos. O cliente pode tirar ingredientes, pôr adicionais e escrever uma observação.
- **Checkout** (`/checkout`): nome, CPF (validado), WhatsApp e localização atual (GPS) são obrigatórios. Também tem retirada no balcão e pagamento por Pix, cartão ou dinheiro com troco.
- **Acompanhamento** (`/pedido?c=CÓDIGO`): status do pedido, QR do Pix, nota fiscal e botão do WhatsApp.
- **Painel do dono** (`/admin/`, link discreto no rodapé): login com e-mail e senha validado no servidor. Tem pedidos em tempo real, preços, itens, ingredientes, adicionais, estoque, financeiro com gráficos e configurações (loja, entrega, Pix e nota fiscal).

## Rodar no computador

Precisa do Node.js 22.5 ou mais novo.

```bash
npm install
ADMIN_EMAIL=seu@email.com ADMIN_PASSWORD=umaSenhaForte npm start
# abre http://localhost:3000
```

A conta do dono é criada na primeira vez que o servidor sobe, com o `ADMIN_EMAIL` e o `ADMIN_PASSWORD` informados. Se você não informar, uma senha aleatória aparece no terminal. Depois dá para trocar a senha no painel, em Configurações.

## Colocar no ar (Render)

O arquivo `render.yaml` já está pronto:

1. Suba este código para um repositório no GitHub.
2. No Render, escolha **New → Blueprint** e selecione o repositório.
3. Preencha `ADMIN_EMAIL` e `ADMIN_PASSWORD` quando o Render pedir.

O banco SQLite fica num disco persistente montado em `/var/data`, então os pedidos e as alterações não se perdem quando o serviço reinicia.

## Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | Conta do dono, criada na primeira execução |
| `DATA_DIR` | Pasta do banco (padrão `./data`) |
| `NODE_ENV=production` | Cookie seguro (HTTPS) e desliga os dados de exemplo |
| `FOCUS_NFE_TOKEN`, `NFE_MODE` | Opcional: substitui o token e o modo configurados no painel |
| `ORDER_RATE_LIMIT` | Pedidos por IP a cada 10 min (padrão 8) |

## Nota fiscal

Veja [docs/NOTA-FISCAL.md](docs/NOTA-FISCAL.md). O sistema começa em **modo teste**: as notas saem como "sem valor fiscal". Para emitir de verdade, você precisa do certificado digital A1, do CSC da Sefaz-SE e de uma conta na Focus NFe.

## Estrutura

```
server.js              servidor, API pública do cardápio, login
server/db.js           banco (node:sqlite)
server/auth.js         senha bcrypt + sessão em cookie httpOnly
server/seed.js         importa server/menu-source.json no primeiro start
server/routes/orders.js   checkout, Pix, acompanhamento
server/routes/admin.js    API do painel (toda protegida)
server/nfe/            emissor NFC-e (teste e Focus NFe), DANFE, Pix, QR code
public/                cardápio, checkout, pedido e painel (/admin)
scripts/               extração do cardápio original
```

Para recomeçar do zero com o cardápio original, apague a pasta `data/` e reinicie o servidor.
