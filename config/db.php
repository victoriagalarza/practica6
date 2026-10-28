<?php
class DB {
    private static $host = '127.0.0.1';
    private static $db   = 'practica05_bioinformatica';
    private static $user = 'root';
    private static $pass = ''; // Cambia si tu XAMPP usa contraseña
    private static $pdo  = null;

    public static function getConnection() {
        if (self::$pdo === null) {
            try {
                $dsn = "mysql:host=" . self::$host . ";dbname=" . self::$db . ";charset=utf8mb4";
                self::$pdo = new PDO($dsn, self::$user, self::$pass, [
                    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                    PDO::ATTR_EMULATE_PREPARES => false   // sentencias preparadas reales (anti SQL injection)
                ]);
            } catch (PDOException $e) {
                error_log('Conexión a la BD: ' . $e->getMessage());   // detalle solo en el log del servidor
                http_response_code(500);
                header('Content-Type: application/json');
                echo json_encode(['error' => 'No se pudo conectar a la base de datos']);
                exit();
            }
        }
        return self::$pdo;
    }
}
