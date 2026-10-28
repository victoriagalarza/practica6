import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// =============================================================================
// 0. CONSTANTES Y UTILIDADES
// =============================================================================
const API_BASE = 'api';   // /api/... lo redirige .htaccess a index.php
const N0 = 0.05;                    // altura inicial (u)
const UMBRAL_DANO = 40;             // estrés global (%) desde el cual la planta PIERDE salud
const UMBRAL_CRITICO = 75;          // estrés global (%) considerado crítico
const K_DANO = 3.5;                 // salud/día que se pierde con estrés = 100 % (resistencia = 1)
const REC_SALUD = 1.5;              // salud/día que se recupera con estrés < 25 %
const BIOMASA_POR_U = 18.5;         // g por unidad de altura (igual que en seed.sql)

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// Número "aleatorio" entre 0 y 1 que siempre da lo mismo para el mismo n.
// Así cada planta tiene siempre la misma resistencia y la simulación se puede repetir igual.
function aleatorio(n) {
    const x = Math.sin(n * 12.9898) * 43758.5453;
    return x - Math.floor(x);
}

let plantas = [];   // cada elemento = una azucena (estado biológico + objetos 3D)

// =============================================================================
// 1. MOTOR BIOINFORMÁTICO (crecimiento + estrés + MORTALIDAD)
// =============================================================================
function crearGrupo() {
    return { tickEf: 0, alturaN: N0, biomasa: N0 * BIOMASA_POR_U, icr: 0, eT: 0, eH: 0, eG: 0 };
}

const BioEngine = {
    especie: { tasa_crecimiento_base: 0.08, capacidad_carga_base: 2.5, temp_optima: 20.0, humedad_optima: 60.0, dias_madurez: 90 },
    modeloSeleccionado: 'logistico',

    tick: 0,
    ultimoDiaLog: -1,
    temperatura: 20.0,
    humedadSuelo: 60.0,
    numRamas: 3,
    numMacetas: 12,

    grupos: { A: crearGrupo(), B: crearGrupo() },
    modoAB: false,
    isPaused: false,
    estacionesActivas: false,
    enResim: false,

    telemetry: [],   // una fila por día -> gráfica y tabla mediciones
    decisiones: [],  // alertas emitidas -> tabla decisiones
    eventos: [],     // bitácora visible en el HUD
    nivelPrevio: null,
    muertesHoy: 0, recupHoy: 0, cierre: false,

    // ---------- Modelos de crecimiento ----------
    calcularAltura(t, r, K) {
        switch (this.modeloSeleccionado) {
            case 'lineal': return Math.min(K, N0 + (K - N0) * (t / 100.0));
            case 'exponencial': return Math.min(K, N0 * Math.exp((Math.log(K / N0) / 100.0) * t));
            case 'gompertz': return K * Math.exp(-Math.log(K / N0) * Math.exp(-r * t * 0.5));
            case 'logistico': default: return K / (1.0 + ((K - N0) / N0) * Math.exp(-r * t));
        }
    },

    // ---------- Ambiente ----------
    // Modo normal: todas las plantas usan los sliders.
    // Modo A/B: A = control en condiciones óptimas, B = condiciones de los sliders.
    entorno(id) {
        if (this.modoAB && id === 'A') return { temp: this.especie.temp_optima, hum: this.especie.humedad_optima };
        return { temp: this.temperatura, hum: this.humedadSuelo };
    },
    grupoKPI() { return this.modoAB ? 'B' : 'A'; },

    nombreEstacion(t) {
        if (t < 46 || t >= 319) return 'Primavera';
        if (t < 137) return 'Verano';
        if (t < 228) return 'Otoño';
        return 'Invierno';
    },

    aplicarEstaciones() {
        const fase = (this.tick / 365) * Math.PI * 2;
        this.temperatura = 20 + 11 * Math.sin(fase);
        this.humedadSuelo = 60 - 26 * Math.sin(fase);
        $('slider-temp').value = this.temperatura;
        $('lbl-temp').textContent = `${this.temperatura.toFixed(1)} °C`;
        $('slider-humedad').value = this.humedadSuelo;
        $('lbl-humedad').textContent = `${this.humedadSuelo.toFixed(1)} %`;
        $('btn-estaciones').innerHTML = `🌤️ Estaciones: ON (${this.nombreEstacion(this.tick)})`;
    },

    // ---------- Estrés (0-100) por desviación respecto al óptimo ----------
    calcularEstres(temp, hum) {
        // Qué tan lejos está del óptimo (0 = ideal, 100 = extremo)
        const eT = clamp((Math.abs(temp - this.especie.temp_optima) / 15.0) * 100, 0, 100);
        const eH = clamp((Math.abs(hum - this.especie.humedad_optima) / 40.0) * 100, 0, 100);
        // El estrés global es el del factor que más afecta a la planta
        const eG = Math.max(eT, eH);
        return { eT, eH, eG };
    },

    // ---------- Consultas ----------
    plantasDe(id) { return plantas.filter(p => p.grupoId === id); },
    biomasaPlanta(p) {
        if (p.muerta) return 0;
        return this.grupos[p.grupoId].biomasa * (0.4 + 0.6 * p.salud / 100);
    },
    biomasaTotal(id) { return this.plantasDe(id).reduce((s, p) => s + this.biomasaPlanta(p), 0); },
    vivas(id) { return this.plantasDe(id).filter(p => !p.muerta).length; },

    // ---------- Mortalidad ----------
    matar(p, g) {
        this.muertesHoy++;
        p.muerta = true;
        p.salud = 0;
        p.tickMuerte = this.tick;
        p.progresoMuerte = clamp(Math.max(g.alturaN / this.especie.capacidad_carga_base * 0.8, 0.22), 0.03, 1); // queda seca y visible
        const causa = (p.estresT >= p.estresH) ? 'térmico' : 'hídrico';
        const dia = Math.floor(this.tick);
        this.registrarEvento(`Día ${dia}: murió la planta #${p.idx + 1} (esc. ${p.grupoId}) por estrés ${causa}`, 'muerte');
        this.decisiones.push({
            tick: dia,
            alerta: `Mortalidad: planta #${p.idx + 1} (escenario ${p.grupoId}) por estrés ${causa}`,
            recomendacion: `La planta murió tras ${p.diasEstres.toFixed(0)} días de estrés dañino. Hay que corregir el factor ${causa}.`
        });
    },

    // Una planta que bajó de 60 % de salud y vuelve a 90 % o más "revive": queda aclimatada (más resistente)
    registrarRecuperacion(p) {
        p.resistencia = Math.min(3.2, p.resistencia * 1.15);
        p.recuperaciones++; p.danada = false;
        this.recupHoy++;
        const dia = Math.floor(this.tick);
        this.registrarEvento(`Día ${dia}: la planta #${p.idx + 1} (esc. ${p.grupoId}) se recuperó y quedó más fuerte`, 'recupera');
        this.decisiones.push({
            tick: dia,
            alerta: `Recuperación: planta #${p.idx + 1} (escenario ${p.grupoId})`,
            recomendacion: 'La planta se recuperó del estrés y se aclimató: ahora resiste más.'
        });
    },

    registrarCierre() {
        const ids = this.modoAB ? ['A', 'B'] : ['A'];
        const partes = ids.map(id => this.modoAB ? `${id} ${this.vivas(id)}/${this.plantasDe(id).length}` : `${this.vivas(id)}/${this.plantasDe(id).length}`);
        const vivas = plantas.filter(p => !p.muerta);
        const aclim = vivas.filter(p => p.recuperaciones > 0).length;
        const texto = vivas.length
            ? `Día 365: ciclo completo. Sobrevivieron ${partes.join(' · ')} (${vivas.map(p => '#' + (p.idx + 1)).join(', ')}); ${aclim} se recuperaron del estrés y quedaron aclimatadas.`
            : 'Día 365: ciclo completo. Ninguna planta sobrevivió.';
        this.registrarEvento(texto, 'final');
        this.decisiones.push({ tick: 365, alerta: 'Cierre del ciclo anual', recomendacion: texto });
    },

    registrarEvento(texto, tipo) {
        this.eventos.push({ texto, tipo });
        if (this.eventos.length > 40) this.eventos.shift();
        if (!this.enResim) renderEventos();
    },

    // ---------- Motor de decisiones ----------
    recomendar() {
        const id = this.grupoKPI(), g = this.grupos[id], env = this.entorno(id), esp = this.especie;
        const muertas = this.plantasDe(id).filter(p => p.muerta).length;
        // Se corrige el factor que más estrés causa
        const accionT = env.temp > esp.temp_optima ? 'bajar la temperatura' : 'subir la temperatura';
        const accionH = env.hum < esp.humedad_optima ? 'regar más' : 'regar menos';
        const principal = g.eT >= g.eH ? accionT : accionH;
        let nivel, alerta, texto, color;
        if (g.eG > UMBRAL_CRITICO) {
            nivel = 'critico'; color = '#ef4444';
            alerta = `Estrés crítico (${g.eG.toFixed(0)} %)`;
            texto = `🚨 CRÍTICO: hay que ${principal} de inmediato.`;
        } else if (g.eG > UMBRAL_DANO) {
            nivel = 'peligro'; color = '#fb923c';
            alerta = `Estrés dañino (${g.eG.toFixed(0)} %)`;
            texto = `⚠️ Las plantas pierden salud: hay que ${principal}.`;
        } else {
            nivel = 'ok'; color = '#4ade80';
            alerta = 'Condiciones adecuadas';
            texto = '✅ Condiciones adecuadas para el cultivo.';
        }
        if (muertas > 0) texto += ` 🥀 ${muertas} planta(s) muerta(s).`;
        return { nivel, alerta, texto, color };
    },

    // Predicción de cosecha: cuántos días faltan para llegar al 95 % de K con el estrés actual
    prediccionCosecha() {
        const id = this.grupoKPI(), g = this.grupos[id], esp = this.especie;
        if (this.vivas(id) === 0) return 'Sin plantas vivas';
        const objetivo = 0.95 * esp.capacidad_carga_base;
        if (g.alturaN >= objetivo) return '✅ Lista para cosecha';
        const factor = Math.max(0.02, 1 - g.eG / 100);
        let t = g.tickEf, n = 0;
        while (this.calcularAltura(t, esp.tasa_crecimiento_base, esp.capacidad_carga_base) < objetivo && n++ < 3000) t += 1;
        if (n >= 3000) return 'No alcanzará la madurez';
        const dias = Math.ceil((t - g.tickEf) / factor);
        const dia = Math.floor(this.tick) + dias;
        return dia > 365 ? `Después del día 365 (faltan ${dias} d)` : `Día ${dia} (faltan ${dias} d)`;
    },

    snapshot(dia) {
        const id = this.grupoKPI(), g = this.grupos[id];
        const pct = (gid) => { const n = this.plantasDe(gid).length; return n ? (this.vivas(gid) / n) * 100 : null; };
        return {
            tick: dia,
            bioA: this.biomasaTotal('A'), bioB: this.biomasaTotal('B'),
            vivasA: pct('A'), vivasB: pct('B'),
            altura: g.alturaN, estresT: g.eT, estresH: g.eH, icr: g.icr,
            plantasVivas: this.vivas(id),
            vivasK: pct(id), estresG: g.eG, muertes: this.muertesHoy, recup: this.recupHoy
        };
    },

    reset() {
        this.tick = 0;
        this.ultimoDiaLog = -1;
        this.grupos = { A: crearGrupo(), B: crearGrupo() };
        this.telemetry = [];
        this.decisiones = [];
        this.eventos = [];
        this.nivelPrevio = null;
        this.muertesHoy = 0; this.recupHoy = 0; this.cierre = false;
        plantas.forEach(resetPlanta);
        renderEventos();
    },

    // ---------- Paso de simulación (dt en días) ----------
    step(dtReq) {
        const previo = this.tick;
        this.tick = Math.min(365, this.tick + dtReq);
        const dt = this.tick - previo;
        if (dt <= 0) return;
        if (this.estacionesActivas) this.aplicarEstaciones();

        const esp = this.especie;
        // 1) crecimiento y estrés por escenario
        for (const id of ['A', 'B']) {
            const g = this.grupos[id], env = this.entorno(id);
            const e = this.calcularEstres(env.temp, env.hum);
            g.eT = e.eT; g.eH = e.eH; g.eG = e.eG;
            g.tickEf += dt * Math.max(0.02, 1 - g.eG / 100);
            const prev = g.alturaN;
            g.alturaN = this.calcularAltura(g.tickEf, esp.tasa_crecimiento_base, esp.capacidad_carga_base);
            g.icr = (Math.log(g.alturaN) - Math.log(prev)) / dt;
            g.biomasa = g.alturaN * BIOMASA_POR_U;
        }

        // 2) salud individual: cada planta acumula daño según su propia resistencia
        for (const p of plantas) {
            if (p.muerta) continue;
            const g = this.grupos[p.grupoId];
            const s = g.eG;
            p.estresActual = s;
            p.estresT = g.eT;
            p.estresH = g.eH;
            if (s > UMBRAL_DANO) {
                p.salud -= K_DANO * ((s - UMBRAL_DANO) / (100 - UMBRAL_DANO)) / p.resistencia * dt;
                p.diasEstres += dt;
            } else if (s < 25) {
                p.salud = Math.min(100, p.salud + REC_SALUD * p.resistencia * dt);
            }
            if (p.salud <= 0) { this.matar(p, g); continue; }
            if (p.salud < 60) p.danada = true;
            if (p.danada && p.salud >= 90) this.registrarRecuperacion(p);
        }

        // 3) decisiones (solo se registran los cambios de nivel)
        const rec = this.recomendar();
        if (rec.nivel !== this.nivelPrevio) {
            if (this.nivelPrevio !== null || rec.nivel !== 'ok') {
                this.decisiones.push({ tick: Math.floor(this.tick), alerta: rec.alerta, recomendacion: rec.texto });
                if (this.decisiones.length > 200) this.decisiones.shift();
                if (rec.nivel === 'critico') this.registrarEvento(`Día ${Math.floor(this.tick)}: ${rec.alerta}`, 'alerta');
            }
            this.nivelPrevio = rec.nivel;
        }

        if (this.tick >= 365 && !this.cierre) { this.cierre = true; this.registrarCierre(); }

        // 4) telemetría diaria
        const dia = Math.floor(this.tick);
        if (dia > this.ultimoDiaLog) {
            this.ultimoDiaLog = dia;
            this.telemetry.push(this.snapshot(dia));
            this.muertesHoy = 0; this.recupHoy = 0;
            if (!this.enResim) { actualizarGrafica(); actualizarMiniGrafica(); }
        }
    },

    update(deltaSeconds) {
        if (this.isPaused) return;
        this.step(deltaSeconds * 12.0); // 12 días por segundo -> el año dura ~30 s
    }
};

