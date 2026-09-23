<?php
declare(strict_types=1);

return [
    'app_name' => 'UniversalDownloader',
    'temp_root' => __DIR__ . DIRECTORY_SEPARATOR . 'storage' . DIRECTORY_SEPARATOR . 'tmp',
    'yt_dlp_binary' => __DIR__ . DIRECTORY_SEPARATOR . 'tools' . DIRECTORY_SEPARATOR . 'yt-dlp.exe',
    'gallery_dl_binary' => __DIR__ . DIRECTORY_SEPARATOR . 'tools' . DIRECTORY_SEPARATOR . 'gallery-dl.exe',
    'ffmpeg_location' => __DIR__ . DIRECTORY_SEPARATOR . 'tools',
    'max_url_length' => 2048,
    'max_cookie_file_bytes' => 2 * 1024 * 1024,
    'command_timeout_seconds' => 1800,
    'max_playlist_items' => 500,
    'profile_pause_seconds' => 2,
    'request_pause_seconds' => 1,
    'rate_limit_pause_seconds' => 10,
];
