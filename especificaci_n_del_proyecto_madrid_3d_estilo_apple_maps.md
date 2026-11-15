# PROYECTO: Madrid Fixie Messenger — Fase 1: Motor de Mapa 3D Estilizado (Estilo Apple Maps DCE)

## 1. Contexto e Instrucciones para el Agente (Antigravity)
Actúa como un Ingeniero Principal de Gráficos 3D y Desarrollador de Videojuegos Web experto en **Three.js**, **WebGPU (`WebGPURenderer`)**, **TSL (Three Shading Language)** y procesamiento de datos geoespaciales (**Overture Maps / GeoJSON**).

**Objetivo de esta fase:**
Construir el motor de renderizado urbano en 3D de un sector real del centro de Madrid (Eje Paseo del Prado - Neptuno - Museo del Prado - Barrio de las Letras). El mapa NO debe usar fotogrametría pesada; debe replicar con exactitud la estética limpia, geométrica y estilizada de **Apple Maps "Detailed City Experience" (DCE)**  manteniendo un rendimiento en el navegador para un futuro juego de mensajería en bicicleta *fixie* que en este momento no es importante

Lo que queremos en este mometno es una prueba de concepto de lograr visualizar un mapa de una ciudad de manera eficiente y con los detalles de edificios sin ser los modelos llenos de geometria con fotogrametria..

---

## 2. Stack Tecnológico Obligatorio
* **Bundler & Lenguaje:** Vite + TypeScript (Strict Mode).
* **Motor Gráfico:** `three` (usando exclusivamente `WebGPURenderer` de `three/webgpu` y nodos de `three/tsl` para shaders).
* **Procesamiento Geoespacial:** Conversión de coordenadas $\text{WGS84 } (\text{lon}, \text{lat})$ a plano tangente local en metros $(x, z)$ sin librerías GIS pesadas en el cliente.
* **Optimización de Geometría:** Uso estricto de `BufferGeometryUtils.mergeGeometries` para geometría estática (edificios y calles) e `InstancedMesh` para vegetación y mobiliario urbano. El mapa completo debe renderizarse en menos de $15\text{ draw calls}$.

---

## 3. Dirección de Arte y Estética ("Look & Feel" Apple Maps 3D)
El acabado visual se basa en geometría limpia con bordes definidos, sombreado suave y una paleta de colores cohesiva en modo oscuro/azulado:

### 3.1. Paleta de Colores (Hex)
* **Terreno Base / Aceras:** `#262b38` (Gris pizarra oscuro).
* **Calzadas / Asfalto:** `#181c26` (Azul marino muy oscuro, casi negro).
* **Líneas Viales y Pasos de Cebra:** `#4a5568` (Blanco grisáceo tenue, generado proceduralmente o por geometría superpuesta con `polygonOffset`).
* **Edificios Estándar (LoD1/LoD2):** Gradiente sutil por altura o variación por edificio entre `#384357`, `#434f65` y `#4e5b73` (Azules grisáceos mates con ligera diferenciación entre paredes y tejados).
* **Zonas Verdes / Parques (Botánico / Prado):** `#133829` para el césped base y `#1f5c42` / `#287052` para las copas de los árboles.
* **Agua (Fuente de Neptuno):** `#1d4ed8` con ligero brillo especular.

### 3.2. Iluminación y Atmósfera
* `HemisphereLight`: Cielo `#4a6fa5`, Suelo `#181c26`, intensidad $0.8$.
* `DirectionalLight`: Color `#dce8ff`, intensidad $1.4$, posicionada en ángulo oblicuo para proyectar sombras suaves (`castShadow = true`, mapa de sombras $2048 \times 2048$) que separen visualmente los volúmenes de los edificios.
* **Sombreado de Bordes / Oclusión:** Aplicar oscurecimiento basado en la altura del vértice ($y = 0\text{ m}$ más oscuro que el tejado) mediante un nodo TSL en el material de los edificios para simular *Ambient Occlusion* (SSAO) a coste cero en GPU.

---

## 4. Pipeline de Datos (Overture Maps -> GeoJSON -> Three.js)