function resetPlanta(p) {
    p.resistencia = p.resistenciaBase; p.recuperaciones = 0; p.danada = false;
    p.salud = 100; p.muerta = false; p.tickMuerte = null; p.progresoMuerte = 0;
    p.progreso = 0.02; p.droop = 0; p.vitVis = 1;
    p.estresT = 0; p.estresH = 0; p.estresActual = 0; p.diasEstres = 0;
}

// Re-simula de 0 a "dia" con el ambiente actual (determinista): sirve para la línea de tiempo y para reconstruir
function resimularHasta(dia) {
    BioEngine.enResim = true;
    BioEngine.reset();
    let guard = 0;
    while (BioEngine.tick < dia - 1e-9 && guard++ < 2000) BioEngine.step(Math.min(1, dia - BioEngine.tick));
    BioEngine.enResim = false;
    renderEventos();
    actualizarGrafica();
    actualizarMiniGrafica();
    plantas.forEach(p => aplicarVisual(p, true));
}

// =============================================================================
// 2. ESCENA 3D Y ENTORNO
// =============================================================================
const container = $('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xdbeafe);
scene.fog = new THREE.Fog(0xdbeafe, 24, 60);

const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 1000);
const CAM_POS = new THREE.Vector3(0, 5.4, 11.2);
const CAM_TARGET = new THREE.Vector3(0, 2.3, -1.0);
camera.position.copy(CAM_POS);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
container.appendChild(renderer.domElement);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(CAM_TARGET);

scene.add(new THREE.AmbientLight(0xffffff, 0.85));
const dirLight = new THREE.DirectionalLight(0xffffff, 1.8);
dirLight.position.set(6, 11, 7);
dirLight.castShadow = true;
scene.add(dirLight);

function texturaPiso() {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#e8edf3'; g.fillRect(0, 0, 128, 128);
    g.fillStyle = '#dbe2ea'; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
    g.strokeStyle = '#c4cdd8'; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(16, 16); t.colorSpace = THREE.SRGBColorSpace;
    return t;
}
const floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(32, 32), new THREE.MeshStandardMaterial({ map: texturaPiso(), roughness: 0.3 }));
floorMesh.rotation.x = -Math.PI / 2;
scene.add(floorMesh);

