# Práctica 06: Geovisualización Global y Datos Reales

* **Materia:** Bioinformática y Biología Computacional Avanzados
* **Estudiantes:** Victoria Angélica Galarza Pérez y Fernando José Alexander Cruz Castro

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


---

# Preguntas y respuestas · Práctica 06

## 1. ¿Qué APIs públicas integré y por qué las elegí? ¿Qué datos aporta cada una?

Elegí APIs gratuitas, sin registro ni API key, con cobertura mundial y con datos que alimentan directamente las reglas de decisión.

| API | Por qué | Datos que aporta |
|---|---|---|
| **NASA POWER** | Climatología agroclimática global (desde 1981), pensada para agricultura | Temperatura media (`T2M`), precipitación (`PRECTOTCORR`, mm/día → ×365 = mm/año), radiación solar (`ALLSKY_SFC_SW_DWN`, MJ/m²/día) |
| **Open-Meteo Archive** | Respaldo si NASA POWER no responde o no tiene dato | Temperatura media, precipitación y radiación del último año completo |
| **SoilGrids (ISRIC)** | Única fuente global de propiedades de suelo a ~250 m | pH, arcilla %, arena %, carbono orgánico (0–5 cm) |
| **GBIF** | Mayor base abierta de ocurrencias de especies | Total de registros de la especie a menos de 200 km y hasta 300 puntos para el globo |
| **Nominatim (OSM)** | Nombre del lugar a partir de coordenadas | Lugar y país |

Nota: el enunciado sugería Open-Meteo Geocoding para la geocodificación inversa, pero esa API solo hace búsqueda directa (nombre → coordenadas), por eso usé Nominatim.

## 2. ¿Cómo implementé el proxy PHP? Flujo completo

El navegador **nunca** llama a las APIs externas: solo habla con `api/geo/...` en nuestro servidor (`geo.php`, registrado en `index.php`). Hoy ninguna API usada exige key; si se agregara una, viviría en el servidor (constante o variable de entorno en `geo.php`) y jamás en `observatorio.html` ni en `main.js`.

```
Navegador (observatorio.html)
   │  GET api/geo/analisis?lat=..&lon=..
   ▼
FlightPHP (index.php → geo.php)         valida lat/lon y redondea a 2 decimales
   │
   ▼
geo_cache(fuente, clave) ──► MySQL api_cache
   │  ¿existe y expira_en > NOW()?
   ├── SÍ → devuelve JSON guardado (sin salir a internet)
   └── NO → geo_http() con cURL ──► API externa (NASA / SoilGrids / GBIF / Nominatim)
              │  respuesta 200
              ▼
        REPLACE INTO api_cache (solo si hubo éxito)
   │
   ▼
Se combinan clima + suelo + GBIF + lugar → idoneidad + decisiones → JSON al navegador
```

`geo_http()` usa cURL con timeout de 25 s, 5 s de conexión y un `User-Agent` identificable; si la API falla devuelve `null` y el endpoint responde `502` sin exponer detalles internos (el error real va a `error_log`). El suelo y el nombre del lugar son opcionales: si fallan, el análisis continúa sin ellos.

## 3. ¿Cómo construí el globo 3D? ¿Proyección de coordenadas?

No lo hice desde cero: usé **globe.gl**, que envuelve **three-globe** sobre **Three.js**. No usé `lithosphere`. La Tierra es una esfera con la textura *Blue Marble* en proyección equirectangular (cada píxel de la imagen corresponde linealmente a una latitud y una longitud). Three-globe convierte (lat, lng) a coordenadas cartesianas 3D con coordenadas esféricas (radio R de la esfera):

```
φ = (90 − lat)·π/180        θ = (90 − lng)·π/180
x = R·sin φ·cos θ    y = R·cos φ    z = R·sin φ·sin θ
```

Para el clic ocurre lo inverso: la librería lanza un rayo (*raycasting*) desde la cámara, calcula dónde corta la esfera y devuelve `{lat, lng}` a `onGlobeClick`. Como globe.gl usa por defecto el tamaño de la ventana, ajusto el lienzo al contenedor (`world.width/height` + evento `resize`).

## 4. ¿Cómo georreferencié marcadores y ocurrencias GBIF?

