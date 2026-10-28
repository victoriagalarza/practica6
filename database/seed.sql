USE practica05_bioinformatica;

-- Registro único de Azucena (Lilium candidum)
INSERT INTO especies (id, nombre_comun, nombre_cientifico, tasa_crecimiento_base, capacidad_carga_base, temp_optima, humedad_optima, dias_madurez) VALUES
(1, 'Azucena', 'Lilium candidum', 0.08, 2.50, 20.0, 60.0, 90);

-- Simulación 1: control en condiciones óptimas (12 macetas, ninguna muere)
INSERT INTO simulaciones (id, nombre, especie_id, modelo_matematico, temperatura_ambiente, humedad_suelo, duracion_ticks, biomasa_final, altura_final, plantas_vivas, plantas_muertas, tasa_r, capacidad_k, estaciones, modo_ab, num_macetas, num_ramas, notas)
VALUES (1, 'Azucena - Control óptimo', 1, 'logistico', 20.0, 60.0, 120, 553.0, 2.49, 12, 0, 0.08, 2.5, 0, 0, 12, 3, 'Condiciones ideales: sin mortalidad');

-- Las simulaciones de calor sostenido y sequía se generan desde la app (botón Guardar en DB),
-- así sus resultados coinciden exactamente con el motor de simulación.

-- Mediciones ya registradas (día, altura, biomasa total, estrés térmico, estrés hídrico, ICR, plantas vivas)
INSERT INTO mediciones (simulacion_id, tick, altura, biomasa, estres_termico, estres_hidrico, icr, plantas_vivas) VALUES
(1, 0,   0.05, 11.1,  0, 0, 0.0000, 12),
(1, 15,  0.16, 35.1,  0, 0, 0.0767, 12),
(1, 30,  0.46, 101.9, 0, 0, 0.0711, 12),
(1, 45,  1.07, 237.5, 0, 0, 0.0565, 12),
(1, 60,  1.78, 395.2, 0, 0, 0.0340, 12),
(1, 75,  2.23, 495.1, 0, 0, 0.0150, 12),
(1, 90,  2.41, 535.0, 0, 0, 0.0052, 12),
(1, 105, 2.47, 548.3, 0, 0, 0.0017, 12),
(1, 120, 2.49, 553.0, 0, 0, 0.0005, 12);
