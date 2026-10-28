<?php
// Carga de la librería FlightPHP
if (file_exists(__DIR__ . '/vendor/autoload.php')) {
    require_once __DIR__ . '/vendor/autoload.php';   // instalado con Composer
} else if (file_exists(__DIR__ . '/flight/autoload.php')) {
    require_once __DIR__ . '/flight/autoload.php';
} else if (file_exists(__DIR__ . '/flight/Flight.php')) {
    require_once __DIR__ . '/flight/Flight.php';
}

require_once __DIR__ . '/config/db.php';

// Rutas no encontradas -> JSON con código 404
Flight::map('notFound', function() {
    Flight::json(['error' => 'Ruta no encontrada'], 404);
});

// 1. GET /api/especies - Catálogo (solo la Azucena)
Flight::route('GET /api/especies', function() {
    $db = DB::getConnection();
    Flight::json($db->query("SELECT * FROM especies WHERE id = 1")->fetchAll());
});

// 2. GET /api/simulaciones - Historial de experimentos
Flight::route('GET /api/simulaciones', function() {
    $db = DB::getConnection();
    $stmt = $db->query("
        SELECT s.*, e.nombre_comun, e.nombre_cientifico
        FROM simulaciones s
        JOIN especies e ON s.especie_id = e.id
        ORDER BY s.id DESC
        LIMIT 100
    ");
    Flight::json($stmt->fetchAll());
});

// 3. GET /api/simulaciones/@id - Una simulación (para cargarla y reproducirla)
Flight::route('GET /api/simulaciones/@id:[0-9]+', function($id) {
    $db = DB::getConnection();
    $stmt = $db->prepare("SELECT * FROM simulaciones WHERE id = ?");
    $stmt->execute([(int)$id]);
    $fila = $stmt->fetch();
    if (!$fila) {
        Flight::json(['error' => 'Simulación no encontrada'], 404);
        return;
    }
    Flight::json($fila);
});

// 4. POST /api/simulaciones - Guardar experimento + mediciones + decisiones (en una transacción)
Flight::route('POST /api/simulaciones', function() {
    $data = Flight::request()->data->getData();
    $db = DB::getConnection();

    $nombre = trim((string)($data['nombre'] ?? ''));
    if ($nombre === '') {
        Flight::json(['success' => false, 'error' => 'El nombre es obligatorio'], 400);
        return;
    }

    $modelos = ['lineal', 'exponencial', 'logistico', 'gompertz'];
    $modelo = in_array($data['modelo_matematico'] ?? '', $modelos, true) ? $data['modelo_matematico'] : 'logistico';
    $num = function($v, $def = 0.0) { return is_numeric($v) ? (float)$v : $def; };

    try {
        $db->beginTransaction();

        $stmt = $db->prepare("
            INSERT INTO simulaciones
              (nombre, especie_id, modelo_matematico, temperatura_ambiente, humedad_suelo, duracion_ticks,
               biomasa_final, altura_final, plantas_vivas, plantas_muertas,
               tasa_r, capacidad_k, estaciones, modo_ab, num_macetas, num_ramas, notas)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ");
        $stmt->execute([
            mb_substr($nombre, 0, 150),
            $modelo,
            $num($data['temperatura_ambiente'] ?? 20.0, 20.0),
            $num($data['humedad_suelo'] ?? 60.0, 60.0),
            (int)$num($data['duracion_ticks'] ?? 0),
            $num($data['biomasa_final'] ?? 0.0),
            $num($data['altura_final'] ?? 0.0),
            (int)$num($data['plantas_vivas'] ?? 0),
            (int)$num($data['plantas_muertas'] ?? 0),
            $num($data['tasa_r'] ?? 0.08, 0.08),
            $num($data['capacidad_k'] ?? 2.5, 2.5),
            ((int)$num($data['estaciones'] ?? 0)) ? 1 : 0,
            ((int)$num($data['modo_ab'] ?? 0)) ? 1 : 0,
            max(1, min(15, (int)$num($data['num_macetas'] ?? 12, 12))),
            max(1, min(5, (int)$num($data['num_ramas'] ?? 3, 3))),
            mb_substr((string)($data['notas'] ?? ''), 0, 1000)
        ]);
        $simId = (int)$db->lastInsertId();

        // Mediciones (máx. 400 filas por simulación)
        $med = $db->prepare("INSERT INTO mediciones (simulacion_id, tick, altura, biomasa, estres_termico, estres_hidrico, icr, plantas_vivas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        foreach (array_slice($data['mediciones'] ?? [], 0, 400) as $m) {
            $med->execute([
                $simId, (int)$num($m['tick'] ?? 0), $num($m['altura'] ?? 0), $num($m['biomasa'] ?? 0),
                $num($m['estres_termico'] ?? 0), $num($m['estres_hidrico'] ?? 0), $num($m['icr'] ?? 0),
                (int)$num($m['plantas_vivas'] ?? 0)
            ]);
        }

        // Decisiones / alertas del motor agronómico (máx. 200)
        $dec = $db->prepare("INSERT INTO decisiones (simulacion_id, tick, alerta, recomendacion) VALUES (?, ?, ?, ?)");
        foreach (array_slice($data['decisiones'] ?? [], 0, 200) as $d) {
            $dec->execute([$simId, (int)$num($d['tick'] ?? 0), mb_substr((string)($d['alerta'] ?? ''), 0, 255), (string)($d['recomendacion'] ?? '')]);
        }

        $db->commit();
        Flight::json(['success' => true, 'id' => $simId], 201);
    } catch (Throwable $e) {
        if ($db->inTransaction()) { $db->rollBack(); }
        error_log('POST /api/simulaciones: ' . $e->getMessage());   // el detalle queda en el log, no se muestra al cliente
        Flight::json(['success' => false, 'error' => 'No se pudo guardar la simulación'], 500);
    }
});

// 5. GET /api/reportes - Top 5 por biomasa, especie más eficiente y tiempo promedio a madurez
Flight::route('GET /api/reportes', function() {
    $db = DB::getConnection();

    $top = $db->query("
        SELECT s.nombre, e.nombre_comun, s.biomasa_final, s.altura_final, s.modelo_matematico, s.plantas_vivas, s.plantas_muertas
        FROM simulaciones s JOIN especies e ON s.especie_id = e.id
        ORDER BY s.biomasa_final DESC LIMIT 5
    ")->fetchAll();

    $eficiencia = $db->query("
        SELECT e.nombre_comun, AVG(s.biomasa_final / s.duracion_ticks) AS g_por_dia, COUNT(*) AS simulaciones
        FROM simulaciones s JOIN especies e ON s.especie_id = e.id
        WHERE s.duracion_ticks > 0
        GROUP BY e.id ORDER BY g_por_dia DESC LIMIT 1
    ")->fetch();

    // Madurez = primer día en que la altura llega al 95 % de K, promediado entre simulaciones
    $madurez = $db->query("
        SELECT AVG(x.dia) AS dias, COUNT(*) AS n FROM (
            SELECT m.simulacion_id, MIN(m.tick) AS dia
            FROM mediciones m JOIN simulaciones s ON s.id = m.simulacion_id
            WHERE m.altura >= 0.95 * s.capacidad_k
            GROUP BY m.simulacion_id
        ) x
    ")->fetch();

    Flight::json(['top_biomasa' => $top, 'eficiencia' => $eficiencia ?: null, 'madurez' => $madurez]);
});

require_once __DIR__ . '/geo.php';   // Práctica 06: proxy geoespacial

Flight::start();
