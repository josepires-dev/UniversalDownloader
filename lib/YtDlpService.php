<?php
declare(strict_types=1);

final class MediaDownloadException extends RuntimeException
{
    public function __construct(string $message, public readonly int $httpStatus = 500)
    {
        parent::__construct($message);
    }
}

final class YtDlpService
{
    /** @param array<string, mixed> $config */
    public function __construct(private readonly array $config)
    {
        $this->ensureDirectory((string) $this->config['temp_root']);
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{title:string,uploader:string,thumbnail:string,duration:string,formats:list<array{height:int,ext:string,note:string}>,original_url:string,is_playlist:bool}
     */
    public function getInfo(array $payload): array
    {
        $url = $this->validateUrl($payload['url'] ?? null);
        $cookies = $this->validateCookies($payload['cookies_text'] ?? '');
        $taskDir = $this->createTaskDirectory();

        try {
            $cookieFile = $this->writeCookies($taskDir, $cookies);
            $command = [
                $this->resolveYtDlp(),
                '--dump-single-json',
                '--skip-download',
                '--no-warnings',
                '--no-call-home',
                '--playlist-end',
                '1',
            ];
            $this->appendCookiesOption($command, $cookieFile);
            $command[] = $url;
            $output = $this->executeCommand($command, $taskDir);
            $decoded = json_decode($this->lastJsonObject($output), true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($decoded)) {
                throw new MediaDownloadException('Não foi possível interpretar as informações devolvidas pelo yt-dlp.', 502);
            }
            return $this->normaliseInfo($decoded, $url);
        } catch (JsonException) {
            throw new MediaDownloadException('O yt-dlp devolveu metadados inválidos para este link.', 502);
        } finally {
            $this->removeDirectory($taskDir);
        }
    }

    /**
     * @param array<string, mixed> $payload
     * @return array{file:string,name:string,mime:string,task_dir:string}
     */
    public function download(array $payload): array
    {
        $url = $this->validateUrl($payload['url'] ?? null);
        $cookies = $this->validateCookies($payload['cookies_text'] ?? '');
        $type = $this->validateType($payload['type'] ?? 'video');
        $quality = $this->validateQuality($payload['quality'] ?? 'best');
        $suggestedFilename = $this->suggestedFilename($payload['download_name'] ?? '', $type);
        $playlistStart = $this->validatePositiveInteger($payload['playlist_start'] ?? 1, 1, 'O início da playlist é inválido.');
        $playlistLimit = $this->validatePlaylistLimit($payload['playlist_limit'] ?? null);
        $playlistReverse = filter_var($payload['playlist_reverse'] ?? false, FILTER_VALIDATE_BOOL);
        $taskDir = $this->createTaskDirectory();

        try {
            $cookieFile = $this->writeCookies($taskDir, $cookies);
            $outputTemplate = $taskDir . DIRECTORY_SEPARATOR . '%(title).160B.%(ext)s';
            $command = [
                $this->resolveYtDlp(),
                '--output', $outputTemplate,
                '--no-part',
                '--no-warnings',
                '--no-call-home',
                '--ffmpeg-location', (string) $this->config['ffmpeg_location'],
                '--print', 'after_move:filepath',
                '--playlist-start', (string) $playlistStart,
            ];

            if ($playlistLimit !== null) {
                $playlistEnd = $playlistStart + $playlistLimit - 1;
                $command[] = '--playlist-end';
                $command[] = (string) $playlistEnd;
            }
            if ($playlistReverse) {
                $command[] = '--playlist-reverse';
            }

            if ($type === 'audio') {
                $command[] = '--format';
                $command[] = 'bestaudio/best';
                $command[] = '--extract-audio';
                $command[] = '--audio-format';
                $command[] = 'mp3';
                $command[] = '--audio-quality';
                $command[] = '320K';
            } else {
                $command[] = '--format';
                // Dá prioridade a H.264 + AAC no MP4, formato reproduzível pela maioria
                // dos leitores do Windows, antes de recorrer aos formatos mais novos.
                $command[] = $this->videoFormatSelector($quality);
                $command[] = '--merge-output-format';
                $command[] = 'mp4';
                $command[] = '--postprocessor-args';
                $command[] = 'ffmpeg:-movflags +faststart';
            }

            $this->appendCookiesOption($command, $cookieFile);
            $command[] = $url;
            $commandOutput = $this->executeWithYoutubeFallback($command, $taskDir, $url, $type);

            $files = $this->finalOutputFiles($commandOutput, $taskDir, $type);
            if ($files === []) {
                $files = $this->collectOutputFiles($taskDir, $cookieFile, $type);
            }
            if ($files === []) {
                throw new MediaDownloadException('Falha ao baixar o ficheiro. O yt-dlp não gerou nenhuma mídia compatível.', 422);
            }

            if (count($files) === 1) {
                $file = $files[0];
                return [
                    'file' => $file,
                    'name' => $suggestedFilename ?? $this->safeFilename(basename($file), $type === 'audio' ? 'audio.mp3' : 'video.mp4'),
                    'mime' => $this->mimeType($file),
                    'task_dir' => $taskDir,
                ];
            }

            $zipPath = $taskDir . DIRECTORY_SEPARATOR . 'playlist_downloads.zip';
            $this->createArchive($files, $taskDir, $zipPath);
            return [
                'file' => $zipPath,
                'name' => 'playlist_downloads.zip',
                'mime' => 'application/zip',
                'task_dir' => $taskDir,
            ];
        } catch (Throwable $exception) {
            $this->removeDirectory($taskDir);
            if ($exception instanceof MediaDownloadException) {
                throw $exception;
            }
            throw new MediaDownloadException('Ocorreu um erro interno durante o download.', 500);
        }
    }

    public function removeTaskDirectory(string $taskDir): void
    {
        $root = realpath((string) $this->config['temp_root']);
        $target = realpath($taskDir);
        if ($root !== false && $target !== false && str_starts_with($target, $root . DIRECTORY_SEPARATOR)) {
            $this->removeDirectory($target);
        }
    }

    /** @param array<string, mixed> $info */
    private function normaliseInfo(array $info, string $url): array
    {
        $isPlaylist = isset($info['entries']) || (($info['_type'] ?? '') === 'playlist');
        $preview = $info;
        if ($isPlaylist && isset($info['entries']) && is_array($info['entries'])) {
            foreach ($info['entries'] as $entry) {
                if (is_array($entry)) {
                    $preview = $entry;
                    break;
                }
            }
        }

        $formats = [];
        $seen = [];
        foreach (($preview['formats'] ?? $info['formats'] ?? []) as $format) {
            if (!is_array($format)) {
                continue;
            }
            $height = isset($format['height']) ? (int) $format['height'] : 0;
            if ($height <= 0 || isset($seen[$height]) || !in_array($height, [144, 240, 360, 480, 720, 1080, 1440, 2160], true)) {
                continue;
            }
            $seen[$height] = true;
            $formats[] = [
                'height' => $height,
                'ext' => strtolower((string) ($format['ext'] ?? 'mp4')),
                'note' => (string) ($format['format_note'] ?? ($height . 'p')),
            ];
        }
        usort($formats, static fn (array $left, array $right): int => $right['height'] <=> $left['height']);

        $thumbnail = (string) ($preview['thumbnail'] ?? $info['thumbnail'] ?? '');
        if ($thumbnail === '') {
            $thumbnails = $preview['thumbnails'] ?? $info['thumbnails'] ?? [];
            if (is_array($thumbnails)) {
                $last = end($thumbnails);
                if (is_array($last)) {
                    $thumbnail = (string) ($last['url'] ?? '');
                }
            }
        }
        $durationSeconds = (int) ($preview['duration'] ?? $info['duration'] ?? 0);

        return [
            'title' => (string) ($info['title'] ?? $preview['title'] ?? 'Vídeo sem título'),
            'uploader' => (string) ($preview['uploader'] ?? $info['uploader'] ?? 'Canal desconhecido'),
            'thumbnail' => $thumbnail,
            'duration' => sprintf('%02d:%02d', intdiv($durationSeconds, 60), $durationSeconds % 60),
            'formats' => $formats,
            'original_url' => $url,
            'is_playlist' => $isPlaylist,
        ];
    }

    private function validateUrl(mixed $value): string
    {
        if (!is_string($value)) {
            throw new MediaDownloadException('Envie uma URL válida.', 400);
        }
        $url = trim($value);
        if ($url === '' || strlen($url) > (int) $this->config['max_url_length'] || filter_var($url, FILTER_VALIDATE_URL) === false) {
            throw new MediaDownloadException('A URL informada não é válida.', 400);
        }
        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));
        if (!in_array($scheme, ['http', 'https'], true) || $host === '' || $this->isPrivateHost($host)) {
            throw new MediaDownloadException('Utilize uma URL pública HTTP ou HTTPS.', 400);
        }
        return $url;
    }

    private function validateCookies(mixed $value): string
    {
        if (!is_string($value) || strlen($value) > (int) $this->config['max_cookie_file_bytes'] || str_contains($value, "\0")) {
            throw new MediaDownloadException('O ficheiro de cookies é inválido ou excede o limite de 2 MB.', 400);
        }
        return trim($value);
    }

    private function validateType(mixed $value): string
    {
        return $value === 'audio' ? 'audio' : 'video';
    }

    private function validateQuality(mixed $value): string
    {
        $quality = is_string($value) ? strtolower(trim($value)) : 'best';
        if ($quality === 'best') {
            return 'best';
        }
        if (!ctype_digit($quality) || !in_array((int) $quality, [144, 240, 360, 480, 720, 1080, 1440, 2160], true)) {
            throw new MediaDownloadException('A qualidade de vídeo selecionada não é suportada.', 400);
        }
        return $quality;
    }

    private function validatePositiveInteger(mixed $value, int $fallback, string $message): int
    {
        if ($value === null || $value === '') {
            return $fallback;
        }
        $number = filter_var($value, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);
        if ($number === false) {
            throw new MediaDownloadException($message, 400);
        }
        return (int) $number;
    }

    private function validatePlaylistLimit(mixed $value): ?int
    {
        if ($value === null || $value === '') {
            return null;
        }
        $limit = $this->validatePositiveInteger($value, 1, 'O limite da playlist é inválido.');
        if ($limit > (int) $this->config['max_playlist_items']) {
            throw new MediaDownloadException('O limite máximo de itens por pedido é ' . (string) $this->config['max_playlist_items'] . '.', 400);
        }
        return $limit;
    }

    private function isPrivateHost(string $host): bool
    {
        if ($host === 'localhost' || $host === '::1' || str_ends_with($host, '.local')) {
            return true;
        }
        return filter_var($host, FILTER_VALIDATE_IP) !== false
            && filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
    }

    private function resolveYtDlp(): string
    {
        $binary = (string) $this->config['yt_dlp_binary'];
        if (!is_file($binary)) {
            throw new MediaDownloadException('O executável yt-dlp.exe não foi encontrado na pasta tools.', 500);
        }
        return $binary;
    }

    private function createTaskDirectory(): string
    {
        try {
            $name = bin2hex(random_bytes(16));
        } catch (Throwable) {
            $name = uniqid('download_', true);
        }
        $directory = rtrim((string) $this->config['temp_root'], DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $name;
        $this->ensureDirectory($directory);
        return $directory;
    }

    private function writeCookies(string $taskDir, string $cookies): ?string
    {
        if ($cookies === '') {
            return null;
        }
        $file = $taskDir . DIRECTORY_SEPARATOR . 'cookies.txt';
        if (@file_put_contents($file, $cookies, LOCK_EX) === false) {
            throw new MediaDownloadException('Não foi possível preparar o ficheiro de cookies temporário.', 500);
        }
        return $file;
    }

    /** @param list<string> $command */
    private function appendCookiesOption(array &$command, ?string $cookieFile): void
    {
        if ($cookieFile !== null) {
            $command[] = '--cookies';
            $command[] = $cookieFile;
        }
    }

    private function videoFormatSelector(string $quality): string
    {
        $limit = $quality === 'best' ? '' : '[height<=' . $quality . ']';
        return 'bv*[ext=mp4][vcodec^=avc]' . $limit . '+ba[ext=m4a][acodec^=mp4a]'
            . '/b[ext=mp4][vcodec^=avc][acodec^=mp4a]' . $limit
            . '/b[ext=mp4]' . $limit;
    }

    /** @param list<string> $command */
    private function executeWithYoutubeFallback(array $command, string $workingDirectory, string $url, string $type): string
    {
        try {
            return $this->executeCommand($command, $workingDirectory);
        } catch (MediaDownloadException $exception) {
            $isYoutube = preg_match('~^https?://(?:www\\.)?(?:youtube\\.com|youtu\\.be)/~i', $url) === 1;
            $is403 = str_contains($exception->getMessage(), 'HTTP Error 403');
            if (!$isYoutube || $type !== 'video' || !$is403) {
                throw $exception;
            }

            $formatPosition = array_search('--format', $command, true);
            if ($formatPosition === false || !isset($command[$formatPosition + 1])) {
                throw $exception;
            }

            // Alguns fluxos DASH separados do YouTube exigem PO Token. Tenta um MP4
            // único/progressivo antes de pedir cookies ou reportar o bloqueio externo.
            $fallback = $command;
            $fallback[$formatPosition + 1] = 'b[ext=mp4][vcodec!=none][acodec!=none]';
            try {
                return $this->executeCommand($fallback, $workingDirectory);
            } catch (MediaDownloadException $fallbackException) {
                if (str_contains($fallbackException->getMessage(), 'HTTP Error 403')) {
                    throw new MediaDownloadException(
                        'O YouTube recusou os fluxos de vídeo deste pedido (HTTP 403), inclusive no modo de compatibilidade. Atualize a página do vídeo no seu navegador e carregue um cookies.txt recente da sua própria sessão; alguns vídeos podem exigir um PO Token do YouTube.',
                        403
                    );
                }
                throw $fallbackException;
            }
        }
    }

    /** @param list<string> $arguments */
    private function executeCommand(array $arguments, string $workingDirectory): string
    {
        $descriptors = [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']];
        // A matriz passa cada argumento diretamente ao executável. Isto evita que o
        // cmd.exe reinterprete aspas, barras invertidas ou caracteres da URL no Windows.
        $process = @proc_open($arguments, $descriptors, $pipes, $workingDirectory, null, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            throw new MediaDownloadException('Não foi possível iniciar o yt-dlp a partir do Apache.', 500);
        }
        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);
        $output = '';
        $reportedExitCode = null;
        $startedAt = microtime(true);
        while (true) {
            $output .= stream_get_contents($pipes[1]) ?: '';
            $output .= stream_get_contents($pipes[2]) ?: '';
            $status = proc_get_status($process);
            if (!$status['running']) {
                $reportedExitCode = isset($status['exitcode']) ? (int) $status['exitcode'] : null;
                break;
            }
            if ((microtime(true) - $startedAt) >= (int) $this->config['command_timeout_seconds']) {
                @proc_terminate($process);
                fclose($pipes[1]);
                fclose($pipes[2]);
                proc_close($process);
                throw new MediaDownloadException('O download excedeu o tempo máximo de processamento.', 504);
            }
            usleep(100000);
        }
        $output .= stream_get_contents($pipes[1]) ?: '';
        $output .= stream_get_contents($pipes[2]) ?: '';
        fclose($pipes[1]);
        fclose($pipes[2]);
        $closedExitCode = proc_close($process);
        // Em algumas versões do PHP no Windows, proc_close() devolve -1 depois de
        // proc_get_status() já ter recolhido o estado final. Preserve o código real.
        $exitCode = ($closedExitCode === -1 && $reportedExitCode !== null)
            ? $reportedExitCode
            : $closedExitCode;
        if ($exitCode !== 0) {
            throw new MediaDownloadException('O yt-dlp não conseguiu processar este link. ' . $this->safeFailureSummary($output), 422);
        }
        return $output;
    }

    private function lastJsonObject(string $output): string
    {
        $lines = preg_split('/\R/', trim($output)) ?: [];
        for ($index = count($lines) - 1; $index >= 0; $index--) {
            $candidate = trim($lines[$index]);
            if (str_starts_with($candidate, '{') && str_ends_with($candidate, '}')) {
                return $candidate;
            }
        }
        return trim($output);
    }

    /** @return list<string> */
    private function finalOutputFiles(string $commandOutput, string $taskDir, string $type): array
    {
        $root = realpath($taskDir);
        if ($root === false) {
            return [];
        }
        $allowed = $type === 'audio' ? ['mp3'] : ['mp4', 'webm', 'mkv', 'mov', 'm4v'];
        $files = [];
        foreach (preg_split('/\\R/', trim($commandOutput)) ?: [] as $line) {
            $candidate = trim($line);
            if ($candidate === '' || !is_file($candidate)) {
                continue;
            }
            $real = realpath($candidate);
            $extension = strtolower(pathinfo($candidate, PATHINFO_EXTENSION));
            if ($real !== false && str_starts_with($real, $root . DIRECTORY_SEPARATOR) && in_array($extension, $allowed, true)) {
                $files[] = $real;
            }
        }
        return array_values(array_unique($files));
    }

    /** @return list<string> */
    private function collectOutputFiles(string $taskDir, ?string $cookieFile, string $type): array
    {
        $files = [];
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($taskDir, FilesystemIterator::SKIP_DOTS));
        $allowed = $type === 'audio'
            ? ['mp3']
            : ['mp4', 'webm', 'mkv', 'mov', 'm4v'];
        foreach ($iterator as $item) {
            if (!$item->isFile()) {
                continue;
            }
            $path = $item->getPathname();
            $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
            if (
                ($cookieFile !== null && $path === $cookieFile)
                || in_array($extension, ['part', 'ytdl', 'json', 'webp', 'jpg', 'jpeg', 'png', 'description'], true)
            ) {
                continue;
            }
            if (in_array($extension, $allowed, true)) {
                $files[] = $path;
            }
        }
        sort($files, SORT_NATURAL | SORT_FLAG_CASE);
        return $files;
    }

    /** @param list<string> $files */
    private function createArchive(array $files, string $taskDir, string $zipPath): void
    {
        if (!class_exists(ZipArchive::class)) {
            throw new MediaDownloadException('A extensão ZIP do PHP não está ativa. Ative extension=zip no php.ini.', 500);
        }
        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new MediaDownloadException('Não foi possível criar o ficheiro ZIP da playlist.', 500);
        }
        try {
            foreach ($files as $file) {
                $relative = ltrim(substr($file, strlen($taskDir)), DIRECTORY_SEPARATOR);
                if (!$zip->addFile($file, $relative)) {
                    throw new MediaDownloadException('Não foi possível adicionar um ficheiro ao ZIP.', 500);
                }
            }
        } finally {
            $zip->close();
        }
    }

    private function mimeType(string $file): string
    {
        return match (strtolower(pathinfo($file, PATHINFO_EXTENSION))) {
            'mp3' => 'audio/mpeg',
            'webm' => 'video/webm',
            'mkv' => 'video/x-matroska',
            'mov' => 'video/quicktime',
            default => 'video/mp4',
        };
    }

    private function suggestedFilename(mixed $value, string $type): ?string
    {
        if (!is_string($value) || trim($value) === '') {
            return null;
        }
        $extension = $type === 'audio' ? 'mp3' : 'mp4';
        $base = pathinfo(trim($value), PATHINFO_FILENAME);
        $name = $this->safeFilename($base . '.' . $extension, 'download.' . $extension);
        return $name === 'download.' . $extension ? null : $name;
    }

    private function safeFilename(string $filename, string $fallback): string
    {
        $filename = preg_replace('/[\\\\\/\x00-\x1F\x7F]+/u', '_', $filename) ?? '';
        return trim($filename) !== '' ? $filename : $fallback;
    }

    private function safeFailureSummary(string $output): string
    {
        $lines = preg_split('/\R/', trim($output)) ?: [];
        $lines = array_values(array_filter(array_map('trim', $lines), static fn (string $line): bool => $line !== ''));
        if ($lines === []) {
            return '';
        }

        // Prioriza a última mensagem de erro real em vez das linhas iniciais do progresso.
        for ($index = count($lines) - 1; $index >= 0; $index--) {
            $line = $lines[$index];
            if (preg_match('/(?:^ERROR:|\[error\]|failed|failure|cannot|unable|denied|invalid|not found)/i', $line) === 1) {
                return $this->cleanDiagnostic($line);
            }
        }

        return $this->cleanDiagnostic(implode(' | ', array_slice($lines, -3)));
    }

    private function cleanDiagnostic(string $message): string
    {
        $message = preg_replace('/https?:\/\/\S+/', '[link ocultado]', $message) ?? '';
        $message = preg_replace('/\s+/', ' ', trim($message)) ?? '';
        return substr($message, 0, 600);
    }

    private function ensureDirectory(string $directory): void
    {
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new MediaDownloadException('Não foi possível criar a pasta temporária. Verifique as permissões de escrita do Apache.', 500);
        }
    }

    private function removeDirectory(string $directory): void
    {
        if (!is_dir($directory)) {
            return;
        }
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($iterator as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($directory);
    }
}
