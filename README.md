# Pelada – gestão de futebol

> 📘 **Documentação técnica** (arquitetura, modelo de dados, regras, API, segurança, deploy e testes): [`docs/DOCUMENTACAO_TECNICA.md`](docs/DOCUMENTACAO_TECNICA.md)

Sistema web sem dependências (só Node 18+). Dois perfis:

- **Espectador**: abre o portal e digita o **código da pelada**. Vê placar, tempo, times, fila e rankings em tempo real. Não vê o nível dos jogadores.
- **Administrador**: entra com a senha no próprio portal. Cadastra jogadores (com nível), inicia a pelada, marca chegadas, sorteia, controla a partida, registra gols e assistências e zera a temporada.

## Rodar

```bash
npm start
```

Abre em `http://localhost:3333`. O terminal também mostra o endereço da rede local: é ele que os jogadores abrem no celular (mesmo Wi-Fi).

Senha do admin: `admin123` por padrão. Troque antes de usar de verdade:

```bash
ADMIN_PASSWORD=minhasenha npm start          # Linux/Mac/Git Bash
$env:ADMIN_PASSWORD="minhasenha"; npm start  # PowerShell
```

Variáveis opcionais: `PORT` (padrão 3333) e `DATA_FILE` (padrão `data/db.json`). Os dados ficam nesse arquivo JSON; faça cópia dele para guardar o histórico.

> Para acessar de fora do Wi-Fi do campo é preciso publicar o servidor (ex.: Render, Railway, VPS). Se for fazer isso, use uma senha forte e HTTPS.

Depois de 5 senhas erradas seguidas, o login daquele endereço fica bloqueado por 1 minuto (e o tempo dobra a cada novo erro, até 15 minutos).

## Como funciona

1. **Jogadores** (aba Jogadores): nome, nível (Fraco/Médio/Bom, visível só ao admin) e posição (Gol/Linha).
2. **Iniciar pelada** (aba Jogo): gera um **código** de 5 caracteres para os espectadores. "Encerrar pelada" (aba Admin) desmonta times e fila, apaga os resultados de hoje e invalida o código.
3. **Chegada**: o admin marca "Chegou"; a ordem de chegada é guardada.
4. **Sorteio**: os 10 primeiros a chegar são sorteados em 2 times de 5, equilibrados por nível (fraco=1, médio=2, bom=3). O nível só aparece para o admin, na aba Jogadores. Só os times em campo têm cor: **laranja** e **verde**.
5. **Goleiros** são apenas informação do cadastro: não entram em chegada, sorteio, times nem fila.
6. **Fila de espera**: quem chega depois do sorteio vai para o **fim da fila**, por ordem de chegada (sem sorteio e sem cor), lida em blocos de 5: próximo time, time de ré, etc.
7. **Sempre 5 por time**: a partida só inicia com os dois times completos. Se alguém sai (✕) ou vai para o fim da fila (↧), o primeiro da fila sobe e ocupa a vaga. Se a fila estiver vazia, a vaga é preenchida por quem chegar.
8. **Partida**: botão **Iniciar partida**; 7 minutos (com pausa) ou 2 gols. Com até 7 esperando, o vencedor fica, o perdedor vai para o fim da fila e os 5 primeiros da fila entram. Quem vence (por 1 ou mais gols) sempre fica em campo. Só no **empate com 8 ou mais esperando os dois times saem**: entram o próximo time e o time de ré (completado, se preciso, por quem acabou de sair); o admin define qual time ganhou: ele entra na fila logo depois do último que esperava, na ordem em que estava, e o outro time vem depois dele.
9. **Empate**: sai o time desafiante. Exceção: se o próximo time está completo e o time de ré tem até 3 jogadores, o admin **define quem ganhou**; o time que perde vai para o fim da fila e seus primeiros jogadores completam o time de ré. Fora dessa exceção o admin também pode escolher o vencedor.
10. **Gols**: botão ⚽ do time → toque em quem fez o gol → toque em quem deu a assistência (ou "Sem assistência"). ↶ desfaz um gol. Duplo toque não conta o gol duas vezes. Os placares das partidas já jogadas aparecem em **Resultados de hoje**, na aba Jogo; eles valem só para a pelada de hoje e somem quando ela é encerrada (o sistema não guarda histórico de partidas).
11. **Ranking** (público, não precisa de código): menu com Gols, Assistências e Participações (gols + assistências). Selos: ⚽ bola de ouro (mais gols), 👟 chuteira de ouro (mais assistências) e 👑 coroa (mais participações), que aparecem na frente do nome. O ranking é só da temporada atual: "Começar nova temporada" (aba Admin) apaga gols e assistências, sem guardar histórico. Só os jogadores cadastrados e as regras da partida permanecem.

