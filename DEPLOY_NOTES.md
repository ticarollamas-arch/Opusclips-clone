# Cortador 9:16 — como colocar no ar

Arquitetura:

```
Cliente ──> cortador916.com (Vercel: site, cadastro, painel, webhook de pagamento)
                 │  Prisma (TLS)            │ HTTPS
                 ▼                          ▼
          PostgreSQL (VPS)  <──  api.cortador916.com (VPS via Cloudflare Tunnel)
                                   FastAPI + workers + FFmpeg + Whisper + Ollama
Kiwify/Hotmart ──webhook──> cortador916.com/api/billing/pagamento-webhook
```

Nenhuma API de IA de terceiros: transcrição com Whisper e escolha de cortes com Ollama, os dois na VPS.
O único serviço externo é o checkout (Kiwify ou Hotmart).

## 1. VPS (a "nossa API")

Requisitos: 4+ núcleos, 8 GB+ de RAM (16 GB recomendado), 60 GB de disco, Docker.

```bash
git clone https://github.com/ticarollamas-arch/Opusclips-clone.git cortador
cd cortador
cp .env.producao.example .env        # preencha tudo
sh deploy/vps/gerar-certificado-postgres.sh
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec ollama ollama pull qwen2.5:7b-instruct
```

Cloudflare: em Zero Trust > Networks > Tunnels, crie um túnel, copie o token para
`CLOUDFLARE_TUNNEL_TOKEN` e adicione o hostname público `api.cortador916.com` → `http://backend:8000`.

Firewall: libere a porta 5432 (PostgreSQL, para a Vercel) e mantenha 8000/6379 fechadas.

## 2. Vercel (o site)

1. Importe o repositório na Vercel com **Root Directory = `frontend`**.
2. Copie as variáveis de `frontend/.env.vercel.example` para Settings > Environment Variables.
3. Deploy. Depois, em Settings > Domains, adicione `cortador916.com`.

## 3. Kiwify ou Hotmart

1. Crie um produto de **assinatura** com duas ofertas: mensal (R$ 7) e anual (R$ 47).
2. Coloque os links de checkout em `CHECKOUT_URL_MENSAL` e `CHECKOUT_URL_ANUAL`.
3. Webhook (eventos: compra aprovada, renovação, reembolso, chargeback, assinatura cancelada/atrasada):
   `https://cortador916.com/api/billing/pagamento-webhook?secret=CHECKOUT_WEBHOOK_SECRET`
4. Faça uma compra de teste e confira em Configurações se o plano Pro apareceu.

Como o acesso funciona:
- O botão "Assinar" abre o checkout com o e-mail da conta já preenchido.
- Pagamento aprovado → plano Pro até o fim do período pago (1 mês ou 1 ano).
- Renovação → estende o período. Reembolso ou chargeback → acesso cai na hora.
- Cancelamento → acesso continua até o fim do período pago e depois para sozinho.
- Quem comprou antes de criar a conta recebe o plano ao se cadastrar com o mesmo e-mail.

## Licença (obrigatório)

Este projeto é derivado do [SupoClip](https://github.com/FujiwaraChoki/supoclip), licença **AGPL-3.0**.
Ao oferecer o serviço pela internet, o código-fonte com as suas modificações precisa continuar
disponível para os usuários. O rodapé do site já aponta para o repositório e para o projeto original.
Não deixe o repositório privado enquanto o serviço estiver no ar.

Antes de vender, revise `/terms` e `/privacy`: os textos vieram do projeto original e precisam
dos seus dados e das regras do seu serviço (reembolso de 7 dias do CDC, por exemplo).