// ---------- Mesas de cultivo: 2 mesas con macetas en zigzag (ocupa menos espacio) ----------
const steelMat = new THREE.MeshStandardMaterial({ color: 0xf1f5f9, roughness: 0.25, metalness: 0.35 });
const legMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.5 });
const tablePositions = [{ x: -3.7, z: 0 }, { x: 3.7, z: 0 }];
const TABLE_W = 6.8, TABLE_D = 3.0;
const growLightMat = new THREE.MeshBasicMaterial({ color: 0xf5d0fe });
const wireMat = new THREE.MeshStandardMaterial({ color: 0x334155 });

tablePositions.forEach(pos => {
    const table = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W, 0.2, TABLE_D), steelMat);
    table.position.set(pos.x, 1.2, pos.z);
    scene.add(table);
    const baja = new THREE.Mesh(new THREE.BoxGeometry(TABLE_W - 0.6, 0.06, TABLE_D - 0.6), steelMat);
    baja.position.set(pos.x, 0.45, pos.z);
    scene.add(baja);
    [-1, 1].forEach(sx => [-1, 1].forEach(sz => {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), legMat);
        leg.position.set(pos.x + sx * (TABLE_W / 2 - 0.2), 0.55, pos.z + sz * (TABLE_D / 2 - 0.2));
        scene.add(leg);
    }));
    // Lámpara de cultivo (LED) colgada sobre cada mesa
    const lampara = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.12, 0.5), growLightMat);
    lampara.position.set(pos.x, 5.3, pos.z);
    scene.add(lampara);
    [-1, 1].forEach(sx => {
        const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 3.7, 6), wireMat);
        cable.position.set(pos.x + sx * 2.6, 7.15, pos.z);
        scene.add(cable);
    });
});

// Posición de cada maceta: dos hileras desfasadas (zigzag) en cada mesa
function slotMesa(mesaIdx, k) {
    const col = Math.floor(k / 2), fila = k % 2;
    return {
        x: tablePositions[mesaIdx].x + (col - 1.5) * 1.3 + (fila ? 0.35 : -0.35),
        z: tablePositions[mesaIdx].z + (fila ? 0.7 : -0.7)
    };
}

// ---------- Ambiente de laboratorio ----------
function caja(w, h, d, color, x, y, z, rough = 0.8) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color, roughness: rough }));
    m.position.set(x, y, z); scene.add(m); return m;
}
function cilindro(rt, rb, h, color, x, y, z, opts = {}) {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: opts.rough ?? 0.5, transparent: !!opts.op, opacity: opts.op ?? 1 });
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, opts.seg ?? 16), mat);
    m.position.set(x, y, z); scene.add(m); return m;
}
function matraz(x, y, z, color) {      // matraz Erlenmeyer
    cilindro(0.06, 0.2, 0.3, color, x, y + 0.15, z, { op: 0.6, rough: 0.1 });
    cilindro(0.06, 0.06, 0.18, 0xe2e8f0, x, y + 0.39, z, { op: 0.45, rough: 0.1 });
}
function vaso(x, y, z, color, h = 0.28) {   // vaso de precipitados
    cilindro(0.12, 0.12, h, 0xe2e8f0, x, y + h / 2, z, { op: 0.35, rough: 0.1 });
    cilindro(0.1, 0.1, h * 0.6, color, x, y + h * 0.3 + 0.01, z, { op: 0.75, rough: 0.1 });
}
function textura(ancho, alto, dibujar) {
    const c = document.createElement('canvas'); c.width = ancho; c.height = alto;
    dibujar(c.getContext('2d'), ancho, alto);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function construirLaboratorio() {
    // Paredes y zócalo
    const pared = 0xeef2f7;
    caja(26, 9, 0.3, pared, 0, 4.5, -8);
    caja(0.3, 9, 17, pared, -13, 4.5, 0.5);
    caja(0.3, 9, 17, pared, 13, 4.5, 0.5);
    caja(26, 0.3, 0.2, 0x94a3b8, 0, 0.15, -7.8);
    caja(0.2, 0.3, 17, 0x94a3b8, -12.8, 0.15, 0.5);
    caja(0.2, 0.3, 17, 0x94a3b8, 12.8, 0.15, 0.5);

    // Ventana
    caja(4.4, 2.8, 0.1, 0x94a3b8, -8, 5, -7.8);
    const cristal = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 2.4), new THREE.MeshBasicMaterial({ color: 0xbfdbfe }));
    cristal.position.set(-8, 5, -7.73); scene.add(cristal);
    caja(0.07, 2.4, 0.04, 0xf8fafc, -8, 5, -7.7);
    caja(4.0, 0.07, 0.04, 0xf8fafc, -8, 5, -7.7);

    // Pizarrón con el modelo
    caja(4.6, 2.5, 0.08, 0x64748b, 4.5, 5, -7.8);
    const pizarra = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 2.3), new THREE.MeshBasicMaterial({
        map: textura(512, 270, (g, w, h) => {
            g.fillStyle = '#f8fafc'; g.fillRect(0, 0, w, h);
            g.fillStyle = '#0f172a'; g.font = 'bold 26px sans-serif'; g.fillText('Laboratorio Bioinformático', 20, 42);
            g.fillStyle = '#15803d'; g.font = 'italic 22px sans-serif'; g.fillText('Lilium candidum (azucena)', 20, 78);
            g.fillStyle = '#1e3a8a'; g.font = '20px sans-serif';
            g.fillText('N(t) = K / (1 + ((K − N₀)/N₀)·e^(−r·t))', 20, 130);
            g.fillText('Estrés = f(Temp, Humedad)', 20, 170);
            g.fillStyle = '#b91c1c'; g.fillText('Estrés > 40 %  →  salud ↓  →  muerte', 20, 210);
            g.strokeStyle = '#94a3b8'; g.strokeRect(6, 6, w - 12, h - 12);
        })
    }));
    pizarra.position.set(4.5, 5, -7.74); scene.add(pizarra);

    // Repisas con material de vidrio
    caja(4.2, 0.08, 0.5, 0x94a3b8, -1.6, 3.9, -7.55);
    caja(4.2, 0.08, 0.5, 0x94a3b8, -1.6, 5.2, -7.55);
    [-3, -2.4, -1.8, -1.2].forEach((x, i) => matraz(x, 3.94, -7.55, [0x4ade80, 0x38bdf8, 0xfacc15, 0xf472b6][i]));
    [-0.6, -0.1, 0.4].forEach((x, i) => vaso(x, 3.94, -7.55, [0x38bdf8, 0x4ade80, 0xfb923c][i]));
    [-3, -2.3, -1.6].forEach((x, i) => vaso(x, 5.24, -7.55, [0xfacc15, 0x4ade80, 0x38bdf8][i], 0.34));
    [-0.8, -0.1, 0.6].forEach((x, i) => matraz(x, 5.24, -7.55, [0xf472b6, 0x38bdf8, 0x4ade80][i]));

    // Mesón trasero con equipo
    caja(13, 1.1, 1.1, 0x94a3b8, 0.5, 0.55, -6.9, 0.5);
    caja(13.2, 0.1, 1.3, 0xf1f5f9, 0.5, 1.15, -6.9, 0.3);
    for (let k = -5; k <= 6; k += 1.5) caja(0.03, 0.9, 0.02, 0x475569, k + 0.5, 0.55, -6.34);
    const yB = 1.2, zB = -6.9;

    // Microscopio
    const mic = new THREE.Group();
    const cmic = new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.4 });
    const parte = (geo, x, y, z, rx = 0) => { const m = new THREE.Mesh(geo, cmic); m.position.set(x, y, z); m.rotation.x = rx; mic.add(m); };
    parte(new THREE.BoxGeometry(0.38, 0.06, 0.5), 0, 0.03, 0);
    parte(new THREE.CylinderGeometry(0.04, 0.04, 0.55, 10), 0, 0.3, -0.16);
    parte(new THREE.CylinderGeometry(0.055, 0.055, 0.38, 12), 0, 0.5, 0.0, -0.5);
    parte(new THREE.BoxGeometry(0.28, 0.03, 0.22), 0, 0.22, 0.05);
    mic.position.set(-4, yB, zB); scene.add(mic);

    // Laptop con pantalla encendida
    caja(0.7, 0.03, 0.5, 0x334155, 0.2, yB + 0.015, zB);
    const pant = caja(0.7, 0.45, 0.03, 0x1e293b, 0.2, yB + 0.26, zB - 0.24); pant.rotation.x = -0.25;
    const luz = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.37), new THREE.MeshBasicMaterial({ color: 0x4ade80 }));
    luz.position.set(0.2, yB + 0.26, zB - 0.222); luz.rotation.x = -0.25; scene.add(luz);

    // Gradilla con tubos de ensayo
    caja(0.9, 0.05, 0.25, 0x92400e, 2.8, yB + 0.025, zB);
    for (let k = 0; k < 6; k++) cilindro(0.035, 0.035, 0.28, [0x4ade80, 0x38bdf8, 0xfacc15, 0xf472b6, 0x4ade80, 0x38bdf8][k], 2.5 + k * 0.12, yB + 0.19, zB, { op: 0.7, seg: 10, rough: 0.1 });

    // Matraces y vasos sobre el mesón
    matraz(5.4, yB, zB, 0x38bdf8); matraz(5.9, yB, zB, 0x4ade80); vaso(6.5, yB, zB, 0xfb923c);

}
construirLaboratorio();

