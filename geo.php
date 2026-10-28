<?php
// Práctica 06 - Proxy geoespacial: Open-Meteo, NASA POWER, SoilGrids, GBIF, Nominatim + caché en MySQL.
// Ninguna API usada requiere key; si agregas una, guárdala aquí (servidor), nunca en main.js.
const GEO_TTL = 604800;   // 7 días de caché

function geo_http(string $url): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 25, CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_FOLLOWLOCATION => true, CURLOPT_USERAGENT => 'Practica06-Observatorio/1.0 (uso academico)']);
    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($body === false || $code !== 200) { error_log("geo_http $code $url"); return null; }
    return json_decode($body, true);
}

// Devuelve la respuesta cacheada o llama a $fn y la guarda (solo si hubo éxito)
function geo_cache(string $fuente, string $clave, callable $fn): ?array {
    $db = DB::getConnection();
    $s = $db->prepare('SELECT respuesta FROM api_cache WHERE fuente = ? AND clave = ? AND expira_en > NOW()');
    $s->execute([$fuente, $clave]);
    if (($r = $s->fetchColumn()) !== false) return json_decode($r, true);
    $data = $fn();
    if ($data !== null) {
        $db->prepare('REPLACE INTO api_cache (fuente, clave, respuesta, expira_en) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL ? SECOND))')
           ->execute([$fuente, $clave, json_encode($data), GEO_TTL]);
    }
    return $data;
}

// lat/lon validados y redondeados a 2 decimales (~1 km): clics cercanos comparten caché
function geo_coords(): ?array {
    $q = Flight::request()->query;
    $lat = $q['lat']; $lon = $q['lon'];
    if (!is_numeric($lat) || !is_numeric($lon) || abs($lat) > 90 || abs($lon) > 180) return null;
    return [round((float)$lat, 2), round((float)$lon, 2)];
}

// Clima: climatología anual de NASA POWER (comunidad AG); si falla, último año completo de Open-Meteo
function geo_clima(float $lat, float $lon): ?array {
    return geo_cache('clima', "$lat,$lon", function () use ($lat, $lon) {
        $j = geo_http("https://power.larc.nasa.gov/api/temporal/climatology/point?parameters=T2M,PRECTOTCORR,ALLSKY_SFC_SW_DWN&community=AG&latitude=$lat&longitude=$lon&format=JSON");
        $p = $j['properties']['parameter'] ?? null;
        if ($p && ($p['T2M']['ANN'] ?? -999) > -900 && ($p['PRECTOTCORR']['ANN'] ?? -999) > -900) {
            return ['fuente' => 'NASA POWER', 'temp_media' => round($p['T2M']['ANN'], 1),
                    'precip_anual' => round($p['PRECTOTCORR']['ANN'] * 365),      // mm/día -> mm/año
                    'radiacion' => round($p['ALLSKY_SFC_SW_DWN']['ANN'], 1)];     // MJ/m²/día
        }
        $y = (int)date('Y') - 1;
        $j = geo_http("https://archive-api.open-meteo.com/v1/archive?latitude=$lat&longitude=$lon&start_date=$y-01-01&end_date=$y-12-31&daily=temperature_2m_mean,precipitation_sum,shortwave_radiation_sum&timezone=GMT");
        $d = $j['daily'] ?? null;
        if (!$d) return null;
        $avg = fn($a) => array_sum($a) / max(1, count(array_filter($a, 'is_numeric')));
        return ['fuente' => "Open-Meteo ($y)", 'temp_media' => round($avg($d['temperature_2m_mean']), 1),
                'precip_anual' => round(array_sum($d['precipitation_sum'])), 'radiacion' => round($avg($d['shortwave_radiation_sum']), 1)];
    });
}

// Suelo (SoilGrids, 0-5 cm). Los valores vienen escalados: se dividen entre d_factor (pH×10, g/kg×10...)
function geo_suelo(float $lat, float $lon): ?array {
    return geo_cache('suelo', "$lat,$lon", function () use ($lat, $lon) {
        $j = geo_http("https://rest.isric.org/soilgrids/v2.0/properties/query?lon=$lon&lat=$lat&property=phh2o&property=clay&property=sand&property=soc&depth=0-5cm&value=mean");
        $o = [];
        foreach ($j['properties']['layers'] ?? [] as $l) {
            $v = $l['depths'][0]['values']['mean'] ?? null;
            $o[$l['name']] = $v === null ? null : round($v / ($l['unit_measure']['d_factor'] ?? 1), 1);
        }
        return $o ? ['ph' => $o['phh2o'] ?? null, 'arcilla_pct' => $o['clay'] ?? null, 'arena_pct' => $o['sand'] ?? null, 'carbono_gkg' => $o['soc'] ?? null] : null;
    });
}

