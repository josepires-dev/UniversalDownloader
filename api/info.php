<?php
declare(strict_types=1);

require_once dirname(__DIR__) . DIRECTORY_SEPARATOR . 'lib' . DIRECTORY_SEPARATOR . 'YtDlpService.php';
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

$contentLength = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
if ($contentLength > (int) $config['max_cookie_file_bytes'] + 4096) {
    sendJson(['error' => 'O pedido excede o tamanho máximo permitido.'], 413);
}

try {
    $raw = file_get_contents('php://input');
    $payload = json_decode($raw === false ? '' : $raw, true, 32, JSON_THROW_ON_ERROR);
    if (!is_array($payload)) {
        sendJson(['error' => 'Envie os dados em JSON.'], 400);
    }
    $service = new YtDlpService($config);
    sendJson($service->getInfo($payload), 200);
} catch (JsonException) {
    sendJson(['error' => 'O JSON enviado é inválido.'], 400);
} catch (MediaDownloadException $exception) {
    sendJson(['error' => $exception->getMessage()], $exception->httpStatus);
} catch (Throwable) {
    sendJson(['error' => 'Ocorreu um erro interno inesperado.'], 500);
}