// =============================================================================
// 3. CONSTRUCCIÓN PROCEDURAL DE LA AZUCENA (con estados: sana → marchita → muerta)
// =============================================================================
const vertexShader = `
    uniform float uTime;
    uniform float uWindIntensity;
    uniform float uVitality;
    varying float vTip;
    void main() {
        vec3 pos = position;
        float tip = clamp((pos.x + 0.43) / 0.86, 0.0, 1.0);
        vTip = tip;
        // una planta muerta/seca casi no ondea
        float wind = sin(uTime * 4.0 + modelMatrix[3][0]) * 0.18 * uWindIntensity * tip * mix(0.1, 1.0, uVitality);
        pos.y += wind;
        pos.z += wind * 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
    }
`;
const fragmentShader = `
    uniform vec3 uBaseColor;
    uniform vec3 uTipColor;
    uniform float uVitality;   // 1 = sana, 0 = muerta
    uniform float uGrowth;
    varying float vTip;
    void main() {
        vec3 sana = mix(uBaseColor, uTipColor, vTip);
        vec3 amarillo = vec3(0.55, 0.45, 0.02);
        vec3 marron = vec3(0.10, 0.05, 0.015);
        vec3 c = mix(amarillo, sana, smoothstep(0.45, 0.85, uVitality));
        c = mix(marron, c, smoothstep(0.05, 0.45, uVitality));
        c = mix(c, marron, (1.0 - uVitality) * vTip * 0.5);      // las puntas se secan primero
        c *= 0.6 + 0.4 * clamp(uGrowth * 1.5, 0.0, 1.0);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
    }
`;

function crearMatHoja() {
    return new THREE.ShaderMaterial({
        vertexShader, fragmentShader, side: THREE.DoubleSide,
        uniforms: {
            uTime: { value: 0 }, uWindIntensity: { value: 1.5 }, uVitality: { value: 1 }, uGrowth: { value: 0 },
            uBaseColor: { value: new THREE.Color(0x15803d) }, uTipColor: { value: new THREE.Color(0x84cc16) }
        }
    });
}

const stemGeo = new THREE.CylinderGeometry(0.04, 0.06, 1.8, 16); stemGeo.translate(0, 0.9, 0);
const branchGeo = new THREE.CylinderGeometry(0.015, 0.025, 0.65, 8); branchGeo.translate(0, 0.325, 0);
const leafGeo = new THREE.SphereGeometry(0.24, 16, 12); leafGeo.scale(1.8, 0.1, 0.5);
const potGeo = new THREE.CylinderGeometry(0.45, 0.32, 0.7, 32);
const petalGeo = new THREE.SphereGeometry(0.1, 10, 8); petalGeo.scale(0.5, 1.6, 0.25); petalGeo.translate(0, 0.16, 0);

const COLOR_VERDE = new THREE.Color(0x16a34a);
const COLOR_AMARILLO = new THREE.Color(0x9a8f2a);
const COLOR_SECO = new THREE.Color(0x4a3623);

function buildPlant(i, pos, grupoId, semilla) {
    const p = {
        idx: i, grupoId,
        resistenciaBase: 0.6 + aleatorio(semilla * 3 + 1) * 1.4,   // cada planta resiste distinto (de 0.6 a 2.0)
        lado: aleatorio(semilla * 3 + 2) < 0.5 ? -1 : 1,        // hacia dónde se dobla al marchitarse
        hojas: [], ramas: [], hojasDesarrolladas: 0, ramasVisibles: 0, flor: null
    };
    resetPlanta(p);

    const root = new THREE.Group();
    root.position.set(pos.x, 1.3, pos.z);
    scene.add(root);

    const matHoja = crearMatHoja();
    const matTallo = new THREE.MeshStandardMaterial({ color: COLOR_VERDE, roughness: 0.35 });
    const matMaceta = new THREE.MeshStandardMaterial({ color: grupoId === 'B' && BioEngine.modoAB ? 0x0f766e : 0xb45309 });
    const matFlor = new THREE.MeshStandardMaterial({ color: 0xfafaf9, roughness: 0.4, side: THREE.DoubleSide });

    const maceta = new THREE.Mesh(potGeo, matMaceta);
    maceta.position.y = 0.35;
    root.add(maceta);

    const group = new THREE.Group();
    group.position.y = 0.7;
    root.add(group);

    const tallo = new THREE.Mesh(stemGeo, matTallo);
    tallo.userData = { parte: { tipo: 'tallo', n: 0 }, planta: p };
    group.add(tallo);

    // Hojas del tallo principal
    for (let k = 0; k < 6; k++) {
        const nodo = new THREE.Group();
        nodo.position.y = 0.25 + k * 0.26;
        nodo.rotation.y = k * Math.PI * 0.55 + i;
        const m = new THREE.Mesh(leafGeo, matHoja);
        m.position.set(0.28, 0, 0); m.rotation.z = -0.25;
        const umbral = 0.04 + k * 0.07;
        m.userData = { parte: { tipo: 'hoja', n: k, umbral }, planta: p };
        nodo.add(m); group.add(nodo);
        p.hojas.push({ mesh: m, umbral, dev: 0 });
    }

    // Ramas (slider "Ramas") con 2 hojas cada una
    const nR = BioEngine.numRamas;
    for (let b = 0; b < nR; b++) {
        const umbral = 0.25 + b * 0.12;
        const pivot = new THREE.Group();
        pivot.position.y = 0.55 + b * (0.9 / Math.max(1, nR));
        pivot.rotation.y = b * 2.4 + i * 0.7;
        const rama = new THREE.Mesh(branchGeo, matTallo);
        rama.userData = { parte: { tipo: 'rama', n: b, umbral }, planta: p };
        pivot.add(rama);
        for (let h = 0; h < 2; h++) {
            const nodo = new THREE.Group();
            nodo.position.y = 0.3 + h * 0.28;
            nodo.rotation.y = h * Math.PI;
            const m = new THREE.Mesh(leafGeo, matHoja);
            m.position.set(0.2, 0, 0); m.rotation.z = -0.25;
            const u = umbral + 0.06 + h * 0.08;
            m.userData = { parte: { tipo: 'hoja', n: 6 + b * 2 + h, umbral: u }, planta: p };
            nodo.add(m); pivot.add(nodo);
            p.hojas.push({ mesh: m, umbral: u, dev: 0 });
        }
        group.add(pivot);
        p.ramas.push({ pivot, umbral, base: 0.75 });
    }

    // Flor (azucena blanca): aparece al acercarse a la floración
    const flor = new THREE.Group();
    flor.position.y = 1.8;
    for (let k = 0; k < 6; k++) {
        const piv = new THREE.Group();
        piv.rotation.y = k * Math.PI / 3;
        const pet = new THREE.Mesh(petalGeo, matFlor);
        pet.rotation.x = 0.9;
        pet.userData = { parte: { tipo: 'flor', n: k }, planta: p };
        piv.add(pet); flor.add(piv);
    }
    flor.visible = false;
    group.add(flor);

    p.root = root; p.group = group; p.flor = flor; p.tallo = tallo;
    p.mats = { hoja: matHoja, tallo: matTallo, maceta: matMaceta, flor: matFlor };
    plantas.push(p);
    return p;
}

function rebuildPlants() {
    plantas.forEach(p => { scene.remove(p.root); Object.values(p.mats).forEach(m => m.dispose()); });
    plantas = [];
    const count = BioEngine.numMacetas;
    const mitad = Math.floor(count / 2);
    // Normal: reparte entre las 2 mesas. A/B: A en la mesa izquierda, B en la derecha
    const nIzq = BioEngine.modoAB ? mitad : Math.ceil(count / 2);
    let kIzq = 0, kDer = 0;
    for (let i = 0; i < count; i++) {
        const izq = i < nIzq;
        const pos = slotMesa(izq ? 0 : 1, izq ? kIzq++ : kDer++);
        const grupoId = (BioEngine.modoAB && i >= mitad) ? 'B' : 'A';
        // En A/B, la planta i de A y su "pareja" en B comparten genética: solo cambia el ambiente
        const semilla = BioEngine.modoAB ? i % Math.max(1, mitad) : i;
        buildPlant(i, pos, grupoId, semilla);
    }
    resimularHasta(BioEngine.tick);
}