// Nombre del lugar. Open-Meteo Geocoding NO hace geocodificación inversa; se usa Nominatim (máx. 1 req/s, de ahí la caché)
function geo_lugar(float $lat, float $lon): ?array {
    return geo_cache('lugar', "$lat,$lon", function () use ($lat, $lon) {
        $j = geo_http("https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=es&lat=$lat&lon=$lon");
        return isset($j['display_name']) ? ['lugar' => $j['display_name'], 'pais' => $j['address']['country'] ?? null] : null;
    });
}

// Registros GBIF de la especie a menos de 200 km
function geo_gbif_count(string $esp, float $lat, float $lon): ?int {
    $r = geo_cache('gbif_n', strtolower($esp) . "|$lat,$lon", fn() =>
        geo_http('https://api.gbif.org/v1/occurrence/search?limit=0&hasCoordinate=true&scientificName=' . rawurlencode($esp) . "&geoDistance=$lat,$lon,200km"));
    return isset($r['count']) ? (int)$r['count'] : null;
}

// Reglas geo-agronómicas (se guardan en la tabla decisiones)
function geo_decisiones(array $c, ?array $s, ?int $occ): array {
    $d = [];
    $add = function ($n, $a, $r) use (&$d) { $d[] = ['nivel' => $n, 'alerta' => $a, 'recomendacion' => $r]; };
    if ($c['precip_anual'] < 400) $add('critico', "Precipitación baja ({$c['precip_anual']} mm/año)", 'Riego suplementario obligatorio.');
    if ($c['temp_media'] > 35)    $add('critico', "Temperatura media {$c['temp_media']} °C", 'Estrés térmico severo: considerar variedad resistente.');
    if ($occ === 0)               $add('peligro', 'Especie no reportada en esta región (GBIF, 200 km)', 'Alto riesgo: no hay evidencia de adaptación local.');
    if ($s && $s['ph'] !== null && $s['ph'] < 5.5) $add('peligro', "Suelo ácido (pH {$s['ph']})", 'Encalar antes de sembrar.');
    if ($c['radiacion'] > 25)     $add('aviso', "Radiación alta ({$c['radiacion']} MJ/m²/día)", 'Considerar sombra parcial.');
    return $d;
}

// Idoneidad 0-100: temperatura 35 %, agua 30 % (800 mm/año = 100 %), ocurrencias 20 %, pH 15 % (ideal 6.5).
// Si falta una fuente, se reparten los pesos entre las que sí hay.
function geo_idoneidad(array $c, ?array $s, ?int $occ, array $esp): float {
    $cl = fn($x) => max(0, min(1, $x));
    $p = [[.35, 1 - $cl(abs($c['temp_media'] - $esp['temp_optima']) / 15)], [.30, $cl($c['precip_anual'] / 800)]];
    if ($s && $s['ph'] !== null) $p[] = [.15, 1 - $cl(abs($s['ph'] - 6.5) / 2)];
    if ($occ !== null)           $p[] = [.20, $occ > 0 ? 1 : 0.2];
    return round(100 * array_sum(array_map(fn($x) => $x[0] * $x[1], $p)) / array_sum(array_column($p, 0)), 1);
}

function geo_analisis(float $lat, float $lon): ?array {
    $esp = DB::getConnection()->query('SELECT * FROM especies WHERE id = 1')->fetch();
    $clima = geo_clima($lat, $lon);
    if (!$clima) return null;
    $suelo = geo_suelo($lat, $lon);
    $occ = geo_gbif_count($esp['nombre_cientifico'], $lat, $lon);
    return ['lat' => $lat, 'lon' => $lon, 'especie' => $esp['nombre_cientifico'], 'lugar' => (geo_lugar($lat, $lon)['lugar'] ?? null),
            'clima' => $clima, 'suelo' => $suelo, 'ocurrencias' => $occ,
            'idoneidad' => geo_idoneidad($clima, $suelo, $occ, $esp), 'decisiones' => geo_decisiones($clima, $suelo, $occ)];
}

