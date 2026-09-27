# Painel da squad

Painel local que mostra, ao vivo, como os subagentes do [Claude Code](https://code.claude.com) trabalham juntos: quem chamou quem, quanto tempo cada chamada levou, quantos tokens gastou e o que foi entregue.

- **Grafo dos agentes:** as caixinhas vêm de `.claude/agents/*.md` e atualizam sozinhas quando você cria ou edita um agente.
- **Conexões reais:** cada chamada entre agentes (inclusive subagente chamando subagente) vira uma linha com duração e tokens. Clique nela para ver a tarefa enviada e o retorno.
- **Paralelismo:** se o orquestrador chama o mesmo agente várias vezes ao mesmo tempo, a caixinha e a conexão mostram "3 em paralelo" e os logs marcam cada instância (#1, #2, #3).
- **Linha do tempo:** uma barra por chamada, empilhadas quando rodam juntas, para ver o que rodou em paralelo e onde a execução esperou.
- **Logs por agente:** a lateral agrupa os eventos pelo agente que os executou.
- **Tokens e custo estimado:** lidos dos transcripts do Claude Code e calculados pela tabela de preços da API.
- **Sessões e histórico:** cada terminal é uma sessão e cada prompt é uma execução salva, que pode ser reaberta depois.

Não tem dependências: só Node.js 18 ou mais novo.

## Como usar

1. Suba o painel apontando para o projeto que você quer observar:

   ```
   node server.js C:\caminho\do\projeto
   ```

2. Cadastre os hooks no `.claude/settings.local.json` desse projeto, trocando o caminho pelo do seu `send-event.js`:

   ```json
   {
     "hooks": {
       "UserPromptSubmit":   [{ "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }],
       "Stop":               [{ "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }],
       "SubagentStart":      [{ "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }],
       "SubagentStop":       [{ "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }],
       "PreToolUse":         [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }],
       "PostToolUse":        [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }],
       "PostToolUseFailure": [{ "matcher": "*", "hooks": [{ "type": "command", "command": "node \"C:/caminho/painel/send-event.js\"", "timeout": 5 }] }]
     }
   }
   ```

   Se preferir, `node setup.js C:\caminho\do\projeto` grava isso por você, junto com um hook de `SessionStart` que sobe o painel sozinho ao abrir o Claude Code. `node setup.js C:\caminho\do\projeto --remover` desfaz.

3. Abra http://localhost:4000 e use o Claude Code normalmente. O botão **Simular execução** mostra o painel funcionando sem precisar do Claude Code.

## Configuração

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `SQUAD_PANEL_PORT` | `4000` | Porta do painel |
| `SQUAD_PROJECT_DIR` | pasta atual | Projeto de onde ler `.claude/agents` (o argumento do `server.js` tem prioridade) |
| `SQUAD_HISTORY_DIR` | `~/.squad-panel/historico` | Onde ficam as execuções salvas (últimas 300) |
| `SQUAD_PANEL_AUTOSTART` | ligado | `0` impede o hook de `SessionStart` de subir o painel |
| `SQUAD_TRANSCRIPT_DIRS` | vazio | Pastas extras de onde o server pode ler transcripts, além de `~/.claude` e `CLAUDE_CONFIG_DIR` |

Para ajustar preços, crie `precos.json` ao lado do `server.js` (US$ por milhão de tokens):

```json
{ "claude-sonnet-5": { "input": 2, "output": 10, "cacheRead": 0.2 } }
```

O custo é uma estimativa pela tabela da API. Não considera o preço do cache de 1 hora, o modo rápido nem planos de assinatura (Pro/Max), em que você não paga por token.

## Segurança e privacidade

- O server escuta só em `127.0.0.1` e recusa requisições com `Host` ou `Origin` que não sejam o próprio painel. Isso impede que um site aberto no navegador leia seu histórico ou injete eventos, inclusive por DNS rebinding.
- O `POST /event` só aceita `Content-Type: application/json`.
- O server só lê transcripts `.jsonl` dentro da pasta de dados do Claude Code (`~/.claude` ou `CLAUDE_CONFIG_DIR`).
- O hook envia um resumo: nome da ferramenta, caminho do arquivo, o início do comando, a tarefa delegada e o retorno do subagente. Nunca envia o conteúdo dos arquivos.
- O histórico fica em texto puro em `~/.squad-panel/historico`, fora do projeto. Se um comando seu tiver um token ou senha, os primeiros 80 caracteres dele vão parar lá. Apague a pasta quando quiser.
- O hook nunca bloqueia o Claude Code: qualquer falha termina em silêncio.

## Arquivos

| Arquivo | O que faz |
| --- | --- |
| `server.js` | Lê os agentes, recebe os eventos, calcula tokens e custo, guarda o histórico e serve o painel |
| `dashboard.html` | O painel (grafo, linha do tempo, logs e detalhes) |
| `send-event.js` | O hook do Claude Code: resume cada evento e envia ao server |
| `setup.js` | Opcional: instala ou remove os hooks num projeto |
