# MultiSite Video Downloader — versão XAMPP

Esta é uma reconstrução de raiz do projeto anexado para executar diretamente no **Apache e PHP do XAMPP**. Não utiliza Flask, Python, ambiente virtual nem `server.py` em execução.

A aplicação consulta metadados através do `yt-dlp`, apresenta miniatura, duração, autor e qualidades, permite baixar em **MP4** ou **MP3**, suporta playlists, aceita `cookies.txt` opcional e mantém histórico local no navegador.

## Componentes

| Componente | Função | Necessário no XAMPP |
|---|---|---|
| `index.php` | Interface do downloader | Apache + PHP |
| `api/info.php` | Consulta título, duração, miniatura e qualidades | PHP com `proc_open` |
| `api/download.php` | Inicia o download e transmite o resultado | PHP com `proc_open` |
| `lib/YtDlpService.php` | Validação, execução do yt-dlp, playlists, ZIP e limpeza | PHP + extensão ZIP |
| `tools/yt-dlp.exe` | Extrator de vídeo e áudio para os sites suportados | Incluído |
| `tools/ffmpeg.exe` | Junta fluxos de vídeo e áudio e converte MP3 | Incluído |
| `storage/tmp/` | Diretório temporário por pedido | Escrita permitida ao Apache |

## Instalação no XAMPP para Windows

1. Extraia a pasta `multisite-video-downloader-xampp` para `C:\xampp\htdocs\`.
2. Confirme que existem `yt-dlp.exe` e `ffmpeg.exe` em `C:\xampp\htdocs\multisite-video-downloader-xampp\tools\`.
3. Abra `C:\xampp\php\php.ini` e ative a linha `extension=zip`.
4. Na diretiva `disable_functions`, confirme que `proc_open`, `proc_close`, `proc_get_status` e `proc_terminate` não estão bloqueadas.
5. Inicie ou reinicie o Apache no painel do XAMPP. MySQL não é necessário.
6. Abra `http://localhost/multisite-video-downloader-xampp/`.

## Utilização

Cole uma URL pública HTTP ou HTTPS e selecione a seta para obter os metadados. A aplicação mostra título, miniatura, duração e resoluções identificadas. Escolha **Vídeo (MP4)** ou **Áudio (MP3)** e inicie o download. Para MP4, a aplicação privilegia vídeo H.264 e áudio AAC, formatos compatíveis com os leitores comuns do Windows, e devolve apenas o caminho final confirmado pelo yt-dlp após a combinação de mídia. O ficheiro é guardado automaticamente com o título extraído do vídeo, nunca com o nome genérico `video.mp4`.

| Opção | Resultado |
|---|---|
| Vídeo + Melhor qualidade | Melhor combinação de vídeo e áudio disponível, entregue em MP4 quando possível |
| Vídeo + resolução | Melhor vídeo até à resolução escolhida, com áudio, entregue em MP4 quando possível |
| Áudio | Melhor áudio disponível convertido para MP3, com qualidade configurada para 320 kbps |
| Playlist/canal | Pode definir primeiro item, limite e ordem; vários ficheiros são devolvidos num ZIP |
| `cookies.txt` | Opcional; use apenas cookies exportados da sua própria sessão quando um site exigir autenticação |

O histórico fica somente no `localStorage` do navegador e pode ser limpo pelo botão da página. Os cookies carregados e os ficheiros obtidos são colocados numa pasta temporária exclusiva e apagados após a resposta ser enviada.

## Segurança e limites

A versão PHP aceita apenas URLs HTTP/HTTPS públicas e recusa `localhost`, domínios `.local` e endereços IP privados/reservados. Cada comando é montado com argumentos escapados individualmente. A aplicação limita os cookies a 2 MB, impõe tempo máximo de processamento e limita cada pedido de playlist a 500 itens.

O acesso HTTP direto a `lib/`, `tools/` e `storage/` é bloqueado por ficheiros `.htaccess`. Mantenha a aplicação apenas em `localhost`; não exponha o Apache à Internet nem reencaminhe portas do router para este utilitário.

## Diagnóstico

| Sintoma | Causa provável | Correção |
|---|---|---|
| `yt-dlp.exe` não encontrado | Extração incompleta ou ficheiro apagado | Extraia novamente o pacote e confirme `tools/yt-dlp.exe` |
| Falha ao juntar áudio ao MP4 ou converter MP3 | FFmpeg ausente | Confirme `tools/ffmpeg.exe` |
| Erro ao iniciar o extrator | `proc_open` bloqueado pelo PHP | Retire as funções necessárias de `disable_functions` e reinicie Apache |
| Erro ao criar ZIP | Extensão ZIP desativada | Ative `extension=zip` no `php.ini` |
| YouTube — HTTP 403 | O YouTube recusou o fluxo de mídia; a app tenta automaticamente um MP4 de compatibilidade | Atualize a página do vídeo no navegador e carregue um `cookies.txt` recente da sua própria sessão; alguns vídeos podem exigir PO Token do YouTube |
| Sem mídia obtida | URL inválida, conteúdo privado, bloqueado ou não suportado | Confirme a URL, use `cookies.txt` da sua própria conta se necessário e atualize o yt-dlp |
| Sem escrita em temporários | Apache sem permissão em `storage/tmp/` | Dê permissão de escrita à conta que executa o Apache |

## Estrutura entregue

```text
multisite-video-downloader-xampp/
├── api/
│   ├── download.php
│   └── info.php
├── assets/
│   ├── css/app.css
│   └── js/app.js
├── lib/YtDlpService.php
├── storage/tmp/.gitkeep
├── tools/
│   ├── ffmpeg.exe
│   └── yt-dlp.exe
├── .htaccess
├── config.php
├── index.php
└── README.md
```

O pacote inclui o binário nightly oficial do `yt-dlp` para Windows. Não inclui sessões, cookies, cache Python, bytecode nem ambiente virtual do projeto original.
