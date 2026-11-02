# Universal Downloader para Brave

Extensão local que disponibiliza ações no separador atual do Instagram ou YouTube. Os downloads são processados pelo servidor UniversalDownloader já existente; os ficheiros da aplicação original não são alterados.

## Instalação

1. Abre a pasta `C:\xampp\htdocs\UniversalDownloader`.
2. Faz duplo clique em `iniciar.bat`. Vai abrir uma janela preta; **não a feches enquanto estiveres a usar a extensão**. Essa janela mantém o motor de downloads ligado.
3. Confirma que `http://localhost:3000` abre no Brave. Se não abrir, a janela do servidor pode ter mostrado um erro ou o Node.js pode não estar instalado.
4. No Brave, abre `brave://extensions`.
5. Ativa **Modo de programador**.
6. Seleciona **Carregar descompactada** e escolhe esta pasta:
   `C:\xampp\htdocs\UniversalDownloader-Brave-Extension`
7. Abre uma publicação, Reel, Story/Destaque do Instagram ou vídeo/playlist do YouTube e clica no ícone da extensão.
8. Se já tinhas a extensão instalada antes de atualizar os ficheiros, volta a `brave://extensions`, carrega em **Recarregar** na extensão e fecha e reabre o popup.

## Utilização

### Instagram

Nas páginas do Instagram, a extensão acrescenta **↓ Descarregar** uma vez por publicação, carrossel ou Reel detetado. No feed inicial e na listagem `/reels/`, o botão fica sobre a parte inferior do conteúdo e não ocupa espaço no layout. Comentários não recebem botões. Numa publicação (`/p/<id>/`) ou Reel aberto individualmente (`/reel/<id>/` ou `/reels/<id>/`), aparece uma única ação no canto inferior do ecrã, nunca outra no cabeçalho. Clica no botão do conteúdo que queres guardar; não precisas de copiar o link nem abrir o popup. O botão mostra o estado da transferência e o Brave inicia o download quando estiver pronto.

Na visualização de Stories ou Destaques, aparece uma única ação fixa no canto inferior do ecrã. O popup continua disponível como alternativa para o conteúdo do separador atual. A extensão usa a sessão já aberta no Brave; um carrossel com vários ficheiros pode ser entregue num ZIP.

### YouTube

Na página do vídeo ou playlist, abre a extensão e seleciona **Carregar informações**. Depois escolhe a qualidade e **Vídeo MP4** ou **Áudio MP3**. Para playlists, podes escolher o item inicial, o limite e a ordem.

## Privacidade e requisitos

- Os cookies são lidos apenas quando carregas num botão de ação, mantidos em memória durante o pedido e enviados apenas para `http://localhost:3000`.
- A extensão não guarda cookies em `storage`, ficheiros ou histórico próprio.
- Não introduzas nem partilhes cookies manualmente. A extensão precisa das permissões Brave para ler cookies dos domínios indicados no `manifest.json`.
- O servidor Node local tem de permanecer em execução. A extensão não contém nem substitui os executáveis `yt-dlp`, `gallery-dl` ou `ffmpeg`.
- Acesso a Stories, Destaques e contas privadas depende de uma sessão válida no Brave e do suporte atual do `gallery-dl`. Restrições ou alterações do Instagram/YouTube podem impedir alguns downloads.
- Usa downloads apenas para conteúdo que tens autorização para guardar.

## Diagnóstico

| Problema | Verificação |
|---|---|
| A extensão mostra que não consegue ligar / “Failed to fetch” | Abre `C:\xampp\htdocs\UniversalDownloader\iniciar.bat` e deixa a janela preta aberta. Confirma também que `http://localhost:3000` abre no Brave. |
| Os ficheiros da extensão foram atualizados mas o popup continua igual | Em `brave://extensions`, carrega em **Recarregar** na extensão e abre novamente o popup. |
| Não aparece botão numa publicação ou Reel | Em `brave://extensions`, carrega em **Recarregar** na extensão e atualiza o Instagram. O botão requer um link individual reconhecido dentro do conteúdo. |
| `localhost:3000` não abre mesmo com `iniciar.bat` | Confirma que o Node.js está instalado e verifica se a janela preta mostra algum erro. |
| Sem sessão para conteúdo privado | Inicia sessão no Instagram/YouTube no mesmo perfil Brave e tenta novamente. |
| URL ou tipo de conteúdo não suportado | Confirma que estás na página individual do vídeo/publicação/Story/Destaque e atualiza os extratores do projeto pelos procedimentos já usados nele. |
| Cookies não encontrados | Verifica as permissões da extensão em `brave://extensions` e volta a abrir o popup no separador do serviço. |