### 4.1. Extracción de Datos de Madrid (Bounding Box: Paseo del Prado / Las Letras)
Usaremos un recorte real centrado en la Fuente de Neptuno ($\text{Lon: } -3.6941, \text{Lat: } 40.4152$).
El rango del *Bounding Box* es:
$$\text{BBOX} = [-3.7020, 40.4100, -3.6860, 40.4200]$$

Para obtener los datos limpios de **Overture Maps** (o un fallback de OpenStreetMap vía Overpass API si aún no están descargados), crea un script de inicialización o descarga con los siguientes comandos de Overture CLI:

~~~bash
# 1. Descargar huellas y alturas reales de edificios
overturemaps download --bbox=-3.7020,40.4100,-3.6860,40.4200 -f geojson --type=building -o public/data/madrid_buildings.geojson

# 2. Descargar segmentos de calles y carreteras
overturemaps download --bbox=-3.7020,40.4100,-3.6860,40.4200 -f geojson --type=segment -o public/data/madrid_roads.geojson

# 3. Descargar áreas de parques y usos de suelo (opcional/fallback OSM)
overturemaps download --bbox=-3.7020,40.4100,-3.6860,40.4200 -f geojson --type=land_use -o public/data/madrid_landuse.geojson
~~~

*(Nota para el agente: Incluye también un script en Node.js `scripts/fetch-osm-fallback.mjs` que consulte la Overpass API de OpenStreetMap para ese mismo BBOX en caso de que el usuario no tenga Python/`overturemaps` instalado en su entorno local, garantizando que `npm run fetch-map` funcione sin dependencias externas).*

### 4.2. Proyección Matemática a Coordenadas Locales (Metros)
Para evitar problemas de precisión en coma flotante (*jittering*) en WebGPU, convierte cada coordenada $[\text{lon}, \text{lat}]$ a metros $[x, z]$ tomando como origen $(0, 0)$ la Fuente de Neptuno ($\text{lon}_0 = -3.6941, \text{lat}_0 = 40.4152$):

$$x = (\text{lon} - \text{lon}_0) \cdot 111320 \cdot \cos\left(\text{lat}_0 \cdot \frac{\pi}{180}\right)$$
$$z = -(\text{lat} - \text{lat}_0) \cdot 110540$$

*(El signo negativo en $z$ asegura que el Norte apunte hacia $-Z$ en el sistema de coordenadas de mano derecha de Three.js).*

### 4.3. Modelo Digital de Elevación (DEM)
Para reflejar la topografía real de Madrid (la vaguada del Paseo del Prado a ~$641\text{ m}$ frente a las cuestas del Barrio de las Letras a ~$667\text{ m}$ y Los Jerónimos a ~$664\text{ m}$), el script de datos descarga una malla de elevaciones DEM ($10 \times 10$ puntos sobre el BBOX) centrada en la altitud de Neptuno ($641\text{ m} \rightarrow y = 0\text{ m}$). El motor permite alternar entre mapa plano (`0x`), relieve real (`1x`) y cuestas acentuadas (`1.8x`).

---

## 5. Reglas de Generación Procedural de Geometría

### 5.1. Edificios (`madrid_buildings.geojson`)
1. Leer cada `Polygon` o `MultiPolygon`.
2. Determinar la altura $h$ del edificio:
   * Usar `properties.height` si existe.
   * Si no existe, usar `properties.num_floors * 3.5` (o `building:levels * 3.5`).
   * Si ninguno existe, asignar una altura determinista pseudo-aleatoria basada en el hash del ID del edificio entre $14\text{ m}$ y $24\text{ m}$.
3. **Biselado sutil:** Extruir con `THREE.ExtrudeGeometry` usando `bevelEnabled: true`, `bevelThickness: 0.3`, `bevelSize: 0.2`, `bevelSegments: 1` para lograr ese borde suave característico de Apple Maps que atrapa la luz direccional.
4. **Variación tonal:** Escribir un atributo de color por vértice (`color`) con variaciones sutiles del gris azulado base y un oscurecimiento del $25\%$ en los vértices con $y < 2\text{ m}$ (oclusión ambiental de contacto con el suelo).
5. **Fusión:** Fusionar todas las geometrías de edificios estándar en un único `THREE.Mesh` estático.

