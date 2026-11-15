import * as THREE from 'three/webgpu';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { projectToMeters, TerrainElevation } from './geo/projection';
import { PALETTE } from './materials/CityMaterials';
import type { ChunkManifest, PoiDefinition } from './types/mapData';
import { ChunkManager } from './world/ChunkManager';
import { buildBaseGroundMesh, createSharedCityResources } from './world/CityBuilder';

const POIS: PoiDefinition[] = [
  { id: 'neptuno', label: 'Fuente de Neptuno', lon: -3.6941, lat: 40.4152, heightOffsetM: 10, category: 'landmark' },
  { id: 'prado', label: 'Museo del Prado', lon: -3.6921, lat: 40.4138, heightOffsetM: 26, category: 'landmark' },
  { id: 'botanico', label: 'Real Jardín Botánico', lon: -3.6911, lat: 40.4113, heightOffsetM: 12, category: 'park' },
  { id: 'letras', label: 'Barrio de las Letras', lon: -3.6977, lat: 40.4141, heightOffsetM: 26, category: 'neighborhood' },
  { id: 'congreso', label: 'Congreso de los Diputados', lon: -3.6967, lat: 40.4167, heightOffsetM: 24, category: 'landmark' },
  { id: 'thyssen', label: 'Museo Thyssen-Bornemisza', lon: -3.6949, lat: 40.4160, heightOffsetM: 24, category: 'landmark' },
  { id: 'cibeles', label: 'Plaza de Cibeles', lon: -3.6930, lat: 40.4193, heightOffsetM: 18, category: 'landmark' },
  { id: 'alcala', label: 'Puerta de Alcalá', lon: -3.6887, lat: 40.4200, heightOffsetM: 24, category: 'landmark' },
  { id: 'retiro', label: 'Estanque del Retiro', lon: -3.6836, lat: 40.4173, heightOffsetM: 14, category: 'park' },
  { id: 'atocha', label: 'Estación de Atocha', lon: -3.6907, lat: 40.4068, heightOffsetM: 26, category: 'landmark' },
  { id: 'sol', label: 'Puerta del Sol', lon: -3.7038, lat: 40.4169, heightOffsetM: 24, category: 'neighborhood' },
  { id: 'palacio', label: 'Palacio Real', lon: -3.7143, lat: 40.4179, heightOffsetM: 34, category: 'landmark' },
];

type CameraMode = 'map' | 'aerial' | 'bike';

interface PoiElementEntry {
  def: PoiDefinition;
  x: number;
  y: number;
  z: number;
  el: HTMLButtonElement;
}

