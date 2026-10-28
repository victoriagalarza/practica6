# Práctica 05: Laboratorio Bioinformático de Cultivo (*Lilium candidum*)

* **Materia:** Bioinformática y Biología Computacional Avanzados
* **Estudiantes:** Victoria Angélica Galarza Pérez y Fernando José Alexander Cruz Castro

Simulador 3D de la azucena (Three.js) conectado a MySQL mediante una API REST en PHP (FlightPHP). Permite simular el crecimiento, someter las plantas a estrés (temperatura y humedad), ver cómo mueren o se recuperan, comparar escenarios A/B, guardar corridas y consultarlas después.

## Cómo ejecutarlo
1. Copiar la carpeta a `htdocs` de XAMPP y encender Apache y MySQL.
2. Instalar FlightPHP: `composer require flightphp/core` (o copiar la librería en `flight/`).
3. Importar `database/schema.sql` y luego `database/seed.sql` en phpMyAdmin.
4. Abrir `http://localhost/practica06/` (o la IP de la máquina).

---

## Cuestionario de la Práctica

### 1. ¿Qué modelo ecológico o botánico representa tu simulador y por qué es relevante en bioinformática?
Representa el crecimiento de una planta, la azucena (*Lilium candidum*), con un modelo logístico (Verhulst): crece rápido al inicio y se frena al acercarse a su capacidad máxima K. A eso se le agrega el efecto del ambiente (estrés por temperatura y humedad) y la variabilidad genética entre plantas. Es relevante en bioinformática porque combina un modelo matemático con datos guardados en una base de datos y con análisis para tomar decisiones, que es el ciclo datos → simulación → datos.

### 2. ¿Cómo diseñaste el esquema de la base de datos MySQL?
La base `practica05_bioinformatica` tiene 4 tablas:
* `especies`: los datos biológicos de la azucena (r, K, temperatura y humedad óptimas, días a madurez).
* `simulaciones`: una fila por corrida guardada (modelo, temperatura, humedad, r, K, si usó estaciones o A/B, número de macetas y ramas, biomasa final, plantas vivas y muertas, notas).
* `mediciones`: la telemetría de cada corrida (día, altura, biomasa, estrés térmico e hídrico, ICR, plantas vivas).
* `decisiones`: las alertas y recomendaciones que emitió el motor durante la corrida.

Relaciones: una especie tiene muchas simulaciones, y una simulación tiene muchas mediciones y muchas decisiones (llaves foráneas con `ON DELETE CASCADE`). Hay un índice en `mediciones(simulacion_id, tick)`.

### 3. ¿Cómo implementaste la API REST con FlightPHP?
Con rutas en `index.php`, todas devuelven JSON:
* `GET /api/especies`: datos de la azucena (los óptimos que usa el simulador).
* `GET /api/simulaciones`: historial de corridas guardadas.
* `GET /api/simulaciones/@id`: una corrida, para cargarla y reproducirla.
* `POST /api/simulaciones`: guarda una corrida con sus mediciones y decisiones.
* `GET /api/reportes`: top 5 por biomasa, especie más eficiente y tiempo promedio a madurez.

Usa códigos HTTP: 201 al crear, 400 si falta el nombre, 404 si no existe y 500 si falla el guardado.

### 4. ¿Cómo conectaste Three.js con MySQL a través de PHP?
`main.js` (Three.js) llama con `fetch` y `async/await` a `api/...` → el `.htaccess` manda la petición a `index.php` → FlightPHP busca la ruta → el controlador usa PDO con sentencias preparadas → MySQL → la respuesta se convierte en JSON → `main.js` la recibe y actualiza la interfaz (por ejemplo, el historial o los reportes).

### 5. ¿Qué modelo matemático de crecimiento usaste y cómo lo traduciste a código y a la escala visual?
Se puede elegir entre los 4: lineal, exponencial, logístico (Verhulst) y Gompertz. Están en la función `calcularAltura(t, r, K)` del motor, que devuelve la altura según el tiempo efectivo. El valor por defecto es el logístico: `N(t) = K / (1 + ((K − N₀)/N₀)·e^(−r·t))`. La escala visual sale de `altura / K`: ese valor escala la planta 3D, y las hojas y ramas aparecen conforme avanza el crecimiento. Los valores de r y K se pueden cambiar con los sliders.