### 5.2. Calles, Carriles y Marcas Viales (`madrid_roads.geojson`)
1. Convertir cada `LineString` en una cinta geométrica plana (ribbon mesh) en $y = 0.05\text{ m}$ extruida lateralmente según su categoría:
   * `primary` / `trunk` (ej. Paseo del Prado): ancho $22\text{ m}$, con mediana/bulevar o múltiples carriles.
   * `secondary` / `tertiary`: ancho $10\text{ m}$.
   * `residential` / `living_street`: ancho $6\text{ m}$.
   * `footway` / `pedestrian`: ancho $3\text{ m}$, color acera elevada.
2. **Shader de Marcas Viales (TSL):** Utilizar las coordenadas UV de la cinta de carretera (donde $U$ es transversal de $0$ a $1$ y $V$ es la distancia acumulada en metros a lo largo de la calle) para pintar proceduralmente en el shader:
   * Líneas discontinuas blancas/grises divisorias de carril en vías principales y secundarias.
   * Bordillos sutiles en los extremos ($U < 0.04$ o $U > 0.96$).

### 5.3. Árboles y Vegetación (`InstancedMesh`)
1. Generar un modelo de árbol estilizado combinando un tronco cilíndrico bajo y $2$ o $3$ icosaedros subdivididos (`IcosahedronGeometry(1, 2)`) ligeramente achatados con sombreado suave, imitando las copas frondosas de la captura de referencia.
2. Poblar automáticamente con `InstancedMesh`:
   * El bulevar central y laterales del Paseo del Prado (alineados paralelamente a los segmentos viales principales cada $12\text{ m}$).
   * El interior de los polígonos marcados como `park`, `garden` o `grass` (Real Jardín Botánico, Parque del Prado) mediante muestreo de puntos en polígono (*Poisson-disc* o *grid jittered*), aplicando variaciones de escala entre $0.7\times$ y $1.3\times$ y variaciones sutiles de verde por instancia (`setColorAt`).

---

## 6. Plan de Ejecución Paso a Paso (Checklist de Desarrollo)

Ejecuta la implementación en este orden exacto, verificando que cada paso compile sin errores antes de pasar al siguiente:

- [ ] **Paso 1: Scaffolding y Descarga de Datos Reales.** Inicializar proyecto Vite + TypeScript + `three`. Crear `scripts/fetch-madrid-data.mjs` que descargue los polígonos reales del entorno del Paseo del Prado (edificios, calles, parques y árboles) y los guarde en `public/data/madrid_prado.json`.
- [ ] **Paso 2: Motor Base WebGPU y Cámara.** Configurar `WebGPURenderer`, escena con niebla atmosférica lejana (`#141821`), iluminación direccional con sombras suaves y controles de cámara duales: vista isométrica/orbital estilo Apple Maps (`MapControls`) y vista a ras de suelo para previsualizar la perspectiva del jugador en *fixie*.
- [ ] **Paso 3: Constructor de Geometría Urbana (`CityBuilder.ts`).** Implementar la proyección $(\text{lon}, \text{lat}) \rightarrow (x, z)$, extrusión de edificios con bisel y gradiente de oclusión en base, cintas de carreteras con marcas viales procedurales y polígonos de parques.
- [ ] **Paso 4: Vegetación Instanciada y Relieve Topográfico (DEM).** Añadir el generador de árboles con `InstancedMesh` (troncos y copas orgánicas) y la malla de elevación topográfica real (DEM) con selector en vivo entre mapa plano y cuestas reales.
- [ ] **Paso 5: UI de Control y Etiquetas Flotantes (POIs).** Añadir una capa ligera en HTML/CSS (o sprites 2D) con píldoras de iconos estilo Apple Maps para lugares clave (*Museo del Prado*, *Fuente de Neptuno*, *Real Jardín Botánico*, *Calle de Lope de Vega*) que se pueda activar/desactivar, más un selector de cámara ("Vista Mapa 3D" vs "Vista Bici a Ras de Suelo") y telemetría de FPS/Draw Calls.