// Aplica el estado biológico de la planta a su aspecto 3D
function aplicarVisual(p, snap = false) {
    const g = BioEngine.grupos[p.grupoId];
    const K = BioEngine.especie.capacidad_carga_base;
    const progG = clamp(g.alturaN / K, 0.02, 1);
    const vit = p.salud / 100;
    const objProg = p.muerta ? p.progresoMuerte : progG * (0.45 + 0.55 * vit);
    const objDroop = p.muerta ? 1 : clamp((0.8 - vit) / 0.8, 0, 1);

    if (snap) { p.progreso = objProg; p.droop = objDroop; p.vitVis = vit; }
    else {
        p.progreso += (objProg - p.progreso) * 0.08;
        p.droop += (objDroop - p.droop) * 0.04;
        p.vitVis += (vit - p.vitVis) * 0.06;
    }
    const prog = clamp(p.progreso, 0, 1);

    p.group.scale.setScalar(Math.max(0.04, prog));
    p.group.rotation.z = p.lado * p.droop * 0.5;            // el tallo se dobla al marchitarse
    p.mats.hoja.uniforms.uVitality.value = p.vitVis;
    p.mats.hoja.uniforms.uGrowth.value = prog;
    if (p.vitVis >= 0.5) p.mats.tallo.color.lerpColors(COLOR_AMARILLO, COLOR_VERDE, (p.vitVis - 0.5) * 2);
    else p.mats.tallo.color.lerpColors(COLOR_SECO, COLOR_AMARILLO, p.vitVis * 2);

    let hojas = 0;
    for (const h of p.hojas) {
        const d = clamp((prog - h.umbral) / 0.2, 0, 1);
        h.dev = d;
        h.mesh.visible = d > 0;
        h.mesh.scale.setScalar(0.35 + 0.65 * d);
        h.mesh.rotation.z = -0.25 - p.droop * 1.2;          // las hojas cuelgan
        if (d > 0) hojas++;
    }
    p.hojasDesarrolladas = hojas;

    let ramas = 0;
    for (const r of p.ramas) {
        r.pivot.visible = prog >= r.umbral;
        r.pivot.rotation.z = -(r.base + p.droop * 0.7);
        if (r.pivot.visible) ramas++;
    }
    p.ramasVisibles = ramas;

    const fd = clamp((g.tickEf - (BioEngine.especie.dias_madurez - 20)) / 20, 0, 1);
    p.flor.visible = !p.muerta && fd > 0 && p.vitVis > 0.25;
    p.flor.scale.setScalar(Math.max(0.01, fd));
}

// =============================================================================
// 4. GRÁFICAS (Chart.js) Y REPORTES
// =============================================================================
let growthChart = null;
function crearGrafica() {
    const tk = { color: '#94a3b8' };
    growthChart = new Chart($('growthChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [], datasets: [
                { label: 'Biomasa viva A (g)', data: [], borderColor: '#4ade80', backgroundColor: 'rgba(74,222,128,0.15)', fill: true, tension: 0.3, pointRadius: 0, yAxisID: 'y' },
                { label: 'Biomasa viva B (g)', data: [], borderColor: '#fb923c', backgroundColor: 'rgba(251,146,60,0.15)', fill: true, tension: 0.3, pointRadius: 0, yAxisID: 'y' },
                { label: 'Supervivencia A (%)', data: [], borderColor: '#38bdf8', borderDash: [6, 4], stepped: true, pointRadius: 0, yAxisID: 'y1' },
                { label: 'Supervivencia B (%)', data: [], borderColor: '#f43f5e', borderDash: [6, 4], stepped: true, pointRadius: 0, yAxisID: 'y1' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            scales: {
                x: { ticks: { ...tk, maxTicksLimit: 12 } },
                y: { beginAtZero: true, ticks: tk, title: { display: true, text: 'Biomasa viva (g)', color: '#94a3b8' } },
                y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: tk, title: { display: true, text: 'Plantas vivas (%)', color: '#94a3b8' } }
            },
            plugins: { legend: { labels: { color: '#cbd5e1' } } }
        }
    });
}

function actualizarGrafica() {
    if (!growthChart) return;
    const t = BioEngine.telemetry;
    growthChart.data.labels = t.map(d => `Día ${d.tick}`);
    growthChart.data.datasets[0].data = t.map(d => d.bioA);
    growthChart.data.datasets[1].data = t.map(d => d.bioB);
    growthChart.data.datasets[2].data = t.map(d => d.vivasA);
    growthChart.data.datasets[3].data = t.map(d => d.vivasB);
    growthChart.data.datasets[1].hidden = !BioEngine.modoAB;
    growthChart.data.datasets[3].hidden = !BioEngine.modoAB;
    growthChart.update('none');
}

