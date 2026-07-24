<?php

declare(strict_types=1);

const DEFAULT_CONFIG_PATH = '/etc/gp1-grab-sync.ini';

function logMessage(string $message): void
{
    fwrite(STDOUT, gmdate('c') . ' ' . $message . PHP_EOL);
}

function configValue(array $config, string $section, string $key, mixed $default = null): mixed
{
    return $config[$section][$key] ?? $default;
}

function requireConfig(array $config, string $section, string $key): string
{
    $value = trim((string) configValue($config, $section, $key, ''));
    if ($value === '' || str_starts_with($value, 'CHANGE_ME')) {
        throw new RuntimeException("Missing configuration: {$section}.{$key}");
    }
    return $value;
}

function loadState(string $path): array
{
    if (!is_file($path)) {
        return [];
    }
    $decoded = json_decode((string) file_get_contents($path), true);
    return is_array($decoded) ? $decoded : [];
}

function saveState(string $path, array $state): void
{
    $directory = dirname($path);
    if (!is_dir($directory) && !mkdir($directory, 0750, true) && !is_dir($directory)) {
        throw new RuntimeException("Cannot create state directory: {$directory}");
    }
    $temporary = $path . '.tmp';
    $json = json_encode($state, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    if (file_put_contents($temporary, $json . PHP_EOL, LOCK_EX) === false || !rename($temporary, $path)) {
        @unlink($temporary);
        throw new RuntimeException('Cannot save sync state');
    }
}

function postJson(string $endpoint, string $token, array $payload): array
{
    if (!str_starts_with(strtolower($endpoint), 'https://')) {
        throw new RuntimeException('Sync endpoint must use HTTPS');
    }
    $body = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    $curl = curl_init($endpoint);
    if ($curl === false) {
        throw new RuntimeException('Cannot initialize cURL');
    }
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => [
            'Authorization: Bearer ' . $token,
            'Content-Type: application/json',
            'User-Agent: GP1-Grab-Sync/1.0',
        ],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    if (defined('CURLOPT_PROTOCOLS') && defined('CURLPROTO_HTTPS')) {
        curl_setopt($curl, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
    }
    $responseBody = curl_exec($curl);
    $status = (int) curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $error = curl_error($curl);
    curl_close($curl);
    if ($responseBody === false) {
        throw new RuntimeException('Cloud connection failed: ' . $error);
    }
    $decoded = json_decode((string) $responseBody, true);
    if ($status < 200 || $status >= 300 || !is_array($decoded) || ($decoded['ok'] ?? false) !== true) {
        $detail = is_array($decoded) ? (string) ($decoded['error'] ?? 'Unknown API error') : 'Invalid API response';
        throw new RuntimeException("Cloud rejected sync (HTTP {$status}): {$detail}");
    }
    return $decoded;
}

function fetchRows(PDO $pdo, string $whereSql, array $parameters, string $limitSql = ''): array
{
    $statement = $pdo->prepare("
        SELECT id, amp, weight, status,
               DATE_FORMAT(create_date, '%Y-%m-%d %H:%i:%s') AS create_date
        FROM grab_data
        WHERE {$whereSql}
        ORDER BY id ASC
        {$limitSql}
    ");
    $statement->execute($parameters);
    return array_map(static fn(array $row): array => [
        'id' => (int) $row['id'],
        'amp' => $row['amp'] === null ? null : (float) $row['amp'],
        'weight' => (float) $row['weight'],
        'status' => $row['status'] === null ? null : (int) $row['status'],
        'createDate' => (string) $row['create_date'],
    ], $statement->fetchAll(PDO::FETCH_ASSOC));
}

function initializeLastId(PDO $pdo, int $lookbackDays): int
{
    $days = max(1, min(365, $lookbackDays));
    $statement = $pdo->query("
        SELECT COALESCE(
            MIN(id) - 1,
            (SELECT COALESCE(MAX(id), 0) FROM grab_data)
        ) AS initial_id
        FROM grab_data
        WHERE create_date >= DATE_SUB(NOW(), INTERVAL {$days} DAY)
    ");
    return max(0, (int) $statement->fetchColumn());
}

function syncIncremental(
    PDO $pdo,
    string $endpoint,
    string $token,
    string $deviceId,
    string $statePath,
    array &$state,
    int $maxRows,
    int $batchSize
): int {
    $lastId = (int) ($state['last_id'] ?? 0);
    $rows = fetchRows($pdo, 'id > :last_id', ['last_id' => $lastId], 'LIMIT ' . $maxRows);
    $processed = 0;
    foreach (array_chunk($rows, $batchSize) as $batch) {
        postJson($endpoint, $token, [
            'deviceId' => $deviceId,
            'mode' => 'upsert',
            'rows' => $batch,
        ]);
        $lastRow = end($batch);
        $state['last_id'] = (int) $lastRow['id'];
        $state['last_success_at'] = gmdate('c');
        saveState($statePath, $state);
        $processed += count($batch);
    }
    return $processed;
}

function reconciliationDue(array $state, int $intervalMinutes): bool
{
    $last = strtotime((string) ($state['last_reconcile_at'] ?? ''));
    return $last === false || $last <= time() - ($intervalMinutes * 60);
}

function syncSnapshot(
    PDO $pdo,
    string $endpoint,
    string $token,
    string $deviceId,
    string $statePath,
    array &$state,
    int $days
): array {
    $timezone = new DateTimeZone('Asia/Bangkok');
    $today = new DateTimeImmutable('today', $timezone);
    $start = $today->modify('-' . max(1, min(30, $days)) . ' days')->format('Y-m-d H:i:s');
    $end = $today->modify('+1 day')->format('Y-m-d H:i:s');
    $rows = fetchRows($pdo, 'create_date >= :window_start AND create_date < :window_end', [
        'window_start' => $start,
        'window_end' => $end,
    ]);
    if (count($rows) > 2500) {
        throw new RuntimeException('Snapshot exceeds 2,500 rows; reduce reconcile_days');
    }
    $response = postJson($endpoint, $token, [
        'deviceId' => $deviceId,
        'mode' => 'snapshot',
        'windowStart' => $start,
        'windowEnd' => $end,
        'rows' => $rows,
    ]);
    $state['last_reconcile_at'] = gmdate('c');
    $state['last_success_at'] = gmdate('c');
    saveState($statePath, $state);
    return $response;
}

try {
    $configPath = getenv('GP1_GRAB_SYNC_CONFIG') ?: DEFAULT_CONFIG_PATH;
    $config = parse_ini_file($configPath, true, INI_SCANNER_RAW);
    if (!is_array($config)) {
        throw new RuntimeException("Cannot read configuration: {$configPath}");
    }

    $dsn = requireConfig($config, 'database', 'dsn');
    $dbUser = requireConfig($config, 'database', 'username');
    $dbPassword = requireConfig($config, 'database', 'password');
    $endpoint = requireConfig($config, 'cloud', 'endpoint');
    $token = requireConfig($config, 'cloud', 'token');
    $deviceId = requireConfig($config, 'cloud', 'device_id');
    if (strlen($token) < 32 || !preg_match('/^[A-Za-z0-9._-]{1,64}$/', $deviceId)) {
        throw new RuntimeException('Cloud token or device ID is invalid');
    }

    $statePath = (string) configValue($config, 'sync', 'state_file', '/var/lib/gp1-grab-sync/state.json');
    $maxRows = max(1, min(10000, (int) configValue($config, 'sync', 'max_rows_per_run', 2000)));
    $batchSize = max(1, min(500, (int) configValue($config, 'sync', 'batch_size', 200)));
    $lookbackDays = max(1, min(365, (int) configValue($config, 'sync', 'initial_lookback_days', 7)));
    $reconcileDays = max(1, min(30, (int) configValue($config, 'sync', 'reconcile_days', 7)));
    $reconcileMinutes = max(15, min(1440, (int) configValue($config, 'sync', 'reconcile_interval_minutes', 60)));

    $pdo = new PDO($dsn, $dbUser, $dbPassword, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 10,
    ]);
    $pdo->exec("SET time_zone = '+07:00'");

    $state = loadState($statePath);
    if (!array_key_exists('last_id', $state)) {
        $state['last_id'] = initializeLastId($pdo, $lookbackDays);
        saveState($statePath, $state);
        logMessage('Initialized from source ID ' . $state['last_id']);
    }

    $processed = syncIncremental(
        $pdo, $endpoint, $token, $deviceId, $statePath, $state, $maxRows, $batchSize
    );
    $summary = "Incremental sync completed: {$processed} row(s)";
    if (reconciliationDue($state, $reconcileMinutes)) {
        $snapshot = syncSnapshot(
            $pdo, $endpoint, $token, $deviceId, $statePath, $state, $reconcileDays
        );
        $summary .= sprintf(
            '; snapshot processed=%d deleted=%d',
            (int) ($snapshot['processed'] ?? 0),
            (int) ($snapshot['deleted'] ?? 0)
        );
    }
    logMessage($summary);
    exit(0);
} catch (Throwable $error) {
    logMessage('ERROR: ' . $error->getMessage());
    exit(1);
}
