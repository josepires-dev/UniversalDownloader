<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(0);

require_once dirname(__DIR__) . DIRECTORY_SEPARATOR . 'lib' . DIRECTORY_SEPARATOR . 'InstaDownloader.php';
$config = require dirname(__DIR__) . DIRECTORY_SEPARATOR . 'config.php';

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: no-referrer');
header('Cache-Control: no-store, max-age=0');

/** @param array<string, mixed> $body */
function sendJson(array $body, int $status): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=UTF-8');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Allow: POST');
    sendJson(['error' => 'Método não permitido.'], 405);
}

$contentLength = isset($_SERVER['CONTENT_LENGTH']) ? (int) $_SERVER['CONTENT_LENGTH'] : 0;
$maximumPayload = (int) $config['max_cookie_file_bytes'] + 4096;
if ($contentLength > $maximumPayload) {
    sendJson(['error' => 'O pedido excede o tamanho máximo permitido.'], 413);
}

$rawPayload = file_get_contents('php://input');
if ($rawPayload === false || $rawPayload === '') {
    sendJson(['error' => 'Envie os dados do download em JSON.'], 400);
}

try {
    /** @var mixed $decoded */
    $decoded = json_decode($rawPayload, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($decoded)) {
        sendJson(['error' => 'O corpo do pedido deve ser um objeto JSON.'], 400);
    }

    $downloader = new Downloader($config);
    $result = $downloader->download($decoded);
} catch (JsonException) {
    sendJson(['error' => 'O JSON enviado é inválido.'], 400);
} catch (DownloadException $exception) {
    sendJson(['error' => $exception->getMessage()], $exception->httpStatus);
} catch (Throwable) {
    sendJson(['error' => 'Ocorreu um erro interno inesperado.'], 500);
}

$file = $result['file'];
$taskDirectory = $result['task_dir'];
$filename = $result['name'];

if (!is_file($file) || !is_readable($file)) {
    $downloader->removeTaskDirectory($taskDirectory);
    sendJson(['error' => 'O ficheiro resultante já não está disponível.'], 500);
}

while (ob_get_level() > 0) {
    ob_end_clean();
}

ignore_user_abort(true);
header('Access-Control-Expose-Headers: Content-Disposition');
header('Content-Type: ' . $result['mime']);
header('Content-Length: ' . (string) filesize($file));
header('Content-Disposition: attachment; filename="' . addslashes($filename) . '"; filename*=UTF-8\'\'' . rawurlencode($filename));

try {
    $handle = fopen($file, 'rb');
    if ($handle === false) {
        throw new RuntimeException('Não foi possível abrir o ficheiro resultante.');
    }
    while (!feof($handle)) {
        $chunk = fread($handle, 1024 * 1024);
        if ($chunk === false) {
            break;
        }
        echo $chunk;
        flush();
    }
    fclose($handle);
} finally {
    $downloader->removeTaskDirectory($taskDirectory);
}
exit;