let miniChart = null;
function crearMiniGrafica() {
    const tk = { color: '#94a3b8', font: { size: 9 } };
    const grid = { color: 'rgba(148,163,184,0.12)' };
    miniChart = new Chart($('miniChart').getContext('2d'), {
        type: 'line',
        data: {
            labels: [], datasets: [
                { label: 'Vivas %', data: [], borderColor: '#38bdf8', stepped: true, pointRadius: 0, borderWidth: 2, fill: false },
                { label: 'Estrés %', data: [], borderColor: '#f87171', backgroundColor: 'rgba(248,113,113,0.12)', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 1.5 },
                { label: 'Muerte', data: [], showLine: false, pointStyle: 'rectRot', pointRadius: 5, backgroundColor: '#ef4444', borderColor: '#ef4444' },
                { label: 'Revivió', data: [], showLine: false, pointStyle: 'triangle', pointRadius: 6, backgroundColor: '#4ade80', borderColor: '#4ade80' }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            interaction: { mode: 'index', intersect: false },
            scales: {
                x: { ticks: { ...tk, maxTicksLimit: 7 }, grid, title: { display: true, text: 'Día', color: '#94a3b8', font: { size: 9 } } },
                y: { min: 0, max: 100, ticks: { ...tk, stepSize: 25 }, grid }
            },
            plugins: { legend: { position: 'bottom', labels: { color: '#cbd5e1', boxWidth: 8, font: { size: 9 }, usePointStyle: true } } }
        }
    });
}

function actualizarMiniGrafica() {
    if (!miniChart) return;
    const t = BioEngine.telemetry;
    miniChart.data.labels = t.map(d => d.tick);
    miniChart.data.datasets[0].data = t.map(d => d.vivasK);
    miniChart.data.datasets[1].data = t.map(d => d.estresG);
    miniChart.data.datasets[2].data = t.map(d => d.muertes > 0 ? d.vivasK : null);
    miniChart.data.datasets[3].data = t.map(d => d.recup > 0 ? d.vivasK : null);
    miniChart.update('none');
}

async function cargarReportes() {
    const box = $('reportes-box');
    try {
        const r = await api('/reportes');
        box.innerHTML = '';
        const linea = (txt, negrita = false) => {
            const p = document.createElement(negrita ? 'strong' : 'p');
            p.textContent = txt; box.appendChild(p);
        };
        linea('🏆 Top 5 simulaciones por biomasa', true);
        const ol = document.createElement('ol');
        (r.top_biomasa || []).forEach(x => {
            const li = document.createElement('li');
            li.textContent = `${x.nombre} — ${Number(x.biomasa_final).toFixed(1)} g · ${x.plantas_vivas} vivas / ${x.plantas_muertas} muertas (${x.modelo_matematico})`;
            ol.appendChild(li);
        });
        box.appendChild(ol);
        const e = r.eficiencia;
        linea(e ? `🌿 Especie más eficiente: ${e.nombre_comun} — ${Number(e.g_por_dia).toFixed(2)} g/día (${e.simulaciones} simulaciones)` : '🌿 Especie más eficiente: sin datos');
        const m = r.madurez;
        linea(m && m.dias ? `⏱️ Tiempo promedio a madurez: ${Number(m.dias).toFixed(0)} días (${m.n} simulaciones lo alcanzaron)` : '⏱️ Tiempo promedio a madurez: sin datos');
    } catch (e) {
        box.textContent = 'No se pudieron cargar los reportes (¿Apache/MySQL encendidos?).';
    }
}

// =============================================================================
// 5. API REST (fetch → FlightPHP → PDO → MySQL)
// =============================================================================
async function api(ruta, opciones = {}) {
    const r = await fetch(`${API_BASE}${ruta}`, { headers: { 'Content-Type': 'application/json' }, ...opciones });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
}

let toastTimer = null;
function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

function sincronizarSlidersGeneticos() {
    $('slider-r').value = BioEngine.especie.tasa_crecimiento_base;
    $('val-r').textContent = BioEngine.especie.tasa_crecimiento_base.toFixed(2);
    $('slider-k').value = BioEngine.especie.capacidad_carga_base;
    $('val-k').textContent = BioEngine.especie.capacidad_carga_base.toFixed(1);
}

async function cargarEspecie() {
    try {
        const filas = await api('/especies');
        if (filas.length) {
            const e = filas[0];
            BioEngine.especie = {
                tasa_crecimiento_base: Number(e.tasa_crecimiento_base),
                capacidad_carga_base: Number(e.capacidad_carga_base),
                temp_optima: Number(e.temp_optima),
                humedad_optima: Number(e.humedad_optima),
                dias_madurez: Number(e.dias_madurez)
            };
            sincronizarSlidersGeneticos();
            resimularHasta(BioEngine.tick);
        }
    } catch (e) { console.warn('Sin conexión a la API: se usan los valores por defecto de la azucena.', e); }
}

async function guardarSimulacion() {
    const nombre = prompt('Nombre de la simulación:', `Azucena ${BioEngine.modoAB ? 'A/B' : 'cultivo'} - día ${Math.floor(BioEngine.tick)}`);
    if (nombre === null) return;
    const notas = prompt('Notas (opcional):', '') ?? '';

    const id = BioEngine.grupoKPI(), g = BioEngine.grupos[id], env = BioEngine.entorno(id);
    const ps = BioEngine.plantasDe(id);
    const vivas = BioEngine.vivas(id);
    const tel = BioEngine.telemetry;
    const mediciones = tel.filter((t, i) => t.tick % 5 === 0 || i === tel.length - 1).map(t => ({
        tick: t.tick, altura: t.altura, biomasa: id === 'B' ? t.bioB : t.bioA,
        estres_termico: t.estresT, estres_hidrico: t.estresH, icr: t.icr, plantas_vivas: t.plantasVivas
    }));

    const payload = {
        nombre, notas,
        modelo_matematico: BioEngine.modeloSeleccionado,
        temperatura_ambiente: env.temp, humedad_suelo: env.hum,
        duracion_ticks: Math.floor(BioEngine.tick),
        biomasa_final: BioEngine.biomasaTotal(id), altura_final: g.alturaN,
        plantas_vivas: vivas, plantas_muertas: ps.length - vivas,
        tasa_r: BioEngine.especie.tasa_crecimiento_base, capacidad_k: BioEngine.especie.capacidad_carga_base,
        estaciones: BioEngine.estacionesActivas ? 1 : 0, modo_ab: BioEngine.modoAB ? 1 : 0,
        num_macetas: BioEngine.numMacetas, num_ramas: BioEngine.numRamas,
        mediciones, decisiones: BioEngine.decisiones
    };
    try {
        const r = await api('/simulaciones', { method: 'POST', body: JSON.stringify(payload) });
        toast(`✅ Simulación guardada en MySQL (id ${r.id})`);
    } catch (e) {
        toast('❌ No se pudo guardar. Revisa que Apache y MySQL estén encendidos.');
    }
}

// =============================================================================
// 6. BUCLE DE ANIMACIÓN Y HUD
// =============================================================================
const clock = new THREE.Clock();
let frame = 0;
let timelineArrastrando = false;

function renderEventos() {
    const ul = $('event-log');
    if (!ul) return;
    ul.innerHTML = '';
    if (!BioEngine.eventos.length) {
        const li = document.createElement('li'); li.className = 'ev-empty'; li.textContent = 'Sin eventos todavía.'; ul.appendChild(li); return;
    }
    BioEngine.eventos.slice(-14).reverse().forEach(ev => {
        const li = document.createElement('li'); li.className = ev.tipo; li.textContent = ev.texto; ul.appendChild(li);
    });
}

const slidersRango = document.querySelectorAll('input[type="range"]');
function pintarSliders() {
    slidersRango.forEach(el => {
        const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
        el.style.setProperty('--fill', `${pct}%`);
    });
}

function estadoPlanta(p) {
    if (p.muerta) return { clase: 'muerta', texto: `💀 Muerta (día ${Math.floor(p.tickMuerte)})` };
    const aclim = p.recuperaciones > 0 ? ` · 💪 aclimatada ×${p.recuperaciones}` : '';
    if (p.salud > 70) return { clase: 'sana', texto: '🟢 Sana' + aclim };
    if (p.salud > 40) return { clase: 'estresada', texto: '🟡 Estresada' + aclim };
    return { clase: 'marchita', texto: '🟠 Marchita' + aclim };
}

function actualizarDetalles() {
    const idK = BioEngine.grupoKPI(), env = BioEngine.entorno(idK);
    {
        const vivasK = BioEngine.plantasDe(idK).filter(p => !p.muerta);
        $('kpi-ramas').textContent = `${vivasK.reduce((s, p) => s + p.ramasVisibles, 0)} / ${vivasK.length * BioEngine.numRamas}`;
        $('kpi-madurez').textContent = `${clamp(BioEngine.grupos[idK].alturaN / BioEngine.especie.capacidad_carga_base * 100, 0, 100).toFixed(0)} %`;
        $('kpi-cosecha').textContent = BioEngine.prediccionCosecha();
    }
    const ps = BioEngine.plantasDe(idK), vivas = ps.filter(p => !p.muerta);
    const estacion = BioEngine.estacionesActivas ? `${BioEngine.nombreEstacion(BioEngine.tick)} · ` : '';
    $('det-ambiente').textContent = `${estacion}${env.temp.toFixed(1)} °C · ${env.hum.toFixed(0)} %`;
    $('det-vivas').textContent = `${vivas.length} / ${ps.length - vivas.length}`;
    $('det-aclim').textContent = vivas.filter(p => p.recuperaciones > 0).length;

    const cont = $('plant-chips');
    if (cont.children.length !== plantas.length) {
        cont.innerHTML = '';
        plantas.forEach((p, i) => { const d = document.createElement('div'); d.textContent = i + 1; cont.appendChild(d); });
    }
    plantas.forEach((p, i) => {
        const e = estadoPlanta(p), d = cont.children[i];
        d.className = `chip ${e.clase}${(!p.muerta && p.recuperaciones > 0) ? ' aclim' : ''}`;
        d.title = `#${i + 1} (esc. ${p.grupoId}) · ${e.texto} · salud ${p.salud.toFixed(0)} %`;
    });
}

function actualizarHUD() {
    pintarSliders();
    const idK = BioEngine.grupoKPI(), g = BioEngine.grupos[idK];
    const psK = BioEngine.plantasDe(idK);
    const vivasK = psK.filter(p => !p.muerta);

    if (!timelineArrastrando) $('slider-timeline').value = Math.round(BioEngine.tick);
    $('lbl-timeline-tick').textContent = Math.round(BioEngine.tick);
    $('kpi-tick').textContent = Math.floor(BioEngine.tick);
    $('kpi-altura').textContent = `${g.alturaN.toFixed(2)} u`;
    $('kpi-biomasa').textContent = `${BioEngine.biomasaTotal(idK).toFixed(1)} g`;
    $('kpi-icr').textContent = g.icr.toFixed(3);
    $('kpi-estres-t').textContent = `${g.eT.toFixed(0)} %`;
    $('kpi-estres-h').textContent = `${g.eH.toFixed(0)} %`;
    $('kpi-estres-g').textContent = `${g.eG.toFixed(0)} %`;

    if (BioEngine.modoAB) {
        $('kpi-vivas').textContent = `A ${BioEngine.vivas('A')}/${BioEngine.plantasDe('A').length} · B ${BioEngine.vivas('B')}/${BioEngine.plantasDe('B').length}`;
        const nA = BioEngine.plantasDe('A').length, nB = BioEngine.plantasDe('B').length;
        if (nA && nB) {
            const mA = BioEngine.biomasaTotal('A') / nA, mB = BioEngine.biomasaTotal('B') / nB;
            const dif = (mA - mB) / Math.max(mA, mB, 1e-9);
            $('kpi-modo-ab').textContent = Math.abs(dif) < 0.02 ? 'A/B: empate' : `Gana ${dif > 0 ? 'A' : 'B'} (+${(Math.abs(dif) * 100).toFixed(0)} %)`;
        }
    } else {
        $('kpi-vivas').textContent = `${vivasK.length} / ${psK.length}`;
        $('kpi-modo-ab').textContent = 'Estándar';
    }

    const hojas = vivasK.reduce((s, p) => s + p.hojasDesarrolladas, 0);
    const hojasTot = vivasK.reduce((s, p) => s + p.hojas.length, 0);
    $('leaf-count').textContent = hojas;
    $('leaf-total').textContent = hojasTot;
    $('leaf-progress-fill').style.width = `${hojasTot ? (hojas / hojasTot) * 100 : 0}%`;

    const rec = BioEngine.recomendar();
    const recEl = $('kpi-recomendacion');
    recEl.textContent = rec.texto;
    recEl.style.color = rec.color;

    const badge = $('badge-status');
    const muertas = psK.length - vivasK.length;
    if (muertas > 0) { badge.textContent = `Mortalidad: ${muertas}`; badge.style.background = '#ef4444'; }
    else if (g.eG > UMBRAL_DANO) { badge.textContent = 'Bajo estrés'; badge.style.background = '#f59e0b'; }
    else { badge.textContent = 'Saludable'; badge.style.background = '#16a34a'; }
}

function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(clock.getDelta(), 0.1);
    const time = clock.elapsedTime;
    const windInt = parseFloat($('slider-wind').value);

    BioEngine.update(delta);
    plantas.forEach(p => {
        aplicarVisual(p, false);
        p.mats.hoja.uniforms.uTime.value = time;
        p.mats.hoja.uniforms.uWindIntensity.value = windInt;
    });
    actualizarHUD();
    if (frame++ % 6 === 0) { actualizarPanelSeleccion(); actualizarDetalles(); }

    controls.update();
    renderer.render(scene, camera);
}

