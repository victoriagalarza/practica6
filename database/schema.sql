CREATE DATABASE IF NOT EXISTS practica05_bioinformatica CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE practica05_bioinformatica;

DROP TABLE IF EXISTS decisiones;
DROP TABLE IF EXISTS mediciones;
DROP TABLE IF EXISTS simulaciones;
DROP TABLE IF EXISTS especies;

CREATE TABLE especies (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre_comun VARCHAR(100) NOT NULL,
    nombre_cientifico VARCHAR(100) NOT NULL,
    tasa_crecimiento_base FLOAT NOT NULL DEFAULT 0.08,
    capacidad_carga_base FLOAT NOT NULL DEFAULT 2.50,
    temp_optima FLOAT NOT NULL DEFAULT 20.0,
    humedad_optima FLOAT NOT NULL DEFAULT 60.0,
    dias_madurez INT NOT NULL DEFAULT 90,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE simulaciones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nombre VARCHAR(150) NOT NULL,
    especie_id INT NOT NULL,
    modelo_matematico ENUM('lineal', 'exponencial', 'logistico', 'gompertz') NOT NULL DEFAULT 'logistico',
    temperatura_ambiente FLOAT NOT NULL,
    humedad_suelo FLOAT NOT NULL,
    duracion_ticks INT NOT NULL DEFAULT 0,
    biomasa_final FLOAT DEFAULT 0.0,
    altura_final FLOAT DEFAULT 0.0,
    plantas_vivas INT NOT NULL DEFAULT 0,
    plantas_muertas INT NOT NULL DEFAULT 0,
    tasa_r FLOAT NOT NULL DEFAULT 0.08,
    capacidad_k FLOAT NOT NULL DEFAULT 2.5,
    estaciones TINYINT NOT NULL DEFAULT 0,
    modo_ab TINYINT NOT NULL DEFAULT 0,
    num_macetas INT NOT NULL DEFAULT 12,
    num_ramas INT NOT NULL DEFAULT 3,
    notas TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (especie_id) REFERENCES especies(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE mediciones (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    simulacion_id INT NOT NULL,
    tick INT NOT NULL,
    altura FLOAT NOT NULL,
    biomasa FLOAT NOT NULL,
    estres_termico FLOAT NOT NULL,
    estres_hidrico FLOAT NOT NULL,
    icr FLOAT NOT NULL,
    plantas_vivas INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (simulacion_id) REFERENCES simulaciones(id) ON DELETE CASCADE,
    INDEX idx_med_sim_tick (simulacion_id, tick)
) ENGINE=InnoDB;

CREATE TABLE decisiones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    simulacion_id INT NOT NULL,
    tick INT NOT NULL,
    alerta VARCHAR(255) NOT NULL,
    recomendacion TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (simulacion_id) REFERENCES simulaciones(id) ON DELETE CASCADE
) ENGINE=InnoDB;