function geo_ruta(string $ruta, callable $fn): void {
    Flight::route("GET /api/geo/$ruta", function () use ($fn) {
        $c = geo_coords();
        if (!$c) { Flight::json(['error' => 'lat y lon inválidos'], 400); return; }
        $r = $fn($c[0], $c[1]);
        if ($r === null) Flight::json(['error' => 'Servicio externo no disponible'], 502); else Flight::json($r);
    });
}
geo_ruta('clima', 'geo_clima');
geo_ruta('suelo', 'geo_suelo');
geo_ruta('lugar', 'geo_lugar');
geo_ruta('analisis', 'geo_analisis');

// Puntos de ocurrencia para el globo: /api/geo/gbif?especie=Lilium%20candidum (máx. 300 por llamada de GBIF)
Flight::route('GET /api/geo/gbif', function () {
    $esp = trim((string)(Flight::request()->query['especie'] ?? 'Lilium candidum'));
    if ($esp === '' || strlen($esp) > 100) { Flight::json(['error' => 'especie inválida'], 400); return; }
    $r = geo_cache('gbif_pts', strtolower($esp), fn() =>
        geo_http('https://api.gbif.org/v1/occurrence/search?limit=300&hasCoordinate=true&hasGeospatialIssue=false&scientificName=' . rawurlencode($esp)));
    if ($r === null) { Flight::json(['error' => 'Servicio externo no disponible'], 502); return; }
    $pts = [];
    foreach ($r['results'] ?? [] as $x) if (isset($x['decimalLatitude'], $x['decimalLongitude'])) $pts[] = [$x['decimalLatitude'], $x['decimalLongitude']];
    Flight::json(['especie' => $esp, 'total_gbif' => $r['count'] ?? 0, 'puntos' => $pts]);
});

// Guarda el análisis (y sus decisiones, si viene ligado a una simulación ya guardada)
Flight::route('POST /api/geo/guardar', function () {
    $d = Flight::request()->data->getData();
    if (!is_numeric($d['lat'] ?? null) || !is_numeric($d['lon'] ?? null) || abs($d['lat']) > 90 || abs($d['lon']) > 180) {
        Flight::json(['success' => false, 'error' => 'lat y lon inválidos'], 400); return;
    }
    $n = fn($k) => is_numeric($d[$k] ?? null) ? (float)$d[$k] : null;
    $db = DB::getConnection();
    try {
        $db->beginTransaction();
        $sim = is_numeric($d['simulacion_id'] ?? null) ? (int)$d['simulacion_id'] : null;
        $db->prepare('INSERT INTO analisis_geo (simulacion_id, lat, lon, lugar, especie, temp_media, precip_anual, radiacion, ph, arcilla_pct, arena_pct, ocurrencias, idoneidad) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
           ->execute([$sim, $n('lat'), $n('lon'), mb_substr((string)($d['lugar'] ?? ''), 0, 255), mb_substr((string)($d['especie'] ?? ''), 0, 100),
                      $n('temp_media'), $n('precip_anual'), $n('radiacion'), $n('ph'), $n('arcilla_pct'), $n('arena_pct'),
                      is_null($n('ocurrencias')) ? null : (int)$n('ocurrencias'), $n('idoneidad')]);
        $id = (int)$db->lastInsertId();
        if ($sim !== null) {
            $st = $db->prepare('INSERT INTO decisiones (simulacion_id, tick, alerta, recomendacion) VALUES (?, 0, ?, ?)');
            foreach (array_slice($d['decisiones'] ?? [], 0, 20) as $x) $st->execute([$sim, mb_substr((string)($x['alerta'] ?? ''), 0, 255), (string)($x['recomendacion'] ?? '')]);
        }
        $db->commit();
        Flight::json(['success' => true, 'id' => $id], 201);
    } catch (Throwable $e) {
        if ($db->inTransaction()) $db->rollBack();
        error_log('POST /api/geo/guardar: ' . $e->getMessage());
        Flight::json(['success' => false, 'error' => 'No se pudo guardar el análisis'], 500);
    }
});

// Ranking persistente: los 10 mejores análisis guardados
Flight::route('GET /api/geo/guardados', function () {
    Flight::json(DB::getConnection()->query('SELECT id, lugar, especie, lat, lon, idoneidad, created_at FROM analisis_geo ORDER BY idoneidad DESC, id DESC LIMIT 10')->fetchAll());
});