// =============================================================================
// 7. RAYCASTING: INSPECCIÓN DE ESTRUCTURAS
// =============================================================================
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let seleccion = null;

function esVisible(o) { while (o) { if (!o.visible) return false; o = o.parent; } return true; }

function seleccionar(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(mouse, camera);
    const hits = raycaster.intersectObjects(plantas.map(p => p.root), true).filter(h => h.object.userData.parte && esVisible(h.object));
    seleccion = hits.length ? hits[0].object : null;
    actualizarPanelSeleccion();
}

function actualizarPanelSeleccion() {
    const hint = $('hint-text'), panel = $('plant-data');
    if (!seleccion) { hint.classList.remove('hidden'); panel.classList.add('hidden'); return; }
    const { parte, planta: p } = seleccion.userData;
    const g = BioEngine.grupos[p.grupoId];
    const prog = clamp(p.progreso, 0, 1);

    let nombre, geo, crec, frac;
    if (parte.tipo === 'tallo') {
        nombre = 'Tallo principal'; geo = 'Cilindro r 0.04→0.06 · h 1.8 u'; crec = prog * 100; frac = 0.38;
    } else if (parte.tipo === 'rama') {
        nombre = `Rama ${parte.n + 1}`; geo = 'Cilindro r 0.015→0.025 · h 0.65 u';
        crec = clamp((prog - parte.umbral) / 0.2, 0, 1) * 100; frac = 0.20 / Math.max(1, p.ramasVisibles);
    } else if (parte.tipo === 'hoja') {
        nombre = `Hoja ${parte.n + 1}`; geo = 'Elipsoide aplanado (esfera 0.24 · escala 1.8×0.1×0.5)';
        crec = clamp((prog - parte.umbral) / 0.2, 0, 1) * 100; frac = 0.38 / Math.max(1, p.hojasDesarrolladas);
    } else {
        nombre = 'Pétalo (flor)'; geo = 'Elipsoide alargado (6 pétalos)';
        crec = clamp((g.tickEf - (BioEngine.especie.dias_madurez - 20)) / 20, 0, 1) * 100; frac = 0.04 / 6;
    }
    const bioP = BioEngine.biomasaPlanta(p);
    const totalG = BioEngine.biomasaTotal(p.grupoId);
    const contrib = totalG > 0 ? (frac * bioP / totalG) * 100 : 0;
    const estado = estadoPlanta(p).texto;

    hint.classList.add('hidden'); panel.classList.remove('hidden');
    $('part-planta').textContent = `#${p.idx + 1} · escenario ${p.grupoId}`;
    $('part-estado').textContent = estado;
    $('part-salud').textContent = `${p.salud.toFixed(0)} %`;
    $('part-name').textContent = nombre;
    $('part-geo').textContent = geo;
    $('part-growth').textContent = `${crec.toFixed(0)} %`;
    $('part-estres').textContent = `${p.estresActual.toFixed(0)} % (T ${p.estresT.toFixed(0)} · H ${p.estresH.toFixed(0)})`;
    $('part-biomasa').textContent = p.muerta ? '0 % (planta muerta)' : `${contrib.toFixed(2)} % del cultivo`;
}

let downX = 0, downY = 0;
renderer.domElement.addEventListener('pointerdown', e => { downX = e.clientX; downY = e.clientY; });
renderer.domElement.addEventListener('pointerup', e => { if (Math.hypot(e.clientX - downX, e.clientY - downY) < 5) seleccionar(e); });

// =============================================================================
// 8. EVENTOS DE LA INTERFAZ
// =============================================================================
$('slider-timeline').addEventListener('pointerdown', () => { timelineArrastrando = true; });
window.addEventListener('pointerup', () => { timelineArrastrando = false; });
$('slider-timeline').addEventListener('input', e => resimularHasta(parseFloat(e.target.value)));

$('btn-estaciones').addEventListener('click', e => {
    BioEngine.estacionesActivas = !BioEngine.estacionesActivas;
    e.currentTarget.className = BioEngine.estacionesActivas ? 'btn btn-exp' : 'btn';
    e.currentTarget.style.backgroundColor = BioEngine.estacionesActivas ? '' : '#0284c7';
    if (BioEngine.estacionesActivas) BioEngine.aplicarEstaciones();
    else e.currentTarget.innerHTML = '🌤️ Estaciones: OFF';
    resimularHasta(BioEngine.tick);
});

$('slider-pots').addEventListener('input', e => {
    BioEngine.numMacetas = parseInt(e.target.value, 10);
    $('val-pots').textContent = BioEngine.numMacetas;
    seleccion = null;
    rebuildPlants();
});
$('slider-branches').addEventListener('input', e => {
    BioEngine.numRamas = parseInt(e.target.value, 10);
    $('val-branches').textContent = BioEngine.numRamas;
    seleccion = null;
    rebuildPlants();
});
$('select-modelo').addEventListener('change', e => {
    BioEngine.modeloSeleccionado = e.target.value;
    $('lbl-modelo').textContent = e.target.selectedOptions[0].textContent.split(' ')[0];
    resimularHasta(BioEngine.tick);
});
$('slider-temp').addEventListener('input', e => {
    BioEngine.temperatura = parseFloat(e.target.value);
    $('lbl-temp').textContent = `${BioEngine.temperatura.toFixed(1)} °C`;
});
$('slider-humedad').addEventListener('input', e => {
    BioEngine.humedadSuelo = parseFloat(e.target.value);
    $('lbl-humedad').textContent = `${BioEngine.humedadSuelo.toFixed(1)} %`;
});
$('slider-wind').addEventListener('input', e => { $('val-wind').textContent = parseFloat(e.target.value).toFixed(1); });

$('btn-toggle-sim').addEventListener('click', e => {
    BioEngine.isPaused = !BioEngine.isPaused;
    e.currentTarget.textContent = BioEngine.isPaused ? '▶️ Reanudar' : '⏸️ Pausar';
});
$('btn-reset-growth').addEventListener('click', () => { seleccion = null; resimularHasta(0); });
$('btn-toggle-ab').addEventListener('click', () => {
    BioEngine.modoAB = !BioEngine.modoAB;
    seleccion = null;
    rebuildPlants();
});
$('btn-save-sim').addEventListener('click', guardarSimulacion);
$('btn-open-charts').addEventListener('click', () => {
    $('chart-modal').classList.remove('hidden');
    if (!growthChart) crearGrafica();
    actualizarGrafica();
    cargarReportes();
});
$('close-modal').addEventListener('click', () => $('chart-modal').classList.add('hidden'));
$('btn-reset-cam').addEventListener('click', () => { camera.position.copy(CAM_POS); controls.target.copy(CAM_TARGET); });