GBIF entrega cada ocurrencia con `decimalLatitude` y `decimalLongitude` (grados decimales, WGS84), igual que el sistema que usa el globo. `geo.php` filtra los registros con coordenadas válidas (`hasCoordinate=true`, `hasGeospatialIssue=false`) y manda `[lat, lng]`; el globo los dibuja como puntos (`pointsData`, altitud 0.004 para que queden pegados a la superficie). Los lugares analizados se marcan con anillos animados (`ringsData`) —verde A, azul B, amarillo normal— y la comparación A/B se une con un arco (`arcsData`). Cada marcador es accionable: el clic abre el panel con datos reales, simulación, guardado o comparación.

## 5. ¿Cómo calculo el índice de idoneidad?

`geo_idoneidad()` devuelve 0–100 como promedio ponderado de puntajes entre 0 y 1:

| Variable | Peso | Puntaje |
|---|---|---|
| Temperatura media | 35 % | `1 − |T − T_óptima| / 15` (T_óptima de la tabla `especies`) |
| Precipitación anual | 30 % | `P / 800 mm`, máximo 1 |
| Ocurrencias GBIF (200 km) | 20 % | 1 si hay registros, 0.2 si no |
| pH del suelo | 15 % | `1 − |pH − 6.5| / 2` |

Si una fuente no está disponible (por ejemplo, SoilGrids caído), se reparten los pesos entre las variables que sí hay. Los pesos y las referencias (800 mm, 6.5, ±15 °C) son criterios propios del proyecto, no valores científicos validados.

## 6. ¿Qué reglas geo-agronómicas implementé?

`geo_decisiones()` aplica cinco reglas; tres ejemplos:

| Condición | Nivel | Recomendación |
|---|---|---|
| Precipitación anual < 400 mm | crítico | Riego suplementario obligatorio |
| Temperatura media > 35 °C | crítico | Estrés térmico severo: considerar variedad resistente |
| pH del suelo < 5.5 | peligro | Suelo ácido: encalar antes de sembrar |

Las otras dos: 0 registros GBIF a 200 km → «alto riesgo, sin evidencia de adaptación local»; radiación > 25 MJ/m²/día → «considerar sombra parcial». Al guardar un análisis ligado a una simulación, estas decisiones se insertan en la tabla `decisiones`.

## 7. ¿Cómo manejo el caché y qué expiración usé?

Tabla `api_cache (fuente, clave, respuesta, expira_en)` con clave primaria `(fuente, clave)`. Expiración: **7 días** (`GEO_TTL = 604800`). Las coordenadas se redondean a 2 decimales (~1 km), de modo que clics cercanos reutilizan la misma respuesta. Solo se guardan respuestas exitosas, así un fallo temporal no queda cacheado. Esto respeta, por ejemplo, el máximo de 1 petición por segundo de Nominatim. Limitación: las filas vencidas no se borran automáticamente (se ignoran, pero ocupan espacio); bastaría un `DELETE ... WHERE expira_en < NOW()` programado.

## 8. ¿Cómo lanzo una simulación con datos reales de una ubicación?

1. Clic en el globo → `GET api/geo/analisis` → el panel muestra clima, suelo, GBIF, idoneidad y decisiones.
2. Botón **Simular aquí** → abre `index.html?temp=<temperatura media real>`.
3. Al final de `main.js`, un bloque lee `?temp=`, asigna el valor a `slider-temp` y dispara su evento `input`.
4. El motor de crecimiento usa esa temperatura y recalcula estrés, salud y biomasa; desde ahí se puede guardar con «Guardar en DB».

Limitación: solo se transfiere la temperatura; la humedad relativa no se puede derivar con rigor de la precipitación anual, así que se deja a criterio del usuario.

## 9. ¿Cómo funciona el comparador A/B geográfico?

Con la casilla «Comparar A/B» activa, el primer clic marca el lugar **A** y el segundo el lugar **B** (el ciclo se repite). Se unen con un arco y, al analizar B, el panel compara el **índice de idoneidad** de ambos: gana el mayor, y si son iguales se declara empate. Como la idoneidad ya integra temperatura, agua, suelo y ocurrencias, esa es la métrica de decisión; el detalle de cada variable se ve consultando el panel de cada lugar. No hay un margen mínimo de diferencia: una diferencia pequeña también declara ganador.

## 10. ¿Qué dificultades encontré y cómo las resolví?

