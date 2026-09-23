<?php
declare(strict_types=1);

final class DownloadException extends RuntimeException
{
    public function __construct(string $message, public readonly int $httpStatus = 400)
    {
        parent::__construct($message);
    }
}

/**
 * Núcleo PHP da aplicação. Não inicia nem depende de qualquer servidor Python.
 * Os únicos processos externos são os extratores de mídia escolhidos pelo utilizador.
 */
final class Downloader
{
    /** @var array<string, mixed> */
    private array $config;

    /** @var list<string> */
    private array $allowedBrowsers = ['none', 'chrome', 'edge', 'brave', 'firefox', 'opera', 'vivaldi'];

    /** @var callable(string): void|null */
    private $onLog = null;

    /** @param array<string, mixed> $config */
    public function __construct(array $config)
    {
        $this->config = $config;
        $this->ensureDirectory((string) $this->config['temp_root']);
    }

    /**
     * @param array<string, mixed> $payload
     * @param callable(string): void|null $onLog
     * @return array{file: string, name: string, mime: string, task_dir: string}
     */
    public function download(array $payload, ?callable $onLog = null): array
    {
        $this->onLog = $onLog;
        $url = $this->validateUrl($payload['url'] ?? null);
        $browser = $this->validateBrowser($payload['browser'] ?? 'none');
        $cookiesText = $this->validateCookies($payload['cookies_text'] ?? '');

        $taskDir = $this->createTaskDirectory();
        $cookieFile = null;

        try {
            if ($cookiesText !== '') {
                $cookieFile = $taskDir . DIRECTORY_SEPARATOR . 'cookies.txt';
                $written = @file_put_contents($cookieFile, $cookiesText, LOCK_EX);
                if ($written === false) {
                    throw new DownloadException('Não foi possível preparar o ficheiro de cookies temporário.', 500);
                }
            }

            $galleryOutput = $this->runExtractor(
                $this->resolveExecutable('gallery_dl_binary', 'gallery-dl.exe'),
                'gallery',
                $taskDir,
                $url,
                $browser,
                $cookieFile
            );

            // O gallery-dl é sempre a primeira e principal tentativa. Arquivos de áudio
            // isolados não contam como resultado, pois a aplicação entrega apenas fotos e vídeos.
            $files = $this->collectVisualMediaFiles($taskDir, $cookieFile);
            if ($files === []) {
                // O yt-dlp só é usado quando o gallery-dl não devolveu mídia visual.
                // No fallback, é obtido o melhor vídeo com a respetiva faixa de áudio.
                $ytDlpOutput = $this->runExtractor(
                    $this->resolveExecutable('yt_dlp_binary', 'yt-dlp.exe'),
                    'yt-dlp',
                    $taskDir,
                    $url,
                    $browser,
                    $cookieFile
                );
                $files = $this->collectVisualMediaFiles($taskDir, $cookieFile);

                if ($files === []) {
                    $detail = $this->safeFailureSummary($ytDlpOutput !== '' ? $ytDlpOutput : $galleryOutput);
                    throw new DownloadException('Não foi possível obter fotos ou vídeos nesse link. ' . $detail, 422);
                }
            }

            $videoFiles = array_values(array_filter($files, fn(string $f): bool => $this->isVideoFile($f)));
            if (count($files) === 1 || (count($videoFiles) === 1 && count($files) <= 3)) {
                $file = count($files) === 1 ? $files[0] : $videoFiles[0];
                return [
                    'file' => $file,
                    'name' => $this->safeFilename(basename($file), 'midia_baixada'),
                    'mime' => $this->mimeType($file),
                    'task_dir' => $taskDir,
                ];
            }

            $zipPath = $taskDir . DIRECTORY_SEPARATOR . $this->archiveNameForUrl($url);
            $this->createArchive($files, $taskDir, $zipPath);

            return [
                'file' => $zipPath,
                'name' => basename($zipPath),
                'mime' => 'application/zip',
                'task_dir' => $taskDir,
            ];
        } catch (Throwable $exception) {
            $this->removeDirectory($taskDir);
            if ($exception instanceof DownloadException) {
                throw $exception;
            }
            throw new DownloadException('Ocorreu um erro interno durante o processamento do download.', 500);
        }
    }