// =============================================================================
// 7b. HISTORIAL (cargar y reproducir), EXPORTAR CSV / PDF
// =============================================================================
async function abrirHistorial() {
    $('hist-modal').classList.remove('hidden');
    const tb = $('hist-body');
    tb.innerHTML = '<tr><td colspan="8">Cargando…</td></tr>';
    try {
        const filas = await api('/simulaciones');
        tb.innerHTML = '';
        if (!filas.length) { tb.innerHTML = '<tr><td colspan="8">Aún no hay simulaciones guardadas.</td></tr>'; return; }
        filas.forEach(f => {
            const tr = document.createElement('tr');
            const celdas = [f.id, f.nombre, f.modelo_matematico, `${Number(f.temperatura_ambiente).toFixed(0)} °C / ${Number(f.humedad_suelo).toFixed(0)} %`,
                f.duracion_ticks, `${Number(f.biomasa_final).toFixed(1)} g`, `${f.plantas_vivas} / ${f.plantas_muertas}`];
            celdas.forEach(c => { const td = document.createElement('td'); td.textContent = c; tr.appendChild(td); });
            const td = document.createElement('td');
            const b = document.createElement('button');
            b.className = 'btn btn-exp'; b.textContent = '▶ Cargar';
            b.addEventListener('click', () => cargarSimulacion(f));
            td.appendChild(b); tr.appendChild(td); tb.appendChild(tr);
        });
    } catch (e) {
        tb.innerHTML = '<tr><td colspan="8">No se pudo cargar el historial (¿Apache/MySQL encendidos?).</td></tr>';
    }
}

// Reproduce una simulación guardada: restaura su configuración y la vuelve a calcular hasta su último día
function cargarSimulacion(f) {
    const E = BioEngine.especie;
    BioEngine.modeloSeleccionado = f.modelo_matematico;
    $('select-modelo').value = f.modelo_matematico;
    $('lbl-modelo').textContent = $('select-modelo').selectedOptions[0].textContent.split(' ')[0];
    E.tasa_crecimiento_base = Number(f.tasa_r); E.capacidad_carga_base = Number(f.capacidad_k);
    sincronizarSlidersGeneticos();
    BioEngine.temperatura = Number(f.temperatura_ambiente);
    BioEngine.humedadSuelo = Number(f.humedad_suelo);
    $('slider-temp').value = BioEngine.temperatura; $('lbl-temp').textContent = `${BioEngine.temperatura.toFixed(1)} °C`;
    $('slider-humedad').value = BioEngine.humedadSuelo; $('lbl-humedad').textContent = `${BioEngine.humedadSuelo.toFixed(1)} %`;
    BioEngine.numMacetas = Number(f.num_macetas); $('slider-pots').value = BioEngine.numMacetas; $('val-pots').textContent = BioEngine.numMacetas;
    BioEngine.numRamas = Number(f.num_ramas); $('slider-branches').value = BioEngine.numRamas; $('val-branches').textContent = BioEngine.numRamas;
    BioEngine.modoAB = Number(f.modo_ab) === 1;
    BioEngine.estacionesActivas = Number(f.estaciones) === 1;
    const b = $('btn-estaciones');
    if (BioEngine.estacionesActivas) { b.className = 'btn btn-exp'; b.style.backgroundColor = ''; }
    else { b.className = 'btn'; b.style.backgroundColor = '#0284c7'; b.innerHTML = '🌤️ Estaciones: OFF'; }
    BioEngine.tick = Number(f.duracion_ticks);
    BioEngine.isPaused = true; $('btn-toggle-sim').textContent = '▶️ Reanudar';
    seleccion = null;
    rebuildPlants();
    $('hist-modal').classList.add('hidden');
    toast(`▶ Simulación "${f.nombre}" cargada y reproducida hasta el día ${f.duracion_ticks}`);
}

function descargar(nombre, contenido, tipo) {
    const url = URL.createObjectURL(new Blob([contenido], { type: tipo }));
    const a = document.createElement('a'); a.href = url; a.download = nombre; a.click();
    URL.revokeObjectURL(url);
}

function exportarCSV() {
    const id = BioEngine.grupoKPI();
    const filas = ['dia,altura_u,biomasa_g,estres_termico,estres_hidrico,icr,plantas_vivas'];
    BioEngine.telemetry.forEach(t => filas.push([t.tick, t.altura.toFixed(3), (id === 'B' ? t.bioB : t.bioA).toFixed(2),
        t.estresT.toFixed(1), t.estresH.toFixed(1), t.icr.toFixed(4), t.plantasVivas].join(',')));
    descargar(`reporte_azucena_dia${Math.floor(BioEngine.tick)}.csv`, filas.join('\n'), 'text/csv;charset=utf-8');
    toast('⬇️ CSV exportado');
}

function exportarPDF() {
    const esc = t => String(t).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    if (!growthChart) crearGrafica();
    actualizarGrafica();
    const img = $('growthChart').toDataURL('image/png');
    const id = BioEngine.grupoKPI(), g = BioEngine.grupos[id], ps = BioEngine.plantasDe(id), vivas = BioEngine.vivas(id);
    const filas = BioEngine.telemetry.filter(t => t.tick % 30 === 0 || t === BioEngine.telemetry[BioEngine.telemetry.length - 1])
        .map(t => `<tr><td>${t.tick}</td><td>${t.altura.toFixed(2)}</td><td>${(id === 'B' ? t.bioB : t.bioA).toFixed(1)}</td><td>${t.estresT.toFixed(0)}</td><td>${t.estresH.toFixed(0)}</td><td>${t.plantasVivas}</td></tr>`).join('');
    const decs = BioEngine.decisiones.slice(-10).map(d => `<li>Día ${d.tick}: ${esc(d.alerta)}</li>`).join('');
    const w = window.open('', '_blank');
    if (!w) { toast('Permite las ventanas emergentes para exportar el PDF'); return; }
    w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><title>Reporte Azucena</title>
<style>body{font-family:sans-serif;margin:24px;color:#0f172a}h1{font-size:20px}h2{font-size:15px;margin-top:18px}
table{border-collapse:collapse;width:100%;font-size:12px}td,th{border:1px solid #94a3b8;padding:4px 8px;text-align:center}img{width:100%}</style></head><body>
<h1>Reporte del Laboratorio Bioinformático — Azucena (Lilium candidum)</h1>
<p>Modelo: <b>${esc(BioEngine.modeloSeleccionado)}</b> · r = ${BioEngine.especie.tasa_crecimiento_base.toFixed(2)} · K = ${BioEngine.especie.capacidad_carga_base.toFixed(1)} · Día ${Math.floor(BioEngine.tick)} / 365</p>
<h2>Métricas clave</h2>
<p>Altura: ${g.alturaN.toFixed(2)} u · Biomasa viva: ${BioEngine.biomasaTotal(id).toFixed(1)} g · ICR: ${g.icr.toFixed(3)} · Estrés global: ${g.eG.toFixed(0)} %<br>
Plantas vivas: ${vivas} de ${ps.length} · Predicción de cosecha: ${esc(BioEngine.prediccionCosecha())}</p>
<h2>Curvas de crecimiento</h2><img src="${img}">
<h2>Mediciones (cada 30 días)</h2>
<table><tr><th>Día</th><th>Altura (u)</th><th>Biomasa (g)</th><th>Estrés térmico %</th><th>Estrés hídrico %</th><th>Vivas</th></tr>${filas}</table>
<h2>Últimas decisiones del motor</h2><ul>${decs || '<li>Sin alertas</li>'}</ul></body></html>`);
    w.document.close(); w.focus();
    setTimeout(() => w.print(), 500);
}

$('btn-historial').addEventListener('click', abrirHistorial);
$('close-hist').addEventListener('click', () => $('hist-modal').classList.add('hidden'));
$('btn-export-csv').addEventListener('click', exportarCSV);
$('btn-export-pdf').addEventListener('click', exportarPDF);

$('slider-r').addEventListener('input', e => {
    BioEngine.especie.tasa_crecimiento_base = parseFloat(e.target.value);
    $('val-r').textContent = parseFloat(e.target.value).toFixed(2);
    resimularHasta(BioEngine.tick);
});
$('slider-k').addEventListener('input', e => {
    BioEngine.especie.capacidad_carga_base = parseFloat(e.target.value);
    $('val-k').textContent = parseFloat(e.target.value).toFixed(1);
    resimularHasta(BioEngine.tick);
});

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// =============================================================================
// 9. ARRANQUE
// =============================================================================
BioEngine.numMacetas = parseInt($('slider-pots').value, 10);
BioEngine.numRamas = parseInt($('slider-branches').value, 10);
BioEngine.temperatura = parseFloat($('slider-temp').value);
BioEngine.humedadSuelo = parseFloat($('slider-humedad').value);
crearMiniGrafica();
rebuildPlants();
animate();
cargarEspecie();   // trae los óptimos de la azucena desde MySQL (si la API responde)

// Práctica 06: condiciones reales enviadas desde observatorio.html (?temp=°C)
(() => {
    const t = parseFloat(new URLSearchParams(location.search).get('temp'));
    if (!isNaN(t)) { const s = $('slider-temp'); s.value = t; s.dispatchEvent(new Event('input')); }
})();
