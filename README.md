<p align="center"><img src="assets/banner.svg" alt="Cortador 9:16 — cortes verticais de vídeos longos com IA local" width="100%"></p>

# Cortador 9:16 — cortes verticais de vídeos longos com IA local

Serviço por assinatura (R$ 7/mês ou R$ 47/ano) que transforma **vídeos longos** (podcasts, pregações, aulas, lives) em **cortes verticais 9:16** com legenda automática, prontos para TikTok, Reels e Shorts.

Esta versão roda **sem APIs de IA de terceiros**: a transcrição usa Whisper e a escolha dos cortes usa um modelo aberto no Ollama, tudo na própria VPS. O pagamento é feito pela Kiwify ou pela Hotmart.

**Como colocar no ar:** veja [DEPLOY_NOTES.md](DEPLOY_NOTES.md).

Baseado no projeto de código aberto **[SupoClip](https://github.com/FujiwaraChoki/supoclip)** (AGPL-3.0), de FujiwaraChoki e colaboradores. Documentação original em inglês: [README-en.md](README-en.md) e [docs/](docs/README.md).

### O que mudou em relação ao original

- Nome e marca: Cortador 9:16, em português por padrão.
- IA local por padrão (Whisper + Ollama); B-roll do Pexels, Apify, PostHog e publicação em redes desligados.
- Cobrança por Kiwify/Hotmart com webhook (`/api/billing/pagamento-webhook`), plano único, preços em reais e limite de minutos por assinante.
- E-mail de recuperação de senha por SMTP da sua própria caixa.
- Cadastro consertado na Vercel (o `vercel.json` antigo desviava `/api/auth` para o backend).
- `docker-compose.prod.yml` para a VPS, com PostgreSQL protegido por senha e TLS, Ollama e Cloudflare Tunnel.

## Recursos

- **Fontes de vídeo**: YouTube, Twitch e Kick (VODs e clipes) ou upload de arquivo próprio.
- **Seleção de cortes por IA**: um LLM (Gemini, GPT, Claude ou Ollama local) escolhe de 3 a 7 trechos a partir da transcrição.
- **Nota de viralidade** por clipe: gancho, engajamento, valor e compartilhamento.
- **Recorte vertical inteligente**: detecção de rosto mantém quem fala centralizado no quadro 9:16.
- **Legendas sincronizadas por palavra** (AssemblyAI ou Whisper), com fontes e modelos animados.
- **Título de abertura** gerado por IA e **B-roll** opcional do Pexels com transições.
- **Editor embutido**: cortar, dividir e juntar clipes e exportar com predefinições por plataforma.
- **Publicação direta** e agendamento no YouTube, TikTok e Instagram, com métricas que realimentam a seleção.
- **Progresso em tempo real**, API REST com chaves e servidor **MCP** para clientes como Claude e Cursor.

## Instalação

Requisitos: **Docker** e Docker Compose, uma chave da **AssemblyAI** (transcrição) e uma chave de LLM (Google, OpenAI, Anthropic) ou um Ollama local.

```bash
git clone https://github.com/ticarollamas-arch/Opusclips-clone.git
cd Opusclips-clone
```

Crie um `.env` na raiz:

```env
ASSEMBLY_AI_API_KEY=sua_chave_assemblyai
LLM=google-gla:gemini-3-flash-preview
GOOGLE_API_KEY=sua_chave_google
```

## Como usar

```bash
docker-compose up -d
docker-compose logs -f        # acompanhe a primeira inicialização
```

- Interface: `http://localhost:3107` (crie uma conta e envie um vídeo).
- API: `http://localhost:8000`, com documentação interativa em `/docs`.
- Testes: `make test` (pytest, Vitest e Playwright).

Guias detalhados: [instalação](docs/setup.md), [configuração](docs/configuration.md), [arquitetura](docs/architecture.md), [API](docs/api-reference.md), [desenvolvimento](docs/development.md) e [solução de problemas](docs/troubleshooting.md).

## Tecnologias

Python · FastAPI · ARQ (fila de tarefas) · uv · Next.js 15 · TypeScript · Tailwind CSS · shadcn/ui · PostgreSQL · Redis · FFmpeg · AssemblyAI · Whisper · Pexels API · Docker Compose · MCP

## Créditos

Projeto original: [SupoClip](https://github.com/FujiwaraChoki/supoclip), de FujiwaraChoki e colaboradores. Esta cópia mantém o código e o aviso de licença originais.

## Licença

**GNU AGPL-3.0**, herdada do projeto original. Veja [LICENSE](LICENSE). Se você modificar e disponibilizar o software como serviço em rede, a AGPL exige que o código-fonte das modificações também seja disponibilizado.