    public function removeTaskDirectory(string $taskDir): void
    {
        $temporaryRoot = realpath((string) $this->config['temp_root']);
        $target = realpath($taskDir);
        if ($temporaryRoot !== false && $target !== false && str_starts_with($target, $temporaryRoot . DIRECTORY_SEPARATOR)) {
            $this->removeDirectory($target);
        }
    }

    private function validateUrl(mixed $value): string
    {
        if (!is_string($value)) {
            throw new DownloadException('Envie uma URL válida.', 400);
        }

        $url = trim($value);
        if ($url === '' || strlen($url) > (int) $this->config['max_url_length']) {
            throw new DownloadException('A URL está vazia ou ultrapassa o tamanho permitido.', 400);
        }

        if (filter_var($url, FILTER_VALIDATE_URL) === false) {
            throw new DownloadException('A URL informada não é válida.', 400);
        }

        $parts = parse_url($url);
        $scheme = strtolower((string) ($parts['scheme'] ?? ''));
        $host = strtolower((string) ($parts['host'] ?? ''));
        if (!in_array($scheme, ['http', 'https'], true) || $host === '') {
            throw new DownloadException('Utilize apenas links públicos HTTP ou HTTPS.', 400);
        }

        if ($this->isLocalOrPrivateHost($host)) {
            throw new DownloadException('Links locais ou de redes privadas não são permitidos.', 400);
        }

        return $url;
    }

    private function validateBrowser(mixed $value): string
    {
        $browser = is_string($value) ? strtolower(trim($value)) : 'none';
        if (!in_array($browser, $this->allowedBrowsers, true)) {
            throw new DownloadException('O navegador selecionado não é suportado.', 400);
        }
        return $browser;
    }

    private function validateCookies(mixed $value): string
    {
        if (!is_string($value)) {
            throw new DownloadException('O conteúdo de cookies é inválido.', 400);
        }
        if (strlen($value) > (int) $this->config['max_cookie_file_bytes']) {
            throw new DownloadException('O ficheiro de cookies excede o limite de 2 MB.', 413);
        }
        if (str_contains($value, "\0")) {
            throw new DownloadException('O ficheiro de cookies contém dados inválidos.', 400);
        }
        return trim($value);
    }

    private function isLocalOrPrivateHost(string $host): bool
    {
        if ($host === 'localhost' || str_ends_with($host, '.local') || $host === '::1') {
            return true;
        }

        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
        }