async function initApp(): Promise<void> {
  const container = document.getElementById('canvas-container') as HTMLDivElement;
  const poiLayer = document.getElementById('poi-layer') as HTMLDivElement;
  const loadingOverlay = document.getElementById('loading-overlay') as HTMLDivElement;
  const loadingStatus = document.getElementById('loading-status') as HTMLParagraphElement;
  const mapSubtitle = document.getElementById('map-subtitle') as HTMLParagraphElement;

  const statBackend = document.getElementById('stat-backend') as HTMLSpanElement;
  const statChunks = document.getElementById('stat-chunks') as HTMLSpanElement;
  const statCalls = document.getElementById('stat-calls') as HTMLSpanElement;
  const statFps = document.getElementById('stat-fps') as HTMLSpanElement;
  const statBuildings = document.getElementById('stat-buildings') as HTMLSpanElement;
  const statTrees = document.getElementById('stat-trees') as HTMLSpanElement;
  const statElev = document.getElementById('stat-elev') as HTMLSpanElement;

  const flightHud = document.getElementById('flight-hud') as HTMLDivElement;
  const flightModeLabel = document.getElementById('flight-mode-label') as HTMLElement;
  const flightAltEl = document.getElementById('flight-alt') as HTMLElement;
  const flightSpeedEl = document.getElementById('flight-speed') as HTMLElement;
  const flightHint = document.getElementById('flight-hint') as HTMLParagraphElement;

  const btnCamMap = document.getElementById('btn-cam-map') as HTMLButtonElement;
  const btnCamAerial = document.getElementById('btn-cam-aerial') as HTMLButtonElement;
  const btnCamBike = document.getElementById('btn-cam-bike') as HTMLButtonElement;
  const btnPois = document.getElementById('btn-pois') as HTMLButtonElement;

  // 1. Cargar manifiesto de chunks espaciales + DEM real
  loadingStatus.textContent = 'Cargando índice espacial y topografía real de Madrid (9,35 km²)...';
  const manifestRes = await fetch('/data/chunks/manifest.json');
  if (!manifestRes.ok) {
    throw new Error(`No se pudo cargar /data/chunks/manifest.json (HTTP ${manifestRes.status})`);
  }
  const manifest = (await manifestRes.json()) as ChunkManifest;
  const terrain = new TerrainElevation(manifest.dem, 1.0);
  mapSubtitle.textContent =
    `${manifest.totals.chunks} bloques (${manifest.meta.chunkSizeM}×${manifest.meta.chunkSizeM} m) · ` +
    `${manifest.totals.buildings.toLocaleString('es-ES')} edificios · ` +
    `cota ${Math.round(terrain.minElevationM)}–${Math.round(terrain.maxElevationM)} m s.n.m.`;

  // 2. Configurar Renderer WebGPU (pixelRatio limitado a 1.5 para fluidez en pantallas Retina)
  loadingStatus.textContent = 'Inicializando motor WebGPU...';
  const renderer = new THREE.WebGPURenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  container.appendChild(renderer.domElement);

  await renderer.init();
  const isWebGPU = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true;
  statBackend.textContent = isWebGPU ? 'WebGPU' : 'WebGL2 (Fallback)';

  // 3. Escena, cielo e iluminación natural de Madrid
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.00038);

  const hemiLight = new THREE.HemisphereLight(0xb8dcff, 0xcabca8, 1.05);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xfff4e0, 2.0);
  dirLight.position.set(280, 440, 220);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(1536, 1536);
  dirLight.shadow.camera.near = 60;
  dirLight.shadow.camera.far = 1400;
  const d = 550;
  dirLight.shadow.camera.left = -d;
  dirLight.shadow.camera.right = d;
  dirLight.shadow.camera.top = d;
  dirLight.shadow.camera.bottom = -d;
  dirLight.shadow.bias = -0.0012;
  dirLight.shadow.normalBias = 0.4;
  scene.add(dirLight);
  scene.add(dirLight.target);

  // 4. Recursos compartidos + terreno real + gestor de Spatial Chunk Streaming
  const resources = createSharedCityResources();
  scene.add(buildBaseGroundMesh(resources, terrain));

  const chunkManager = new ChunkManager(manifest, scene, resources, terrain);
  loadingStatus.textContent = 'Cargando entorno inicial alrededor de Neptuno...';
  await chunkManager.preloadAround(0, 0, 740);

  // 5. Cámaras y controles (Mapa 3D / Aérea Dron / Fixie Calle)
  const camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.5,
    3600
  );
  const startGroundY = terrain.getHeightAtXZ(0, 0);
  camera.position.set(-220, startGroundY + 220, 280);

  const mapControls = new MapControls(camera, renderer.domElement);
  mapControls.enableDamping = true;
  mapControls.dampingFactor = 0.08;
  mapControls.maxPolarAngle = Math.PI * 0.47;
  mapControls.minDistance = 40;
  mapControls.maxDistance = 2200;
  mapControls.target.set(0, startGroundY, 0);
  mapControls.update();

  let cameraMode: CameraMode = 'map';
  let poisVisible = true;

  const freeState = {
    x: -11,
    y: 120,
    z: 75,
    yaw: 0,
    pitch: -0.35,
    velX: 0,
    velY: 0,
    velZ: 0,
    aerialSpeed: 100,
    isDragging: false,
    lastMouseX: 0,
    lastMouseY: 0,
  };

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (
      e.code === 'Space' ||
      e.code === 'ArrowUp' ||
      e.code === 'ArrowDown' ||
      e.code === 'ArrowLeft' ||
      e.code === 'ArrowRight'
    ) {
      e.preventDefault();
    }
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());

  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (cameraMode === 'map') return;
    freeState.isDragging = true;
    freeState.lastMouseX = e.clientX;
    freeState.lastMouseY = e.clientY;
  });

  window.addEventListener('pointermove', (e) => {
    if (cameraMode === 'map' || !freeState.isDragging) return;
    const dx = e.clientX - freeState.lastMouseX;
    const dy = e.clientY - freeState.lastMouseY;
    freeState.lastMouseX = e.clientX;
    freeState.lastMouseY = e.clientY;
    freeState.yaw -= dx * 0.0042;
    const maxPitch = cameraMode === 'aerial' ? 1.35 : 0.48;
    const minPitch = cameraMode === 'aerial' ? -1.45 : -0.45;
    freeState.pitch = Math.max(minPitch, Math.min(maxPitch, freeState.pitch - dy * 0.0035));
  });

  window.addEventListener('pointerup', () => {
    freeState.isDragging = false;
  });

  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      if (cameraMode !== 'aerial') return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.12 : 0.89;
      freeState.aerialSpeed = Math.max(25, Math.min(320, freeState.aerialSpeed * factor));
    },
    { passive: false }
  );

  // 6. POIs interactivos
  const poiEntries: PoiElementEntry[] = POIS.map((def) => {
    const [x, z] = projectToMeters(def.lon, def.lat);
    const groundY = terrain.getHeightAtXZ(x, z);
    const y = groundY + def.heightOffsetM;

    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'poi-pill';

    const dot = document.createElement('span');
    dot.className = `poi-dot ${def.category}`;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = def.label;

    el.append(dot, nameSpan);
    el.addEventListener('click', () => {
      if (cameraMode === 'bike') {
        freeState.x = x;
        freeState.z = z + 35;
        freeState.y = terrain.getHeightAtXZ(freeState.x, freeState.z) + 1.85;
        freeState.yaw = 0;
        return;
      }
      if (cameraMode === 'aerial') {
        const destGroundY = terrain.getHeightAtXZ(x, z + 160);
        freeState.x = x;
        freeState.y = Math.max(freeState.y, destGroundY + 130);
        freeState.z = z + 160;
        freeState.yaw = 0;
        freeState.pitch = -0.45;
        return;
      }
      mapControls.target.set(x, groundY, z);
      camera.position.set(x - 160, groundY + 175, z + 210);
      mapControls.update();
    });

    poiLayer.appendChild(el);
    return { def, x, y, z, el };
  });

  function setCameraMode(mode: CameraMode): void {
    const prevMode = cameraMode;
    cameraMode = mode;

    btnCamMap.classList.toggle('active', mode === 'map');
    btnCamAerial.classList.toggle('active', mode === 'aerial');
    btnCamBike.classList.toggle('active', mode === 'bike');

    mapControls.enabled = mode === 'map';
    flightHud.hidden = mode === 'map';

    if (mode === 'aerial') {
      camera.fov = 58;
      camera.updateProjectionMatrix();
      if (prevMode === 'map') {
        freeState.x = camera.position.x;
        freeState.z = camera.position.z;
        const minY = terrain.getHeightAtXZ(freeState.x, freeState.z) + 25;
        freeState.y = Math.max(minY, Math.min(900, camera.position.y));
        const lookDir = new THREE.Vector3();
        camera.getWorldDirection(lookDir);
        freeState.yaw = Math.atan2(-lookDir.x, -lookDir.z);
        freeState.pitch = Math.asin(Math.max(-0.98, Math.min(0.98, lookDir.y)));
      } else {
        freeState.y = terrain.getHeightAtXZ(freeState.x, freeState.z) + 85;
        freeState.pitch = -0.32;
      }
      freeState.velX = 0;
      freeState.velY = 0;
      freeState.velZ = 0;
      flightModeLabel.textContent = 'Aérea (Dron)';
      flightHint.innerHTML =
        '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> mover · <kbd>Q</kbd><kbd>E</kbd> rotar · <kbd>Espacio</kbd> subir · <kbd>Ctrl</kbd> bajar · <kbd>Shift</kbd> turbo';
    } else if (mode === 'bike') {
      camera.fov = 60;
      camera.updateProjectionMatrix();
      if (prevMode === 'map') {
        freeState.x = mapControls.target.x;
        freeState.z = mapControls.target.z + 40;
      }
      freeState.y = terrain.getHeightAtXZ(freeState.x, freeState.z) + 1.85;
      freeState.pitch = -0.02;
      freeState.velX = 0;
      freeState.velY = 0;
      freeState.velZ = 0;
      flightModeLabel.textContent = 'Fixie (Calle)';
      flightHint.innerHTML =
        'Usa <kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> o <kbd>Q</kbd>/<kbd>E</kbd> para pedalear y girar · Arrastra para mirar · <kbd>Shift</kbd> sprint';
    } else {
      camera.fov = 48;
      camera.updateProjectionMatrix();
      const targetX = prevMode !== 'map' ? freeState.x : mapControls.target.x;
      const targetZ = prevMode !== 'map' ? freeState.z : mapControls.target.z;
      const targetY = terrain.getHeightAtXZ(targetX, targetZ);
      mapControls.target.set(targetX, targetY, targetZ);
      camera.position.set(targetX - 180, targetY + 210, targetZ + 240);
      mapControls.update();
    }
  }

  btnCamMap.addEventListener('click', () => setCameraMode('map'));
  btnCamAerial.addEventListener('click', () => setCameraMode('aerial'));
  btnCamBike.addEventListener('click', () => setCameraMode('bike'));

  btnPois.addEventListener('click', () => {
    poisVisible = !poisVisible;
    btnPois.classList.toggle('active', poisVisible);
    btnPois.setAttribute('aria-pressed', String(poisVisible));
    poiLayer.style.display = poisVisible ? 'block' : 'none';
  });

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // 7. Bucle principal
  const projVec = new THREE.Vector3();
  const lookTarget = new THREE.Vector3();
  const tmpDir = new THREE.Vector3();
  let lastShadowX = Infinity;
  let lastShadowZ = Infinity;
  let lastTime = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;

  await renderer.renderAsync(scene, camera);
  loadingOverlay.classList.add('hidden');

  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - lastTime) / 1000);
    lastTime = now;

    let focusX = 0;
    let focusZ = 0;

    if (cameraMode === 'map') {
      // Soporte de teclado también en Mapa 3D: Q/E rotar, Espacio/Ctrl subir/bajar, WASD desplazar
      const rotInput = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
      if (rotInput !== 0) {
        const angle = rotInput * 1.45 * dt;
        const ox = camera.position.x - mapControls.target.x;
        const oz = camera.position.z - mapControls.target.z;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        camera.position.x = mapControls.target.x + ox * cosA - oz * sinA;
        camera.position.z = mapControls.target.z + ox * sinA + oz * cosA;
      }

      const elevInput =
        (keys.has('Space') ? 1 : 0) -
        (keys.has('ControlLeft') || keys.has('ControlRight') ? 1 : 0);
      if (elevInput !== 0) {
        const camGroundY = terrain.getHeightAtXZ(camera.position.x, camera.position.z);
        camera.position.y = Math.max(camGroundY + 18, Math.min(1800, camera.position.y + elevInput * 180 * dt));
      }

      const panF =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      const panR =
        (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      if (panF !== 0 || panR !== 0) {
        camera.getWorldDirection(tmpDir);
        const flatLen = Math.hypot(tmpDir.x, tmpDir.z) || 1;
        const fx = tmpDir.x / flatLen;
        const fz = tmpDir.z / flatLen;
        const rx = -fz;
        const rz = fx;
        const heightAboveTarget = Math.max(40, camera.position.y - mapControls.target.y);
        const speed = Math.max(90, heightAboveTarget * 0.9) * (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.0 : 1.0);
        const mx = (fx * panF + rx * panR) * speed * dt;
        const mz = (fz * panF + rz * panR) * speed * dt;
        mapControls.target.x += mx;
        mapControls.target.z += mz;
        camera.position.x += mx;
        camera.position.z += mz;
      }

      mapControls.update();

      const targetTerrainY = terrain.getHeightAtXZ(mapControls.target.x, mapControls.target.z);
      const dy = (targetTerrainY - mapControls.target.y) * Math.min(1, dt * 8);
      mapControls.target.y += dy;
      camera.position.y += dy;
      const camGroundY = terrain.getHeightAtXZ(camera.position.x, camera.position.z);
      if (camera.position.y < camGroundY + 18) {
        camera.position.y = camGroundY + 18;
      }

      focusX = mapControls.target.x;
      focusZ = mapControls.target.z;
    } else if (cameraMode === 'aerial') {
      const turbo = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 2.2 : 1.0;
      const rotInput = (keys.has('KeyQ') ? 1 : 0) - (keys.has('KeyE') ? 1 : 0);
      freeState.yaw += rotInput * 1.85 * dt;

      const moveF =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      const strafe =
        (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) -
        (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      const climb =
        (keys.has('Space') ? 1 : 0) -
        (keys.has('ControlLeft') || keys.has('ControlRight') ? 1 : 0);

      // Movimiento horizontal en el plano del rumbo + ascenso/descenso vertical limpio
      const flatFwdX = -Math.sin(freeState.yaw);
      const flatFwdZ = -Math.cos(freeState.yaw);
      const rightX = Math.cos(freeState.yaw);
      const rightZ = -Math.sin(freeState.yaw);

      const speed = freeState.aerialSpeed * turbo;
      const targetVX = (flatFwdX * moveF + rightX * strafe) * speed;
      const targetVY = climb * speed * 0.85;
      const targetVZ = (flatFwdZ * moveF + rightZ * strafe) * speed;

      const damp = Math.min(1, dt * 9);
      freeState.velX += (targetVX - freeState.velX) * damp;
      freeState.velY += (targetVY - freeState.velY) * damp;
      freeState.velZ += (targetVZ - freeState.velZ) * damp;

      freeState.x = Math.max(-2000, Math.min(2000, freeState.x + freeState.velX * dt));
      freeState.z = Math.max(-1700, Math.min(1700, freeState.z + freeState.velZ * dt));
      const aerialGroundY = terrain.getHeightAtXZ(freeState.x, freeState.z);
      const minAerialY = aerialGroundY + 5;
      freeState.y = Math.max(minAerialY, Math.min(1400, freeState.y + freeState.velY * dt));

      const cosPitch = Math.cos(freeState.pitch);
      const lookX = -Math.sin(freeState.yaw) * cosPitch;
      const lookY = Math.sin(freeState.pitch);
      const lookZ = -Math.cos(freeState.yaw) * cosPitch;

      camera.position.set(freeState.x, freeState.y, freeState.z);
      lookTarget.set(freeState.x + lookX * 40, freeState.y + lookY * 40, freeState.z + lookZ * 40);
      camera.lookAt(lookTarget);

      focusX = freeState.x + flatFwdX * 160;
      focusZ = freeState.z + flatFwdZ * 160;

      const totalSpeed = Math.hypot(freeState.velX, freeState.velY, freeState.velZ);
      const agl = Math.max(0, freeState.y - aerialGroundY);
      const absElev = terrain.getAbsoluteElevationAtXZ(freeState.x, freeState.z) + agl;
      flightAltEl.textContent = `${agl.toFixed(0)} m AGL · ${absElev.toFixed(0)} m s.n.m.`;
      flightSpeedEl.textContent = `${(totalSpeed * 3.6).toFixed(0)} km/h`;
    } else {
      const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 1.85 : 1.0;
      const forwardInput =
        (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) -
        (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
      const turnInput =
        (keys.has('KeyA') || keys.has('ArrowLeft') || keys.has('KeyQ') ? 1 : 0) -
        (keys.has('KeyD') || keys.has('ArrowRight') || keys.has('KeyE') ? 1 : 0);

      freeState.yaw += turnInput * 1.9 * dt;
      const dirX = -Math.sin(freeState.yaw);
      const dirZ = -Math.cos(freeState.yaw);
      const gradePct = terrain.getSlopeGradeAtXZ(freeState.x, freeState.z, dirX, dirZ);

      const baseTarget = forwardInput * 17.0 * sprint;
      const targetSpeed =
        forwardInput !== 0
          ? Math.max(4, Math.abs(baseTarget) - gradePct * 0.25) * Math.sign(baseTarget)
          : 0;
      freeState.velX += (targetSpeed - freeState.velX) * Math.min(1, dt * 6.5);

      freeState.x = Math.max(-1800, Math.min(1800, freeState.x + dirX * freeState.velX * dt));
      freeState.z = Math.max(-1500, Math.min(1500, freeState.z + dirZ * freeState.velX * dt));

      const groundY = terrain.getHeightAtXZ(freeState.x, freeState.z);
      const bikeY = groundY + 1.85;
      freeState.y = bikeY;

      const aheadY = terrain.getHeightAtXZ(freeState.x + dirX * 25, freeState.z + dirZ * 25) + 1.85;
      camera.position.set(freeState.x, bikeY, freeState.z);
      lookTarget.set(
        freeState.x + dirX * 25,
        aheadY + Math.sin(freeState.pitch) * 25,
        freeState.z + dirZ * 25
      );
      camera.lookAt(lookTarget);

      focusX = freeState.x;
      focusZ = freeState.z;

      const absGround = terrain.getAbsoluteElevationAtXZ(freeState.x, freeState.z);
      const gradeSign = gradePct >= 0.05 ? '+' : '';
      flightAltEl.textContent = `${Math.round(absGround)} m · ${gradeSign}${gradePct.toFixed(1)}%`;
      flightSpeedEl.textContent = `${Math.abs(freeState.velX * 3.6).toFixed(0)} km/h`;
    }

    // Reubicar luz direccional solo cada 60 m para no invalidar el mapa de sombras continuamente
    if ((focusX - lastShadowX) ** 2 + (focusZ - lastShadowZ) ** 2 > 3600) {
      lastShadowX = Math.round(focusX / 60) * 60;
      lastShadowZ = Math.round(focusZ / 60) * 60;
      const shadowY = terrain.getHeightAtXZ(lastShadowX, lastShadowZ);
      dirLight.position.set(lastShadowX + 280, shadowY + 440, lastShadowZ + 220);
      dirLight.target.position.set(lastShadowX, shadowY, lastShadowZ);
      dirLight.target.updateMatrixWorld();
    }

    chunkManager.update(focusX, focusZ);
    renderer.render(scene, camera);

    // Proyectar POIs a pantalla
    if (poisVisible) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      for (const poi of poiEntries) {
        projVec.set(poi.x, poi.y, poi.z).project(camera);
        if (projVec.z > 1 || projVec.z < -1) {
          poi.el.style.display = 'none';
          continue;
        }
        const sx = (projVec.x * 0.5 + 0.5) * w;
        const sy = (-projVec.y * 0.5 + 0.5) * h;
        if (sx < -80 || sx > w + 80 || sy < 40 || sy > h + 40) {
          poi.el.style.display = 'none';
          continue;
        }
        poi.el.style.display = 'flex';
        poi.el.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -100%)`;
      }
    }

    // Telemetría
    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.25) {
      const fps = Math.round(fpsFrames / fpsAccum);
      const stats = chunkManager.getStats();
      const elevX = cameraMode === 'map' ? mapControls.target.x : freeState.x;
      const elevZ = cameraMode === 'map' ? mapControls.target.z : freeState.z;
      const absElev = terrain.getAbsoluteElevationAtXZ(elevX, elevZ);
      const relElev = absElev - terrain.originElevationM;
      statFps.textContent = String(fps);
      statChunks.textContent = `${stats.activeChunks}/${stats.totalChunks}`;
      statCalls.textContent = String(renderer.info.render.drawCalls);
      statBuildings.textContent = stats.loadedBuildings.toLocaleString('es-ES');
      statTrees.textContent = stats.loadedTrees.toLocaleString('es-ES');
      statElev.textContent = `${Math.round(absElev)} m (${relElev >= 0 ? '+' : ''}${Math.round(relElev)} m)`;
      fpsAccum = 0;
      fpsFrames = 0;
    }
  });
}

initApp().catch((err) => {
  console.error(err);
  const statusEl = document.getElementById('loading-status');
  if (statusEl) {
    statusEl.textContent = `Error al iniciar el visor 3D: ${err instanceof Error ? err.message : String(err)}`;
  }
});