- **Geocodificación inversa:** Open-Meteo Geocoding no la ofrece → Nominatim con caché y `User-Agent`.
- **Unidades y valores escalados:** NASA POWER da precipitación en mm/día (×365) y marca datos faltantes con −999 (se descartan y se usa Open-Meteo); SoilGrids entrega pH y fracciones multiplicados por un `d_factor` (se divide).
- **Tamaño del globo:** globe.gl ocupaba toda la ventana y tapaba el panel; se ajusta al contenedor.
- **Datos reales vs. simulación procedural:** el simulador trabaja con temperatura y humedad en días, y las APIs dan climatologías anuales. Solo se transfiere la temperatura media, que sí es comparable; la humedad no.
- **Datos de ejemplo incoherentes:** dos corridas del `seed.sql` contradecían al motor (a 35 °C mueren las 12 plantas); se retiraron y ahora se generan con la propia app.
- **APIs lentas o caídas** (sobre todo SoilGrids): timeouts, resultados opcionales y caché.

## 11. ¿Qué aporta el mapa 3D frente a un formulario de coordenadas?

Aporta exploración espacial: ver dónde existe realmente la especie (miles de puntos GBIF) y comparar de un vistazo un sitio candidato con su zona nativa, o dos lugares lejanos (Jutiapa vs. Córdoba), sin conocer coordenadas. Es útil para selección de sitios, descubrir regiones análogas y enseñanza. No aporta nada si ya se sabe la coordenada exacta de una finca: en ese caso un formulario sería igual de rápido. Por eso cada marcador lleva a una acción (analizar, simular, guardar, comparar).

## 12. ¿Cómo conectaría sensores IoT en tiempo real e imágenes satelitales? (propuesta, no implementada)

- **IoT:** los sensores publican por MQTT (temperatura, humedad de suelo) a un broker (Mosquitto); un servicio suscrito escribe en una tabla `lecturas(sensor_id, lat, lon, variable, valor, ts)`. Un endpoint `GET /api/geo/sensores` alimentaría marcadores en vivo y, sobre todo, los sliders de temperatura y humedad del simulador con datos medidos en lugar de climatologías.
- **NDVI / Sentinel-2:** consultar el catálogo STAC (Copernicus Data Space o Microsoft Planetary Computer) por coordenada y fecha con poca nubosidad, leer las bandas B04 (rojo) y B08 (infrarrojo cercano) de los GeoTIFF optimizados (COG) y calcular `NDVI = (B08 − B04) / (B08 + B04)`. El resultado por parcela se cachea como un valor más de `api_cache` y se muestra como capa de color sobre el globo o como nueva variable en la idoneidad y las reglas (p. ej. «NDVI < 0.3 → vegetación escasa»). El procesamiento pesado iría en un worker, no en la petición web.

## 13. ¿Cómo escalaría a miles de ubicaciones simultáneas? (propuesta, no implementada)

1. **Cuadrícula:** redondear las coordenadas a celdas (por ejemplo 0.25°) para que miles de puntos compartan pocas consultas.
2. **Cola de trabajos** (Redis/RabbitMQ): la petición web solo encola y devuelve un identificador; el cliente consulta el estado.
3. **Workers** con un limitador de tasa por API (respetar 1 req/s de Nominatim y los límites de SoilGrids), reintentos con *backoff* exponencial y *circuit breaker* si una API cae.
4. **Caché distribuida** (Redis, con MySQL como respaldo) y *request coalescing*: si 100 usuarios piden la misma celda, se hace una sola llamada externa.
5. **Datos masivos en local:** GBIF ofrece descargas masivas y SoilGrids rasters descargables; para miles de puntos es mejor leer capas locales que consultar punto por punto.
6. **Precálculo** de las ubicaciones más consultadas y purga programada de la caché vencida.

## 14. ¿Qué decisiones reales puede tomar un agrónomo con esta herramienta que no podía con la Práctica 05?

La Práctica 05 simulaba un cultivo con parámetros ingresados a mano. Ahora se puede: (1) preseleccionar sitios con datos reales de clima, suelo y presencia de la especie; (2) comparar candidatos y descartar los que requieren riego obligatorio, encalado o variedades resistentes; (3) comprobar si hay evidencia de que la especie ya se da en una región análoga; (4) simular el crecimiento bajo la temperatura real del lugar y ver el riesgo de estrés; (5) guardar y ordenar análisis en MySQL para documentar la decisión.

Advertencia: el índice de idoneidad es una herramienta de **cribado inicial**, con pesos propios sin validación frente a datos de campo, basado en climatologías y suelo a 250 m, con una sola especie. No reemplaza ensayos en campo ni el análisis de suelo de la parcela.
