<?php
declare(strict_types=1);
$config = require __DIR__ . DIRECTORY_SEPARATOR . 'config.php';
?>
<!doctype html>
<html lang="pt-PT">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= htmlspecialchars((string) $config['app_name'], ENT_QUOTES, 'UTF-8') ?></title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@400;500;600;700;800&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link rel="stylesheet" href="assets/css/app.css">
</head>
<body>
    <div class="background-decorations" aria-hidden="true"><div class="circle circle-1"></div><div class="circle circle-2"></div><div class="circle circle-3"></div></div>
    <div class="app-container">
        <header class="app-header">
            <div class="logo"><i class="fa-solid fa-cloud-arrow-down logo-icon" aria-hidden="true"></i><h1>Universal Downloader</h1></div>
            <p class="subtitle">Baixe vídeos e áudios do YouTube e galerias/fotos do Instagram.</p>
            <div class="header-badges"><span class="badge"><i class="fa-solid fa-shield-halved" aria-hidden="true"></i> Modo Local</span><span class="badge badge-soft"><i class="fa-solid fa-bolt" aria-hidden="true"></i> Sem nuvem</span></div>
        </header>

        <main class="main-content">
            <section class="glass-card downloader-card" aria-label="Preparar download">
                <div class="download-modes" aria-label="Modos suportados">
                    <span class="download-mode active"><i class="fa-solid fa-video" aria-hidden="true"></i> Vídeo MP4</span>
                    <span class="download-mode"><i class="fa-solid fa-music" aria-hidden="true"></i> Áudio MP3</span>
                    <span class="download-mode"><i class="fa-brands fa-instagram" aria-hidden="true"></i> Galerias</span>
                </div>
                <div id="urlSection" class="config-section">
                    <div class="form-group">
                        <label for="urlInput" class="form-label">Cole o link do vídeo/áudio:</label>
                        <div class="url-input-wrapper">
                            <i class="fa-solid fa-link url-icon-inside" aria-hidden="true"></i>
                            <input type="url" id="urlInput" placeholder="Cole o link aqui (ex.: youtube.com/watch...)" required autocomplete="off" maxlength="2048">
                            <button type="button" id="fetchBtn" class="btn-fetch" title="Buscar informações" aria-label="Buscar informações"><i class="fa-solid fa-arrow-right" aria-hidden="true"></i></button>
                        </div>
                    </div>
                    <div class="form-group cookies-upload-group">
                        <label class="form-label" for="cookiesFileInput">Ficheiro <code class="code-highlight">cookies.txt</code> (Opcional):</label>
                        <div class="cookies-drag-drop" id="cookiesDragZone">
                            <i class="fa-solid fa-file-shield upload-icon" aria-hidden="true"></i>
                            <p class="upload-text">Arraste e solte o ficheiro <code class="code-highlight">cookies.txt</code> aqui ou <span class="upload-browse">procure no computador</span></p>
                            <input type="file" id="cookiesFileInput" accept=".txt,text/plain" class="hidden-file-input">
                            <div class="file-info-container hidden" id="fileInfoContainer"><span class="file-name" id="fileNameDisplay"></span><button type="button" class="btn-remove-file" id="btnRemoveFile" aria-label="Remover ficheiro"><i class="fa-solid fa-trash" aria-hidden="true"></i></button></div>
                        </div>
                    </div>
                </div>

                <div id="configSection" class="config-section hidden">
                    <div class="video-preview-card">
                        <div class="thumbnail-wrapper"><img id="videoThumbnail" src="" alt="Capa do vídeo"><span id="videoDuration" class="video-duration">00:00</span></div>
                        <div class="video-details"><h3 id="videoTitle" class="video-title">Título do Vídeo</h3><span id="videoUploader" class="video-uploader"><i class="fa-regular fa-user" aria-hidden="true"></i> Canal</span></div>
                    </div>
                    <div class="form-group"><label class="form-label">Selecione o formato de saída:</label><div class="format-tabs"><button type="button" class="tab-btn active" data-type="video"><i class="fa-solid fa-video" aria-hidden="true"></i> Vídeo (MP4)</button><button type="button" class="tab-btn" data-type="audio"><i class="fa-solid fa-music" aria-hidden="true"></i> Áudio (MP3)</button></div></div>
                    <div class="form-group" id="qualityGroup"><label for="qualitySelect" class="form-label">Qualidade de vídeo disponível:</label><select id="qualitySelect" class="form-select"><option value="best">Melhor qualidade disponível (Auto)</option></select></div>
                    <div class="form-group hidden" id="playlistGroup">
                        <label class="form-label">Opções de Playlist/Canal:</label>
                        <div class="playlist-options"><label for="playlistStart">Começar do Nº:</label><input type="number" id="playlistStart" min="1" value="1"><label for="playlistLimit">Quantos baixar:</label><input type="number" id="playlistLimit" min="1" placeholder="Ex.: 10"><label class="playlist-reverse"><input type="checkbox" id="playlistReverse"> Baixar do mais antigo para o mais novo</label></div>
                    </div>
                    <div class="alert-info hidden" id="audioAlert"><i class="fa-solid fa-circle-info alert-icon" aria-hidden="true"></i><p>O ficheiro será extraído em áudio de alta fidelidade e convertido para <strong>MP3 (320 kbps)</strong>.</p></div>
                    <div class="action-buttons-group"><button type="button" id="cancelBtn" class="btn-reset"><i class="fa-solid fa-arrow-left" aria-hidden="true"></i> Voltar</button><button type="button" id="downloadBtn" class="btn-download-action"><span>Baixar Mídia</span><i class="fa-solid fa-cloud-arrow-down btn-icon-right" aria-hidden="true"></i></button></div>
                </div>

                <div id="processingState" class="processing-state hidden" aria-live="polite"><div class="spinner-wrapper"><div class="spinner"></div><i class="fa-solid fa-circle-play spinning-play" aria-hidden="true"></i></div><h3 id="progressTitle">Processando vídeo...</h3><p id="progressSub">Extraindo metadados e preparando o download.</p><div class="progress-bar-container"><div class="progress-bar" id="progressBar"></div></div></div>
                <div id="successState" class="success-state hidden" aria-live="polite"><div class="success-icon-wrapper"><i class="fa-solid fa-circle-check success-icon" aria-hidden="true"></i></div><h3>Download concluído com sucesso!</h3><p id="successText">O ficheiro está pronto para guardar no navegador.</p><div class="action-buttons-group"><a id="fileDownloadLink" class="btn-download-file" href="#" download><i class="fa-solid fa-file-arrow-down" aria-hidden="true"></i> Salvar Arquivo</a><button type="button" id="resetBtn" class="btn-reset"><i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i> Baixar outro vídeo</button></div></div>
            </section>
            <section class="glass-card history-card" aria-labelledby="history-title"><div class="history-header"><h3 id="history-title"><i class="fa-solid fa-history" aria-hidden="true"></i> Histórico de Downloads</h3><button id="clearHistoryBtn" class="btn-clear-history" type="button">Limpar Histórico</button></div><div id="historyList" class="history-list" aria-live="polite"><div class="history-empty"><i class="fa-regular fa-folder-open empty-icon" aria-hidden="true"></i><p>Nenhum download realizado nesta sessão.</p></div></div></section>
        </main>
    </div>
    <script src="assets/js/app.js" defer></script>
</body>
</html>
