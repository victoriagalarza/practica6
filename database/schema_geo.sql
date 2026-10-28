USE practica05_bioinformatica;
-- No borra nada: se puede importar sobre la base de la práctica 05.
CREATE TABLE IF NOT EXISTS api_cache (
    fuente VARCHAR(20) NOT NULL,
    clave VARCHAR(255) NOT NULL,
    respuesta MEDIUMTEXT NOT NULL,
    expira_en DATETIME NOT NULL,
    PRIMARY KEY (fuente, clave),
    INDEX idx_expira (expira_en)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS analisis_geo (
    id INT AUTO_INCREMENT PRIMARY KEY,
    simulacion_id INT NULL,
    lat DECIMAL(8,5) NOT NULL, lon DECIMAL(8,5) NOT NULL,
    lugar VARCHAR(255), especie VARCHAR(100),
    temp_media FLOAT, precip_anual FLOAT, radiacion FLOAT,
    ph FLOAT, arcilla_pct FLOAT, arena_pct FLOAT,
    ocurrencias INT, idoneidad FLOAT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (simulacion_id) REFERENCES simulaciones(id) ON DELETE SET NULL
) ENGINE=InnoDB;
