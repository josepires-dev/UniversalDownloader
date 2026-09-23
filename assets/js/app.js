document.addEventListener('DOMContentLoaded', () => {
    const urlSection = document.getElementById('urlSection');
    const urlInput = document.getElementById('urlInput');
    const fetchBtn = document.getElementById('fetchBtn');
    const cookiesDragZone = document.getElementById('cookiesDragZone');
    const cookiesFileInput = document.getElementById('cookiesFileInput');
    const fileInfoContainer = document.getElementById('fileInfoContainer');
    const fileNameDisplay = document.getElementById('fileNameDisplay');
    const btnRemoveFile = document.getElementById('btnRemoveFile');
    const configSection = document.getElementById('configSection');
    const videoThumbnail = document.getElementById('videoThumbnail');
    const videoDuration = document.getElementById('videoDuration');
    const videoTitle = document.getElementById('videoTitle');
    const videoUploader = document.getElementById('videoUploader');
    const tabButtons = document.querySelectorAll('.tab-btn');
    const qualityGroup = document.getElementById('qualityGroup');
    const qualitySelect = document.getElementById('qualitySelect');
    const playlistGroup = document.getElementById('playlistGroup');
    const playlistStart = document.getElementById('playlistStart');
    const playlistLimit = document.getElementById('playlistLimit');
    const playlistReverse = document.getElementById('playlistReverse');
    const audioAlert = document.getElementById('audioAlert');
    const cancelBtn = document.getElementById('cancelBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const processingState = document.getElementById('processingState');
    const progressTitle = document.getElementById('progressTitle');
    const progressSub = document.getElementById('progressSub');
    const progressBar = document.getElementById('progressBar');
    const successState = document.getElementById('successState');
    const successText = document.getElementById('successText');
    const fileDownloadLink = document.getElementById('fileDownloadLink');
    const resetBtn = document.getElementById('resetBtn');
    const historyList = document.getElementById('historyList');
    const clearHistoryBtn = document.getElementById('clearHistoryBtn');

    const historyKey = 'yt_dl_history';
    const maxCookieBytes = 2 * 1024 * 1024;
    let videoData = null;
    let selectedType = 'video';
    let uploadedCookiesText = '';
    let currentDownloadUrl = '';
    let downloadHistory = readHistory();

    renderHistory();

    fetchBtn.addEventListener('click', fetchVideoInfo);
    urlInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            fetchVideoInfo();
        }
    });

    cookiesDragZone.addEventListener('click', (event) => {
        if (!event.target.closest('#btnRemoveFile')) cookiesFileInput.click();
    });
    ['dragenter', 'dragover'].forEach((eventName) => cookiesDragZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        cookiesDragZone.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach((eventName) => cookiesDragZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        cookiesDragZone.classList.remove('dragover');
    }));
    cookiesDragZone.addEventListener('drop', (event) => handleCookieFile(event.dataTransfer?.files?.[0]));
    cookiesFileInput.addEventListener('change', () => handleCookieFile(cookiesFileInput.files?.[0]));
    btnRemoveFile.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        uploadedCookiesText = '';
        cookiesFileInput.value = '';
        fileNameDisplay.textContent = '';
        fileInfoContainer.classList.add('hidden');
    });

    tabButtons.forEach((button) => button.addEventListener('click', () => {
        selectedType = button.dataset.type === 'audio' ? 'audio' : 'video';
        tabButtons.forEach((tab) => tab.classList.toggle('active', tab === button));
        qualityGroup.classList.toggle('hidden', selectedType === 'audio');
        audioAlert.classList.toggle('hidden', selectedType !== 'audio');
    }));

    cancelBtn.addEventListener('click', () => {
        configSection.classList.add('hidden');
        urlSection.classList.remove('hidden');
        videoData = null;
        urlInput.focus();
    });

    downloadBtn.addEventListener('click', startDownload);
    resetBtn.addEventListener('click', resetApplication);
    clearHistoryBtn.addEventListener('click', () => {
        downloadHistory = [];
        localStorage.removeItem(historyKey);
        renderHistory();
    });
    window.addEventListener('beforeunload', releaseDownloadUrl);

    async function fetchVideoInfo() {
        const url = urlInput.value.trim();
        if (!isValidHttpUrl(url)) {
            urlInput.focus();
            window.alert('Por favor, cole um link HTTP ou HTTPS válido.');
            return;
        }

        if (url.includes('instagram.com')) {
            startDirectGalleryDownload(url);
            return;
        }

        urlSection.classList.add('hidden');
        processingState.classList.remove('hidden');
        const sourceLabel = getSourceLabel(url);
        progressTitle.textContent = `A procurar informações de ${sourceLabel}...`;
        progressSub.textContent = 'A identificar o conteúdo e as qualidades disponíveis.';
        progressBar.style.width = '20%';
        fetchBtn.disabled = true;

        try {
            const response = await fetch('api/info.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, cookies_text: uploadedCookiesText })
            });
            if (!response.ok) throw new Error(await readServerError(response));
            videoData = await response.json();
            populateVideoInfo(videoData);
            processingState.classList.add('hidden');
            configSection.classList.remove('hidden');
        } catch (error) {
            processingState.classList.add('hidden');
            urlSection.classList.remove('hidden');
            window.alert(error instanceof Error ? error.message : 'Falha ao obter informações do link.');
        } finally {
            fetchBtn.disabled = false;
        }
    }

    async function startDirectGalleryDownload(url) {
        urlSection.classList.add('hidden');
        processingState.classList.remove('hidden');
        const sourceLabel = getSourceLabel(url);
        progressTitle.textContent = `A transferir conteúdo de ${sourceLabel}...`;
        progressSub.textContent = 'A analisar o conteúdo para identificar se é imagem, vídeo ou galeria.';
        progressBar.style.width = '50%';
        fetchBtn.disabled = true;

        try {
            const response = await fetch('api/insta_download.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, cookies_text: uploadedCookiesText })
            });
            if (!response.ok) throw new Error(await readServerError(response));
            
            const blob = await response.blob();
            if (blob.size === 0) throw new Error('O servidor não devolveu ficheiros.');
            
            progressBar.style.width = '100%';
            
            const contentDisposition = response.headers.get('content-disposition');
            let filename = getFilename(contentDisposition);
            if (!filename || filename === 'download' || !filename.includes('.')) {
                const contentType = (response.headers.get('content-type') || blob.type || '').toLowerCase();
                if (contentType.includes('zip')) filename = 'galeria.zip';
                else if (contentType.includes('jpeg') || contentType.includes('jpg')) filename = 'imagem.jpg';
                else if (contentType.includes('png')) filename = 'imagem.png';
                else filename = 'video.mp4';
            }
            const contentKind = getContentKind(response.headers.get('content-type') || blob.type, filename);
            progressTitle.textContent = `A preparar ${contentKind} de ${sourceLabel}...`;
            progressSub.textContent = 'A preparar o ficheiro para guardar no navegador.';
            
            releaseDownloadUrl();
            currentDownloadUrl = URL.createObjectURL(blob);
            fileDownloadLink.href = currentDownloadUrl;
            fileDownloadLink.setAttribute('download', filename);
            successText.textContent = `O ficheiro "${filename}" está pronto para descarregar.`;
            
            window.setTimeout(() => {
                fileDownloadLink.click();
                processingState.classList.add('hidden');
                successState.classList.remove('hidden');
                addHistoryItem(filename, filename, 'video');
            }, 450);
        } catch (error) {
            processingState.classList.add('hidden');
            urlSection.classList.remove('hidden');
            window.alert(error instanceof Error ? error.message : 'Falha ao transferir a galeria.');
        } finally {
            fetchBtn.disabled = false;
        }
    }

    function populateVideoInfo(info) {
        videoThumbnail.src = typeof info.thumbnail === 'string' && info.thumbnail !== '' ? info.thumbnail : 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="640" height="360"%3E%3Crect width="100%25" height="100%25" fill="%23111827"/%3E%3C/svg%3E';
        videoDuration.textContent = typeof info.duration === 'string' ? info.duration : '00:00';
        videoTitle.textContent = typeof info.title === 'string' ? info.title : 'Vídeo sem título';
        videoUploader.replaceChildren();
        const icon = document.createElement('i');
        icon.className = 'fa-regular fa-user';
        icon.setAttribute('aria-hidden', 'true');
        videoUploader.append(icon, document.createTextNode(` ${typeof info.uploader === 'string' ? info.uploader : 'Canal desconhecido'}`));

        qualitySelect.replaceChildren();
        addQualityOption('best', 'Melhor qualidade disponível (Auto)');
        if (Array.isArray(info.formats)) {
            info.formats.forEach((format) => {
                if (format && Number.isInteger(format.height)) {
                    addQualityOption(String(format.height), `${format.height}p (${String(format.ext || 'mp4').toUpperCase()})`);
                }
            });
        }
        playlistGroup.classList.toggle('hidden', !Boolean(info.is_playlist));
    }

    function addQualityOption(value, label) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        qualitySelect.append(option);
    }

    async function startDownload() {
        if (!videoData?.original_url) return;
        configSection.classList.add('hidden');
        processingState.classList.remove('hidden');
        const sourceLabel = getSourceLabel(videoData.original_url);
        const contentKind = selectedType === 'audio' ? 'áudio' : (videoData.is_playlist ? 'playlist de vídeos' : 'vídeo');
        progressTitle.textContent = `A transferir ${contentKind} de ${sourceLabel}...`;
        progressSub.textContent = videoData.is_playlist
            ? 'A preparar os itens selecionados e a criar a galeria de ficheiros.'
            : 'A preparar o ficheiro. Isto pode demorar alguns minutos, dependendo do tamanho.';
        progressBar.style.width = '0%';
        downloadBtn.disabled = true;

        let progressValue = 0;
        const progressInterval = window.setInterval(() => {
            if (progressValue < 90) {
                progressValue += (90 - progressValue) * 0.08;
                progressBar.style.width = `${progressValue}%`;
            }
        }, 300);

        try {
            const response = await fetch('api/download.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: videoData.original_url,
                    type: selectedType,
                    quality: qualitySelect.value,
                    download_name: buildDownloadName(videoData.title, selectedType),
                    cookies_text: uploadedCookiesText,
                    playlist_start: playlistStart.value ? Number.parseInt(playlistStart.value, 10) : 1,
                    playlist_limit: playlistLimit.value ? Number.parseInt(playlistLimit.value, 10) : null,
                    playlist_reverse: playlistReverse.checked
                })
            });
            if (!response.ok) throw new Error(await readServerError(response));
            const blob = await response.blob();
            if (blob.size === 0) throw new Error('O servidor não devolveu nenhum ficheiro.');

            window.clearInterval(progressInterval);
            progressBar.style.width = '100%';
            const filename = getFilename(response.headers.get('content-disposition')) || buildDownloadName(videoData.title, selectedType);
            releaseDownloadUrl();
            currentDownloadUrl = window.URL.createObjectURL(blob);
            fileDownloadLink.href = currentDownloadUrl;
            fileDownloadLink.setAttribute('download', filename);
            successText.textContent = `O ficheiro “${filename}” está pronto para guardar.`;

            window.setTimeout(() => {
                fileDownloadLink.click();
                processingState.classList.add('hidden');
                successState.classList.remove('hidden');
                addHistoryItem(videoData.title || filename, filename, selectedType);
            }, 550);
        } catch (error) {
            processingState.classList.add('hidden');
            configSection.classList.remove('hidden');
            window.alert(error instanceof Error ? error.message : 'Ocorreu um erro durante o download.');
        } finally {
            window.clearInterval(progressInterval);
            downloadBtn.disabled = false;
        }
    }

    async function handleCookieFile(file) {
        if (!file) return;
        if (!file.name.toLowerCase().endsWith('.txt')) {
            window.alert('Por favor, selecione um ficheiro de texto (.txt) contendo os cookies.');
            return;
        }
        if (file.size > maxCookieBytes) {
            window.alert('O ficheiro de cookies excede o limite de 2 MB.');
            return;
        }
        try {
            uploadedCookiesText = await file.text();
            fileNameDisplay.textContent = file.name;
            fileInfoContainer.classList.remove('hidden');
        } catch (_) {
            uploadedCookiesText = '';
            fileInfoContainer.classList.add('hidden');
            window.alert('Não foi possível ler o ficheiro de cookies.');
        }
    }

    function resetApplication() {
        releaseDownloadUrl();
        successState.classList.add('hidden');
        urlSection.classList.remove('hidden');
        configSection.classList.add('hidden');
        urlInput.value = '';
        videoData = null;
        selectedType = 'video';
        tabButtons.forEach((tab, index) => tab.classList.toggle('active', index === 0));
        qualityGroup.classList.remove('hidden');
        audioAlert.classList.add('hidden');
        playlistGroup.classList.add('hidden');
        playlistStart.value = '1';
        playlistLimit.value = '';
        playlistReverse.checked = false;
        progressBar.style.width = '0%';
        urlInput.focus();
    }

    function addHistoryItem(title, filename, type) {
        downloadHistory.unshift({
            id: Date.now(),
            title: String(title || 'Mídia'),
            filename: String(filename || 'Ficheiro descarregado'),
            type,
            timestamp: new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' })
        });
        downloadHistory = downloadHistory.slice(0, 5);
        localStorage.setItem(historyKey, JSON.stringify(downloadHistory));
        renderHistory();
    }

    function readHistory() {
        try {
            const saved = JSON.parse(localStorage.getItem(historyKey) || '[]');
            return Array.isArray(saved) ? saved.slice(0, 5) : [];
        } catch (_) {
            return [];
        }
    }

    function renderHistory() {
        historyList.replaceChildren();
        if (downloadHistory.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'history-empty';
            empty.innerHTML = '<i class="fa-regular fa-folder-open empty-icon" aria-hidden="true"></i><p>Nenhum download realizado nesta sessão.</p>';
            historyList.append(empty);
            return;
        }
        downloadHistory.forEach((item) => {
            const row = document.createElement('div');
            row.className = 'history-item';
            const info = document.createElement('div');
            info.className = 'history-info';
            const icon = document.createElement('i');
            icon.className = `fa-solid ${item.type === 'audio' ? 'fa-file-audio audio' : 'fa-file-video video'} history-file-icon`;
            icon.setAttribute('aria-hidden', 'true');
            const details = document.createElement('div');
            details.className = 'history-details';
            const name = document.createElement('span');
            name.className = 'history-name';
            name.title = item.filename;
            name.textContent = item.filename;
            const meta = document.createElement('span');
            meta.className = 'history-meta';
            meta.textContent = `Salvo como ${String(item.type || 'video').toUpperCase()} às ${item.timestamp || '—'}`;
            details.append(name, meta);
            info.append(icon, details);
            const actions = document.createElement('div');
            actions.className = 'history-actions';
            const badge = document.createElement('span');
            badge.className = 'badge history-status';
            badge.textContent = 'Concluído';
            actions.append(badge);
            row.append(info, actions);
            historyList.append(row);
        });
    }

    async function readServerError(response) {
        try {
            const body = await response.json();
            return typeof body.error === 'string' ? body.error : 'O servidor não conseguiu processar o pedido.';
        } catch (_) {
            return `O servidor devolveu o erro ${response.status}.`;
        }
    }

    function buildDownloadName(title, type) {
        const extension = type === 'audio' ? '.mp3' : '.mp4';
        const cleaned = String(title || 'download')
            .replace(/[<>:"/\\\\|?*\u0000-\u001F]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/[. ]+$/g, '')
            .slice(0, 160);
        return `${cleaned || 'download'}${extension}`;
    }

    function getFilename(disposition) {
        if (!disposition) return '';
        const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i);
        if (encoded?.[1]) {
            try { return decodeURIComponent(encoded[1]); } catch (_) { return encoded[1]; }
        }
        const standard = disposition.match(/filename=(?:"([^"]+)"|([^;\s]+))/i);
        return standard ? (standard[1] || standard[2] || '') : '';
    }

    function isValidHttpUrl(value) {
        try {
            const parsed = new URL(value);
            return parsed.protocol === 'http:' || parsed.protocol === 'https:';
        } catch (_) {
            return false;
        }
    }

    function getSourceLabel(value) {
        try {
            const host = new URL(value).hostname.toLowerCase().replace(/^www\./, '');
            if (host === 'youtube.com' || host === 'youtu.be' || host.endsWith('.youtube.com')) return 'YouTube';
            if (host === 'instagram.com' || host.endsWith('.instagram.com')) return 'Instagram';
            return host || 'este site';
        } catch (_) {
            return 'este site';
        }
    }

    function getContentKind(contentType, filename) {
        const type = String(contentType || '').toLowerCase();
        const extension = String(filename || '').toLowerCase().split('.').pop();
        if (type.includes('zip') || extension === 'zip') return 'a galeria';
        if (type.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(extension)) return 'a imagem';
        if (type.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'opus'].includes(extension)) return 'o áudio';
        if (type.startsWith('video/') || ['mp4', 'webm', 'mov', 'mkv'].includes(extension)) return 'o vídeo';
        return 'o conteúdo';
    }

    function releaseDownloadUrl() {
        if (currentDownloadUrl) {
            window.URL.revokeObjectURL(currentDownloadUrl);
            currentDownloadUrl = '';
        }
    }
});