### 6. ¿Cómo calculaste los índices de estrés y cómo afectan al crecimiento simulado?
Cada índice va de 0 a 100 y mide qué tan lejos está el ambiente del óptimo de la azucena: estrés térmico = |temperatura − 20 °C| / 15 °C, y estrés hídrico = |humedad − 60 %| / 40 puntos (cada uno limitado a 100). El estrés global es el mayor de los dos. Tiene dos efectos: (1) frena el crecimiento, porque el tiempo efectivo avanza más lento mientras más estrés haya; y (2) si pasa de 40 %, cada planta pierde salud día con día. Cada planta tiene una resistencia distinta (entre 0.6 y 2.0), así que las más débiles mueren primero y otras sobreviven. Cuando la salud llega a 0 la planta muere (se seca y ya no aporta biomasa). Si el estrés baja de 25 %, las plantas se recuperan; una planta que llegó a menos de 60 % de salud y se recupera a 90 % o más queda aclimatada (resiste 15 % más) y se registra en la bitácora.

### 7. ¿En qué consiste tu motor de decisiones?
Cada día revisa el estrés del cultivo y emite una recomendación según su nivel. **Ejemplo:** si el estrés global pasa de 75 % (umbral crítico) y el factor que más pesa es la humedad baja, emite "🚨 CRÍTICO: hay que regar más de inmediato". Entre 40 % y 75 % avisa que las plantas pierden salud, y por debajo de 40 % indica que las condiciones son adecuadas. También calcula la predicción de cosecha (días que faltan para llegar al 95 % de K con el estrés actual). Los cambios de nivel, las muertes y las recuperaciones se guardan en la tabla `decisiones`.

### 8. ¿Cómo implementaste la comparación A/B?
Con el botón **Comparar A/B** se dividen las macetas en dos grupos, uno en cada mesa. El escenario A es el control, con condiciones óptimas, y el B usa los valores de los sliders. Cada maceta de A tiene una pareja en B con la misma genética, así que solo cambia el ambiente. El ganador se decide con la biomasa viva media por maceta (con una diferencia mínima del 2 %, si no es empate), y también se muestra cuántas plantas sobreviven en cada grupo.

### 9. ¿Qué gráficas generaste y para qué sirven?
Con Chart.js hay una línea de tiempo en vivo (plantas vivas y estrés, con marcas de muerte y recuperación) y una gráfica grande con la biomasa y la supervivencia de A y B. Sirven para ver cuándo empieza a dañar el estrés y cuánto se pierde. La vista de Reportes muestra el top 5 por biomasa, la especie más eficiente y el tiempo promedio a madurez. También se puede exportar un reporte en CSV y en PDF.

### 10. ¿Cómo evitaste SQL Injection y qué otras medidas de seguridad aplicaste?
Con sentencias preparadas de PDO, con `ATTR_EMULATE_PREPARES` en `false`, de modo que los datos nunca se mezclan con la consulta. Además: el modelo matemático se valida contra una lista permitida, los números se convierten y se limitan a rangos válidos, se limita la cantidad de filas por petición, el guardado va en una transacción (si algo falla se revierte) y los errores no muestran detalles de la base de datos (quedan en el log del servidor). En el frontend los datos de la base se insertan con `textContent`, no como HTML.

### 11. ¿Qué parte del proyecto fue la más difícil y cómo la resolviste?
Que la mortalidad se viera y se comportara de forma realista: darle a cada planta su propia salud y resistencia, y mantenerla sincronizada con el crecimiento 3D dentro de `requestAnimationFrame`. Para que la línea de tiempo funcione, al moverla el simulador vuelve a calcular todo desde el día 0 de forma determinista.

### 12. ¿Qué decisiones agronómicas o biológicas concretas puede apoyar tu simulador?
Cuándo regar o ventilar (según qué factor domine el estrés), cuándo cosechar (predicción de cosecha), qué rango de temperatura y humedad soporta la azucena sin perder plantas, y cuánto se pierde de biomasa si no se corrige el ambiente.