Regras (duração, gols, jogadores por time) ficam em Admin > Regras da partida.

## Convidar os jogadores

Com a pelada iniciada, o botão **📲 Convidar** (ao lado do código, na aba Jogo) mostra um **QR code** e um **link** (`.../?c=CODIGO`). Quem aponta a câmera do celular, ou abre o link mandado no WhatsApp, entra direto na pelada, sem digitar o código. O modal tem ainda os botões Compartilhar, WhatsApp, Copiar link e Copiar código.

Rodando local (`npm start`), o link usa o endereço da rede (Wi-Fi) que o terminal mostra, então só funciona para quem está no mesmo Wi-Fi do servidor. Se o convite avisar que o endereço só funciona neste computador, abra o sistema pelo endereço da rede.

## No celular

- Durante a partida (rolando ou pausada) a tela **não apaga**, quando o navegador permite (precisa de https; no Wi-Fi local por http não funciona).
- Ao voltar para o site depois de usar outro app, o placar se atualiza na hora.
- Dá para **adicionar à tela inicial** (menu do navegador): o site abre como um app, com ícone próprio. No iPhone, o app instalado não divide o login nem o código com o Safari; abra o link de convite de novo.
- Ao mandar o link no WhatsApp, a prévia mostra o título e a imagem do site.

## Som

O sistema toca um **apito** quando a partida inicia (1 apito) e quando termina (3 apitos), em todos os celulares conectados. O navegador só libera som depois de um toque na página, então toque em qualquer botão uma vez ao abrir. O botão 🔊/🔇 no topo liga e desliga.

## Publicar: Netlify + Supabase

Em produção o sistema usa o **Supabase** (banco e tempo real) e o **Netlify** (site + função da API). As regras são as mesmas; o `npm start` local continua funcionando para desenvolver e para usar só na rede do campo.

```
celular ──► Netlify (public/ = site)         ┌────────────► Supabase Realtime (avisa "mudou")
   │                                          │                     │
   └──► /api/* ──► função netlify/functions/api.js ──► Supabase (tabela pelada_state)
```

**1. Supabase**
1. Crie o projeto em supabase.com.
2. Em *SQL Editor*, rode o conteúdo de [`supabase/migrations/20261020000000_pelada_state.sql`](supabase/migrations/20261020000000_pelada_state.sql). Ele cria a tabela do estado com RLS ligado e sem acesso pelo navegador (ela guarda o nível dos jogadores e o segredo do login).
3. Pegue 3 valores:
   - **Project URL**: em *Project Settings → Data API*. Se não achar, ela é `https://<Reference ID>.supabase.co`, com o *Reference ID* em *Project Settings → General*.
   - **Publishable key** (`sb_publishable_...`): em *Project Settings → API Keys*.
   - **Secret key** (`sb_secret_...`): na mesma tela, na aba **Secret keys** (clique em *New secret key* se não houver nenhuma). Projetos antigos podem ter as chaves *anon* e *service_role* na aba *Legacy API Keys*; elas também funcionam.
4. O Realtime (canal de broadcast `pelada`) funciona sem configuração extra.

**2. Netlify**
1. *Add new site → Import an existing project* e escolha este repositório. O `netlify.toml` já define: pasta publicada `public`, funções em `netlify/functions` e o redirecionamento de `/api/*`. O comando de build (`node scripts/set-site-url.js`) também já está lá: ele só completa o endereço da imagem de pré-visualização do link.
2. Em *Site configuration → Environment variables*, cadastre (veja [`.env.example`](.env.example)):
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY` (pública, vai para o navegador)
   - `SUPABASE_SECRET_KEY` (**secreta**: fica só na função, nunca no código nem no front-end)
   - `ADMIN_PASSWORD` (obrigatória: sem ela a API recusa funcionar)
3. Faça o deploy. Cada push na branch `main` publica de novo.

**Como atualiza em tempo real:** cada ação do admin grava no Supabase e dispara um aviso no canal Realtime; os celulares então pedem o estado atual à API (que valida o código da pelada). Há também uma consulta a cada 10 s como garantia, e, quando o cronômetro chega a zero, o próprio celular pede o estado para pegar o fim de jogo (a API encerra a partida ao ler, já que no Netlify não existe um processo rodando o tempo todo).

## Testes

```bash
npm test
```