        return false;
    }

    private function createTaskDirectory(): string
    {
        try {
            $id = bin2hex(random_bytes(16));
        } catch (Throwable) {
            $id = uniqid('download_', true);
        }
        $directory = rtrim((string) $this->config['temp_root'], DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $id;
        $this->ensureDirectory($directory);
        return $directory;
    }

    private function ensureDirectory(string $directory): void
    {
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new DownloadException('Não foi possível criar a pasta temporária. Verifique as permissões de escrita do Apache.', 500);
        }
    }

    private function resolveExecutable(string $configKey, string $displayName): string
    {
        $path = (string) ($this->config[$configKey] ?? '');
        if ($path === '' || !is_file($path)) {
            throw new DownloadException(
                sprintf('O extrator %s não foi encontrado. Copie o executável para a pasta tools ou ajuste config.php.', $displayName),
                500
            );
        }
        return $path;
    }

    private function runExtractor(
        string $executable,
        string $engine,
        string $taskDir,
        string $url,
        string $browser,
        ?string $cookieFile
    ): string {
        $command = [$executable];

        if ($engine === 'gallery') {
            $command[] = '--directory';
            $command[] = $taskDir;
            // Em stories e destaques estáticos do Instagram, prefere a imagem original
            // em vez do MP4 artificial servido apenas por conter áudio associado.
            if (str_contains(strtolower($url), 'instagram.com')) {
                $command[] = '-o';
                $command[] = 'extractor.instagram.static-videos=false';
            }
            if ($cookieFile !== null) {
                $command[] = '--cookies';
                $command[] = $cookieFile;
            } elseif ($browser !== 'none') {
                $command[] = '--cookies-from-browser';
                $command[] = $browser;
            }
            if ($this->isProfileUrl($url)) {
                $command[] = '--sleep';
                $command[] = (string) ($this->config['profile_pause_seconds'] ?? 2);
                $command[] = '--sleep-request';
                $command[] = (string) ($this->config['request_pause_seconds'] ?? 1);
                $command[] = '--sleep-429';
                $command[] = (string) ($this->config['rate_limit_pause_seconds'] ?? 10);
            }
        } else {
            $command[] = '--paths';
            $command[] = $taskDir;
            $command[] = '--no-part';
            // O fallback não entrega áudio isolado, mas preserva sempre o áudio integrado no vídeo.
            $command[] = '--format';
            $command[] = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
            $command[] = '--ffmpeg-location';
            $command[] = (string) $this->config['ffmpeg_location'];
            $command[] = '--postprocessor-args';
            $command[] = 'ffmpeg:-movflags +faststart';
            $command[] = '--no-playlist';
            if ($cookieFile !== null) {
                $command[] = '--cookies';
                $command[] = $cookieFile;
            } elseif ($browser !== 'none') {
                $command[] = '--cookies-from-browser';
                $command[] = $browser;
            }
        }

        $command[] = $url;
        return $this->executeCommand($command, $taskDir);
    }

    /** @param list<string> $arguments */
    private function executeCommand(array $arguments, string $workingDirectory): string
    {
        // Previne que o PHP mate o processo antes do extrator terminar
        set_time_limit(0);

        $command = implode(' ', array_map(static fn (string $argument): string => escapeshellarg($argument), $arguments));
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $env = $_SERVER;
        $env['PYTHONUNBUFFERED'] = '1';

        $process = @proc_open($command, $descriptors, $pipes, $workingDirectory, $env, ['bypass_shell' => true]);
        if (!is_resource($process)) {
            throw new DownloadException('Não foi possível iniciar o extrator de mídia a partir do Apache.', 500);
        }

        fclose($pipes[0]);
        stream_set_blocking($pipes[1], false);
        stream_set_blocking($pipes[2], false);

        $output = '';
        $startedAt = microtime(true);
        $timeout = (int) $this->config['command_timeout_seconds'];
        $buffer = '';

        while (true) {
            $chunk1 = stream_get_contents($pipes[1]) ?: '';
            $chunk2 = stream_get_contents($pipes[2]) ?: '';
            $chunk = $chunk1 . $chunk2;
            $output .= $chunk;

            if ($chunk !== '' && $this->onLog !== null) {
                // Remove escape ANSI e envia linha a linha
                $clean = preg_replace('/\x1b\[[0-9;]*[mGKHF]/u', '', $buffer . $chunk) ?? '';
                $buffer = '';
                $lines = explode("\n", $clean);
                // O último elemento pode estar incompleto; guarda-o no buffer
                $buffer = array_pop($lines);
                foreach ($lines as $line) {
                    $line = rtrim($line, "\r");
                    if ($line !== '') {
                        ($this->onLog)($line);
                    }
                }
            }

            $status = proc_get_status($process);

            if (!$status['running']) {
                break;
            }
            if ((microtime(true) - $startedAt) >= $timeout) {
                @proc_terminate($process);
                fclose($pipes[1]);
                fclose($pipes[2]);
                proc_close($process);
                throw new DownloadException('O download excedeu o tempo máximo de processamento e foi interrompido.', 504);
            }
            usleep(100000);
        }

        $chunk1 = stream_get_contents($pipes[1]) ?: '';
        $chunk2 = stream_get_contents($pipes[2]) ?: '';
        $chunk = $chunk1 . $chunk2;
        $output .= $chunk;

        if ($this->onLog !== null) {
            $clean = preg_replace('/\x1b\[[0-9;]*[mGKHF]/u', '', $buffer . $chunk) ?? '';
            $lines = explode("\n", $clean);
            foreach ($lines as $line) {
                $line = rtrim($line, "\r");
                if ($line !== '') {
                    ($this->onLog)($line);
                }
            }
        }

        fclose($pipes[1]);
        fclose($pipes[2]);
        proc_close($process);

        return $output;
    }

    /** @return list<string> */
    private function collectVisualMediaFiles(string $taskDir, ?string $cookieFile): array
    {
        $files = [];
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($taskDir, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::LEAVES_ONLY
        );

        foreach ($iterator as $item) {
            if (!$item->isFile()) {
                continue;
            }
            $path = $item->getPathname();
            $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
            if (
                ($cookieFile !== null && $path === $cookieFile)
                || in_array($extension, ['part', 'ytdl', 'mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'opus'], true)
                || str_ends_with(strtolower($path), '.info.json')
            ) {
                continue;
            }
            if ($this->isImageFile($path) || $this->isVideoFile($path)) {
                $files[] = $path;
            }
        }

        sort($files, SORT_NATURAL | SORT_FLAG_CASE);
        return $files;
    }

    private function isImageFile(string $file): bool
    {
        return in_array(strtolower(pathinfo($file, PATHINFO_EXTENSION)), ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp'], true);
    }

    private function isVideoFile(string $file): bool
    {
        return in_array(strtolower(pathinfo($file, PATHINFO_EXTENSION)), ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'], true);
    }

    /** @param list<string> $files */
    private function createArchive(array $files, string $taskDir, string $zipPath): void
    {
        if (!class_exists(ZipArchive::class)) {
            throw new DownloadException('A extensão ZIP do PHP não está ativa. Ative extension=zip no php.ini do XAMPP.', 500);
        }

        $zip = new ZipArchive();
        if ($zip->open($zipPath, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
            throw new DownloadException('Não foi possível criar o ficheiro ZIP do download.', 500);
        }

        try {
            foreach ($files as $file) {
                $relative = substr($file, strlen(rtrim($taskDir, DIRECTORY_SEPARATOR)) + 1);
                $entryName = str_replace('\\', '/', $relative);
                if (!$zip->addFile($file, $entryName)) {
                    throw new DownloadException('Não foi possível adicionar um ficheiro ao arquivo ZIP.', 500);
                }
            }
        } finally {
            $zip->close();
        }
    }

    private function isProfileUrl(string $url): bool
    {
        $value = strtolower($url);
        if (str_contains($value, 'instagram.com')) {
            return !str_contains($value, '/p/') && !str_contains($value, '/reel/') && !str_contains($value, '/stories/');
        }
        if (str_contains($value, 'tiktok.com')) {
            return !str_contains($value, '/video/');
        }
        if (str_contains($value, 'twitter.com') || str_contains($value, 'x.com')) {
            return !str_contains($value, '/status/');
        }
        return false;
    }

    private function archiveNameForUrl(string $url): string
    {
        $host = (string) (parse_url($url, PHP_URL_HOST) ?: 'midias');
        $label = explode('.', preg_replace('/^www\./i', '', $host))[0] ?? 'midias';
        return $this->safeFilename($label . '_downloads.zip', 'midias_downloads.zip');
    }

    private function safeFilename(string $filename, string $fallback): string
    {
        $clean = preg_replace('/[^\pL\pN._() -]+/u', '_', $filename) ?? '';
        $clean = trim($clean, '. ');
        return $clean !== '' ? substr($clean, 0, 180) : $fallback;
    }

    private function mimeType(string $file): string
    {
        $extension = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        $types = [
            'png' => 'image/png',
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            'gif' => 'image/gif',
            'mp4' => 'video/mp4',
            'webm' => 'video/webm',
            'mkv' => 'video/x-matroska',
            'mov' => 'video/quicktime',
            'mp3' => 'audio/mpeg',
            'm4a' => 'audio/mp4',
            'wav' => 'audio/wav',
            'flac' => 'audio/flac',
        ];
        return $types[$extension] ?? 'application/octet-stream';
    }

    private function safeFailureSummary(string $output): string
    {
        $normalized = preg_replace('/\s+/', ' ', trim($output)) ?? '';
        $lower = strtolower($normalized);
        if (str_contains($lower, 'cookie') || str_contains($lower, 'login') || str_contains($lower, 'auth')) {
            return 'Confirme se está autenticado no site e, se necessário, carregue cookies próprios no formato Netscape.';
        }
        if (str_contains($lower, 'private') || str_contains($lower, 'unavailable') || str_contains($lower, 'not available')) {
            return 'O conteúdo pode ser privado, indisponível ou não suportado pelo extrator instalado.';
        }
        return 'Verifique o link, as permissões do conteúdo e se os extratores estão atualizados.';
    }

    private function removeDirectory(string $directory): void
    {
        if (!is_dir($directory)) {
            return;
        }
        $items = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($directory, FilesystemIterator::SKIP_DOTS),
            RecursiveIteratorIterator::CHILD_FIRST
        );
        foreach ($items as $item) {
            $path = $item->getPathname();
            if ($item->isDir()) {
                @rmdir($path);
            } else {
                @unlink($path);
            }
        }
        @rmdir($directory);
    }
}