### 13. Si llevaras este proyecto a un sistema real de investigación, ¿qué agregarías?
Sensores IoT de temperatura y humedad reales en lugar de los sliders, un controlador PID para el riego, machine learning para predecir la cosecha con los datos acumulados, más especies y más factores (luz, nutrientes, CO₂) y datos genómicos para relacionar la resistencia de cada planta con sus variantes genéticas.

### 14. ¿Cómo escalarías la aplicación para cientos de simulaciones y usuarios concurrentes?
Mantendría los índices en `mediciones` y agregaría paginación al historial. Usaría caché (por ejemplo, Redis) para los reportes, que se recalculan poco. Guardaría las mediciones en lotes mediante una cola, para no saturar MySQL. Usaría réplicas de lectura para las consultas, migraciones versionadas para cambiar el esquema y autenticación de usuarios para separar las simulaciones de cada quien.


---

# Práctica 06 · Observatorio Global de Cultivos

Extiende el laboratorio con un globo 3D (`observatorio.html`, globe.gl sobre Three.js) y un **proxy PHP** (`geo.php`) que consume APIs públicas sin key: NASA POWER y Open-Meteo (clima), SoilGrids (suelo), GBIF (ocurrencias) y Nominatim (nombre del lugar; Open-Meteo Geocoding no hace geocodificación inversa). Todo el tráfico pasa por el servidor y se cachea 7 días en MySQL (`api_cache`).

## Ejecutar
1. Copia la carpeta a `htdocs` (XAMPP) como `practica06` y enciende Apache y MySQL. `vendor/` ya viene incluido: no hace falta Composer. Apache necesita `mod_rewrite` y `AllowOverride All` para que funcione `.htaccess`.
2. En phpMyAdmin importa, en este orden, `database/schema.sql`, `database/seed.sql` y `database/schema_geo.sql`.
3. Abre `http://localhost/practica06/` (simulador) y `http://localhost/practica06/observatorio.html` (globo). Se necesita internet (APIs, librería del globo y textura de la Tierra).
4. Comprobación del proxy: `curl.exe "http://localhost/practica06/api/geo/clima?lat=14.29&lon=-89.89"`

## Endpoints geo
| Método y ruta | Devuelve |
|---|---|
| `GET /api/geo/clima?lat&lon` | temperatura media (°C), precipitación (mm/año), radiación (MJ/m²/día) |
| `GET /api/geo/suelo?lat&lon` | pH, arcilla %, arena %, carbono orgánico (0–5 cm) |
| `GET /api/geo/lugar?lat&lon` | nombre del lugar y país |
| `GET /api/geo/gbif?especie=` | hasta 300 puntos de ocurrencia y el total en GBIF |
| `GET /api/geo/analisis?lat&lon` | todo lo anterior + ocurrencias a 200 km + idoneidad (0–100) + decisiones |
| `POST /api/geo/guardar` | guarda el análisis en `analisis_geo` (y sus decisiones si trae `simulacion_id`) |
| `GET /api/geo/guardados` | top 10 de análisis guardados por idoneidad |

## Reglas de decisión geo-agronómicas
precipitación < 400 mm → riego obligatorio (crítica) · temperatura > 35 °C → estrés térmico severo (crítica) · 0 registros GBIF a 200 km → alto riesgo · pH < 5.5 → encalar · radiación > 25 MJ/m²/día → sombra parcial.

## Idoneidad
Temperatura 35 % (óptima de la especie, ±15 °C), agua 30 % (800 mm/año = 100 %), ocurrencias GBIF 20 %, pH 15 % (ideal 6.5). Si falta una fuente, los pesos se reparten entre las disponibles. Son criterios propios del proyecto, ajustables en `geo_idoneidad()`.

## Limitaciones
- El botón «Simular aquí» transfiere solo la temperatura media al simulador (la humedad no se deriva de la precipitación).
- El catálogo tiene una especie; la idoneidad usa la especie 1 de la base.
- Las simulaciones de calor sostenido y sequía ya no vienen en el seed: genéralas desde la app con «Guardar en DB».
- SoilGrids es lento y a veces cae: el análisis sigue sin los datos de suelo.
