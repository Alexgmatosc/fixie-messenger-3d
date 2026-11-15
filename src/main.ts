import * as THREE from 'three/webgpu';
import { MapControls } from 'three/examples/jsm/controls/MapControls.js';
import { projectToMeters, TerrainElevation } from './geo/projection';
import { PALETTE } from './materials/CityMaterials';
import type { ChunkManifest, PoiDefinition } from './types/mapData';
import { ChunkManager } from './world/ChunkManager';
import { buildBaseGroundMesh, createSharedCityResources } from './world/CityBuilder';
import { FixieAvatar, RIDER_PRESETS, SkidTrailSystem } from './world/FixieAvatar';

const POIS: PoiDefinition[] = [
  { id: 'neptuno', label: 'Fuente de Neptuno', lon: -3.6941, lat: 40.4152, heightOffsetM: 10, category: 'landmark' },
  { id: 'prado', label: 'Museo del Prado', lon: -3.6921, lat: 40.4138, heightOffsetM: 26, category: 'landmark' },
  { id: 'cibeles', label: 'Plaza de Cibeles', lon: -3.6930, lat: 40.4193, heightOffsetM: 18, category: 'landmark' },
  { id: 'alcala', label: 'Puerta de Alcalá', lon: -3.6887, lat: 40.4200, heightOffsetM: 24, category: 'landmark' },
  { id: 'retiro', label: 'Estanque del Retiro', lon: -3.6836, lat: 40.4173, heightOffsetM: 14, category: 'park' },
  { id: 'atocha', label: 'Estación de Atocha', lon: -3.6907, lat: 40.4068, heightOffsetM: 26, category: 'landmark' },
  { id: 'sol', label: 'Puerta del Sol', lon: -3.7038, lat: 40.4169, heightOffsetM: 24, category: 'neighborhood' },
  { id: 'palacio', label: 'Palacio Real', lon: -3.7143, lat: 40.4179, heightOffsetM: 34, category: 'landmark' },
  { id: 'debod', label: 'Templo de Debod / Pza. España', lon: -3.7177, lat: 40.4241, heightOffsetM: 24, category: 'park' },
  { id: 'azca', label: 'AZCA / Bernabéu', lon: -3.6915, lat: 40.4508, heightOffsetM: 48, category: 'landmark' },
  { id: 'castilla', label: 'Plaza de Castilla', lon: -3.6893, lat: 40.4668, heightOffsetM: 42, category: 'landmark' },
  { id: 'ventas', label: 'Plaza de Las Ventas', lon: -3.6633, lat: 40.4321, heightOffsetM: 28, category: 'landmark' },
  { id: 'matadero', label: 'Matadero / Madrid Río', lon: -3.6977, lat: 40.3917, heightOffsetM: 20, category: 'park' },
  { id: 'cuatrocaminos', label: 'Cuatro Caminos / Chamberí', lon: -3.7037, lat: 40.4468, heightOffsetM: 26, category: 'neighborhood' },
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
  const btnRider = document.getElementById('btn-rider') as HTMLButtonElement;
  const btnPois = document.getElementById('btn-pois') as HTMLButtonElement;

  // 1. Cargar manifiesto de chunks espaciales + DEM real
  loadingStatus.textContent = 'Cargando índice espacial y topografía real de Madrid (M-30)...';
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

  // 3. Escena, cielo e iluminación natural estilo Apple Maps DCE
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(PALETTE.sky);
  scene.fog = new THREE.FogExp2(PALETTE.fog, 0.00028);

  const hemiLight = new THREE.HemisphereLight(0xcce6ff, 0xd8d2c7, 1.25);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xfff7e8, 2.15);
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

  const [rawMinX, rawMaxZ] = projectToMeters(terrain.bbox[0], terrain.bbox[1]);
  const [rawMaxX, rawMinZ] = projectToMeters(terrain.bbox[2], terrain.bbox[3]);
  const worldBounds = {
    minX: rawMinX - 250,
    maxX: rawMaxX + 250,
    minZ: rawMinZ - 250,
    maxZ: rawMaxZ + 250,
  };

  // 4. Recursos compartidos + terreno real + gestor de Spatial Chunk Streaming + Avatar Fixie
  const resources = createSharedCityResources();
  scene.add(buildBaseGroundMesh(resources, terrain));

  const fixieAvatar = new FixieAvatar();
  fixieAvatar.root.visible = false;
  scene.add(fixieAvatar.root);

  const skidTrail = new SkidTrailSystem();
  skidTrail.mesh.visible = false;
  scene.add(skidTrail.mesh);

  const chunkManager = new ChunkManager(manifest, scene, resources, terrain);
  loadingStatus.textContent = 'Cargando entorno inicial alrededor de Neptuno...';
  await chunkManager.preloadAround(0, 0, 740);

  // 5. Cámaras y controles (Mapa 3D / Aérea Dron / Fixie Calle)
  const camera = new THREE.PerspectiveCamera(
    48,
    window.innerWidth / window.innerHeight,
    0.5,
    5200
  );
  const startGroundY = terrain.getHeightAtXZ(0, 0);
  camera.position.set(-220, startGroundY + 220, 280);

  const mapControls = new MapControls(camera, renderer.domElement);
  mapControls.enableDamping = true;
  mapControls.dampingFactor = 0.08;
  mapControls.maxPolarAngle = Math.PI * 0.47;
  mapControls.minDistance = 40;
  mapControls.maxDistance = 3800;
  mapControls.target.set(0, startGroundY, 0);
  mapControls.update();

  let cameraMode: CameraMode = 'map';
  let poisVisible = false;
  poiLayer.style.display = 'none';

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

  const bikeState = {
    speedMs: 0,
    velX: 0,
    velZ: 0,
    steerAngle: 0,
    leanAngle: 0,
    crankAngle: 0,
    slopePitch: 0,
    whipAngle: 0,
    whipVel: 0,
    standBlend: 0,
    hopLiftM: 0,
    hopVel: 0,
    wasSkidding: false,
    lastSkidTurn: 0,
    trackStandPhase: 0,
    lookYaw: 0,
    turnRateVel: 0,
    weightBias: 0.12,
    skidJitterPhase: 0,
    camPreset: '34' as '34' | 'rear' | 'fpv',
    camHeroYaw: 0.42,
    chaseView: true,
    chaseDist: 3.75,
    camOrbitYaw: 0,
    camPitch: 0.13,
    camPos: new THREE.Vector3(-9.5, startGroundY + 2.0, 79),
    camLook: new THREE.Vector3(-11, startGroundY + 1.0, 65),
  };

  let riderIndex = 0;
  const cycleRiderPreset = (): void => {
    riderIndex = (riderIndex + 1) % RIDER_PRESETS.length;
    const preset = RIDER_PRESETS[riderIndex];
    fixieAvatar.setPreset(preset.id);
    btnRider.textContent = `Rider: ${preset.label}`;
    btnRider.title = `${preset.tagline} (pulsa R para cambiar)`;
  };
  btnRider.addEventListener('click', cycleRiderPreset);

  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    keys.add(e.code);
    if (e.code === 'KeyC' && !e.repeat && cameraMode === 'bike') {
      bikeState.camPreset =
        bikeState.camPreset === '34' ? 'rear' : bikeState.camPreset === 'rear' ? 'fpv' : '34';
      bikeState.chaseView = bikeState.camPreset !== 'fpv';
      bikeState.camOrbitYaw = 0;
      fixieAvatar.root.visible = bikeState.chaseView;
    }
    if (e.code === 'KeyR' && !e.repeat && cameraMode === 'bike') {
      cycleRiderPreset();
    }
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
    if (cameraMode === 'bike') {
      if (bikeState.chaseView) {
        bikeState.camOrbitYaw -= dx * 0.0052;
        bikeState.camPitch = Math.max(0.06, Math.min(0.85, bikeState.camPitch + dy * 0.0042));
      } else {
        freeState.yaw -= dx * 0.0042;
        freeState.pitch = Math.max(-0.45, Math.min(0.48, freeState.pitch - dy * 0.0035));
      }
      return;
    }
    freeState.yaw -= dx * 0.0042;
    freeState.pitch = Math.max(-1.45, Math.min(1.35, freeState.pitch - dy * 0.0035));
  });

  window.addEventListener('pointerup', () => {
    freeState.isDragging = false;
  });

  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      if (cameraMode === 'aerial') {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.12 : 0.89;
        freeState.aerialSpeed = Math.max(25, Math.min(320, freeState.aerialSpeed * factor));
      } else if (cameraMode === 'bike' && bikeState.chaseView) {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 0.91 : 1.10;
        bikeState.chaseDist = Math.max(3.6, Math.min(14.5, bikeState.chaseDist * factor));
      }
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
        freeState.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, x));
        freeState.z = Math.max(worldBounds.minZ, Math.min(worldBounds.maxZ, z + 35));
        const gy = terrain.getHeightAtXZ(freeState.x, freeState.z);
        freeState.y = gy + 0.24;
        freeState.yaw = 0;
        bikeState.speedMs = 0;
        bikeState.velX = 0;
        bikeState.velZ = 0;
        bikeState.whipAngle = 0;
        bikeState.whipVel = 0;
        skidTrail.breakTrail();
        bikeState.camOrbitYaw = 0;
        bikeState.camPos.set(freeState.x, gy + 3.2, freeState.z + bikeState.chaseDist);
        bikeState.camLook.set(freeState.x, gy + 1.35, freeState.z - 8);
        return;
      }
      if (cameraMode === 'aerial') {
        const destGroundY = terrain.getHeightAtXZ(x, z + 160);
        freeState.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, x));
        freeState.y = Math.max(freeState.y, destGroundY + 130);
        freeState.z = Math.max(worldBounds.minZ, Math.min(worldBounds.maxZ, z + 160));
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
    btnRider.hidden = mode !== 'bike';
    fixieAvatar.root.visible = mode === 'bike' && bikeState.chaseView;
    skidTrail.mesh.visible = mode === 'bike';

    if (mode === 'aerial') {
      camera.fov = 58;
      camera.updateProjectionMatrix();
      if (prevMode === 'map') {
        freeState.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, camera.position.x));
        freeState.z = Math.max(worldBounds.minZ, Math.min(worldBounds.maxZ, camera.position.z));
        const minY = terrain.getHeightAtXZ(freeState.x, freeState.z) + 25;
        freeState.y = Math.max(minY, Math.min(1400, camera.position.y));
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
      camera.fov = 61;
      camera.updateProjectionMatrix();
      if (prevMode === 'map') {
        freeState.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, mapControls.target.x));
        freeState.z = Math.max(worldBounds.minZ, Math.min(worldBounds.maxZ, mapControls.target.z + 20));
        const lookDir = new THREE.Vector3();
        camera.getWorldDirection(lookDir);
        freeState.yaw = Math.atan2(-lookDir.x, -lookDir.z);
      }
      const gy = terrain.getHeightAtXZ(freeState.x, freeState.z);
      freeState.y = gy + 0.24;
      freeState.pitch = -0.02;
      freeState.velX = 0;
      freeState.velY = 0;
      freeState.velZ = 0;
      bikeState.speedMs = 0;
      bikeState.velX = 0;
      bikeState.velZ = 0;
      bikeState.whipAngle = 0;
      bikeState.whipVel = 0;
      bikeState.standBlend = 0.7;
      bikeState.hopLiftM = 0;
      bikeState.hopVel = 0;
      bikeState.wasSkidding = false;
      bikeState.lastSkidTurn = 0;
      bikeState.turnRateVel = 0;
      bikeState.weightBias = 0.12;
      bikeState.skidJitterPhase = 0;
      bikeState.camHeroYaw = 0.42;
      skidTrail.breakTrail();
      bikeState.camOrbitYaw = 0;
      const fwdX = -Math.sin(freeState.yaw);
      const fwdZ = -Math.cos(freeState.yaw);
      const initCamYaw = freeState.yaw + (bikeState.camPreset === '34' ? 0.42 : 0);
      bikeState.camPos.set(
        freeState.x + Math.sin(initCamYaw) * bikeState.chaseDist,
        gy + 1.85,
        freeState.z + Math.cos(initCamYaw) * bikeState.chaseDist
      );
      bikeState.camLook.set(freeState.x + fwdX * 2.5, gy + 1.0, freeState.z + fwdZ * 2.5);
      fixieAvatar.update(
        {
          speedMs: 0,
          steerAngle: 0.34,
          leanAngle: 0,
          crankAngle: Math.PI * 0.5,
          slopePitch: 0,
          isSprinting: false,
          isSkidding: false,
          whipAngle: 0,
          weightBias: 0.12,
          standBlend: 0.7,
          hopLiftM: 0,
          lookYaw: 0,
        },
        freeState.yaw,
        freeState.x,
        freeState.y,
        freeState.z,
        0.016
      );
      flightModeLabel.textContent = 'Fixie (Calle)';
      flightHint.innerHTML =
        '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> pedalear · <kbd>Espacio</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> skid delante/sentado · <kbd>Shift</kbd> sprint · <kbd>R</kbd> rider · <kbd>C</kbd> cámara';
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

      freeState.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, freeState.x + freeState.velX * dt));
      freeState.z = Math.max(worldBounds.minZ, Math.min(worldBounds.maxZ, freeState.z + freeState.velZ * dt));
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
      const sprint = keys.has('ShiftLeft') || keys.has('ShiftRight');
      const forwardInput = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
      const weightInput = (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0);
      const turnInput =
        (keys.has('KeyA') || keys.has('ArrowLeft') || keys.has('KeyQ') ? 1 : 0) -
        (keys.has('KeyD') || keys.has('ArrowRight') || keys.has('KeyE') ? 1 : 0);
      const skidInput = keys.has('Space');

      const speedMag = Math.hypot(bikeState.velX, bikeState.velZ);
      const fwdX = -Math.sin(freeState.yaw);
      const fwdZ = -Math.cos(freeState.yaw);
      const gradePct = terrain.getSlopeGradeAtXZ(freeState.x, freeState.z, fwdX, fwdZ);

      const preVForward = bikeState.velX * fwdX + bikeState.velZ * fwdZ;
      const isSkidding = skidInput && speedMag > 2.0 && preVForward > -0.5;

      // Transferencia de peso con ↑ (adelantarse al manillar) y ↓ (quedarse sentado sobre la rueda trasera)
      const defaultWeight = isSkidding ? 0.12 : sprint && forwardInput > 0 ? 0.55 : 0.0;
      const weightTarget = weightInput !== 0 ? weightInput : defaultWeight;
      const weightRate = weightInput !== 0 ? 8.5 : 5.5;
      bikeState.weightBias += (weightTarget - bikeState.weightBias) * Math.min(1, dt * weightRate);
      bikeState.weightBias = Math.max(-1, Math.min(1, bikeState.weightBias));
      const forwardLean01 = Math.max(0, bikeState.weightBias);
      const seated01 = Math.max(0, -bikeState.weightBias);

      // 1. Giro ágil a ritmo urbano (< ~41 km/h); al superar ~41 km/h entra el peso e inercia centrípeta real
      const highSpeedRatio = Math.max(0, Math.min(1, (speedMag - 11.4) / 5.4));
      const agileTurn = Math.max(1.45, 2.25 - speedMag * 0.06);
      const fastLimitTurn = 11.2 / Math.max(11.4, speedMag); // ~0.98 -> ~0.65 rad/s a 62 km/h
      const maxGripTurnRate = agileTurn * (1 - highSpeedRatio) + fastLimitTurn * highSpeedRatio;
      const reverseSign = preVForward < -0.4 && speedMag > 0.4 ? -1 : 1;
      const desiredTurnRate = isSkidding
        ? turnInput * (1.72 + Math.abs(bikeState.whipAngle) * 0.55)
        : turnInput * maxGripTurnRate * reverseSign;

      bikeState.turnRateVel +=
        (desiredTurnRate - bikeState.turnRateVel) * Math.min(1, dt * (isSkidding ? 15.0 : 12.0));

      // Eje de rotación real en el parche de contacto de la rueda delantera (0.57 m delante del pedalier)
      const FRONT_CONTACT_OFFSET = 0.57;
      const frontContactX = freeState.x + fwdX * FRONT_CONTACT_OFFSET;
      const frontContactZ = freeState.z + fwdZ * FRONT_CONTACT_OFFSET;
      freeState.yaw += bikeState.turnRateVel * dt;

      const nextDirX = -Math.sin(freeState.yaw);
      const nextDirZ = -Math.cos(freeState.yaw);
      const nextRightX = Math.cos(freeState.yaw);
      const nextRightZ = -Math.sin(freeState.yaw);
      freeState.x = frontContactX - nextDirX * FRONT_CONTACT_OFFSET;
      freeState.z = frontContactZ - nextDirZ * FRONT_CONTACT_OFFSET;

      // Gravedad en pendiente aplicada según vector de movimiento real
      if (speedMag > 0.25) {
        const slopeDirGrade = terrain.getSlopeGradeAtXZ(
          freeState.x,
          freeState.z,
          bikeState.velX / speedMag,
          bikeState.velZ / speedMag
        );
        const gravAccel = (-slopeDirGrade / 100) * 9.81 * 0.65 * dt;
        bikeState.velX += (bikeState.velX / speedMag) * gravAccel;
        bikeState.velZ += (bikeState.velZ / speedMag) * gravAccel;
      }

      // Descomponer momento actual en los nuevos ejes del chasis
      let vForward = bikeState.velX * nextDirX + bikeState.velZ * nextDirZ;
      let vLateral = bikeState.velX * nextRightX + bikeState.velZ * nextRightZ;

      if (isSkidding) {
        // Fricción cinética real del neumático trasero bloqueado: actúa OPUESTA al vector velocidad mundial (inercia)
        const curSpeed = Math.hypot(bikeState.velX, bikeState.velZ);
        if (curSpeed > 0.05) {
          const slipRatio = Math.min(1, Math.abs(vLateral) / Math.max(1.5, curSpeed));
          const highSpeedSlipFactor = Math.min(1, curSpeed / 15.8);
          // Carga vertical trasera: sentado (weightBias < 0) frena mucho más; echado delante descarga atrás para alargarlo
          const weightBrakeMod = seated01 * 3.1 - forwardLean01 * 1.75;
          const kineticSlideDecel = Math.max(
            1.45,
            3.85 - highSpeedSlipFactor * 1.7 + slipRatio * 2.1 + weightBrakeMod
          );
          const speedDrop = Math.min(curSpeed, kineticSlideDecel * dt);
          const scale = (curSpeed - speedDrop) / curSpeed;
          bikeState.velX *= scale;
          bikeState.velZ *= scale;

          // Re-proyectar tras la fricción cinética y aplicar mordida direccional limitada de la rueda delantera viva
          vForward = bikeState.velX * nextDirX + bikeState.velZ * nextDirZ;
          vLateral = bikeState.velX * nextRightX + bikeState.velZ * nextRightZ;
          // Más carga sobre la delantera = más mordida direccional limpia
          const maxFrontBite = (2.85 + forwardLean01 * 1.05 - seated01 * 0.65) * dt;
          if (Math.abs(vLateral) <= maxFrontBite) {
            vLateral = 0;
          } else {
            vLateral -= Math.sign(vLateral) * maxFrontBite;
          }
          bikeState.velX = nextDirX * vForward + nextRightX * vLateral;
          bikeState.velZ = nextDirZ * vForward + nextRightZ * vLateral;
        }

        // Bamboleo + estabilidad dependiente del reparto de peso:
        // Delante (↑) = trazada limpia y predecible; sentado (↓) = nerviosismo trasero que pide compensar con A/D
        const speedWhipGain = Math.min(1.0, speedMag / 6.0);
        const inertiaSlipBias = Math.max(-0.42, Math.min(0.42, (vLateral / Math.max(4, speedMag)) * 0.70));
        let seatedChatterTarget = 0;
        if (seated01 > 0.05) {
          bikeState.skidJitterPhase += dt * (8.5 + curSpeed * 0.65);
          const wobbleWave =
            Math.sin(bikeState.skidJitterPhase) * 0.65 +
            Math.cos(bikeState.skidJitterPhase * 1.73) * 0.35;
          seatedChatterTarget = seated01 * Math.min(1, curSpeed / 5.5) * wobbleWave * 0.34;
          if (turnInput === 0 && Math.abs(bikeState.whipAngle) < 0.08) {
            bikeState.whipVel += seatedChatterTarget * 6.5 * dt;
          }
        }
        const whipTarget = Math.max(
          -0.8,
          Math.min(0.8, turnInput * 0.56 * speedWhipGain + inertiaSlipBias + seatedChatterTarget)
        );
        const whipSpring = (turnInput !== 0 ? 44.0 : 22.0) - seated01 * 6.0;
        const whipDamping = Math.max(
          3.8,
          (turnInput !== 0 ? 6.8 : 7.6) + forwardLean01 * 1.8 - seated01 * 2.8
        );
        bikeState.whipVel += ((whipTarget - bikeState.whipAngle) * whipSpring - bikeState.whipVel * whipDamping) * dt;
        bikeState.whipAngle = Math.max(-0.82, Math.min(0.82, bikeState.whipAngle + bikeState.whipVel * dt));
      } else {
        // Al soltar el skid, la rueda trasera muerde de nuevo y recupera alineación
        bikeState.whipVel += (-bikeState.whipAngle * 38.0 - bikeState.whipVel * 10.0) * dt;
        bikeState.whipAngle += bikeState.whipVel * dt;
        if (Math.abs(bikeState.whipAngle) < 0.004 && Math.abs(bikeState.whipVel) < 0.02) {
          bikeState.whipAngle = 0;
          bikeState.whipVel = 0;
        }

        if (forwardInput > 0) {
          const cruiseMax = (sprint ? 16.6 : 11.2) - gradePct * 0.24;
          const driveAccel = sprint ? 7.5 : 5.3;
          if (vForward < cruiseMax) {
            vForward = Math.min(cruiseMax, vForward + driveAccel * dt);
          } else {
            vForward += (cruiseMax - vForward) * Math.min(1, dt * 1.3);
          }
        } else if (forwardInput < 0) {
          if (vForward > 0.5) {
            const legBrakeDecel = 7.4 - Math.min(3.4, speedMag * 0.21);
            vForward = Math.max(0, vForward - legBrakeDecel * dt);
          } else {
            vForward += (-4.2 - vForward) * Math.min(1, dt * 5.0);
          }
        } else {
          // Planeo con inercia larga en piñón fijo
          const aeroDrag = 0.0042 * Math.abs(vForward) * vForward * dt;
          vForward -= aeroDrag;
          vForward *= Math.exp(-dt * 0.14);
        }

        // Subviraje sutil si intentas apretar giro máximo a muy alta velocidad
        const rollLatGrip = Math.max(3.6, 10.5 - speedMag * 0.42);
        vLateral *= Math.exp(-rollLatGrip * dt);

        bikeState.velX = nextDirX * vForward + nextRightX * vLateral;
        bikeState.velZ = nextDirZ * vForward + nextRightZ * vLateral;
      }
      const nextSpeedMag = Math.hypot(bikeState.velX, bikeState.velZ);
      if (nextSpeedMag < 0.08 && forwardInput === 0 && !isSkidding) {
        bikeState.velX = 0;
        bikeState.velZ = 0;
        bikeState.speedMs = 0;
      } else {
        bikeState.speedMs = vForward >= -0.25 ? nextSpeedMag : -nextSpeedMag;
      }

      freeState.x = Math.max(worldBounds.minX, Math.min(worldBounds.maxX, freeState.x + bikeState.velX * dt));
      freeState.z = Math.max(worldBounds.minZ, Math.min(worldBounds.maxZ, freeState.z + bikeState.velZ * dt));

      const groundY = terrain.getHeightAtXZ(freeState.x, freeState.z);
      const bikeY = groundY + 0.24;
      freeState.y = bikeY;

      // Estado visual + mecánicas propias de piñón fijo
      const isTrackStand = nextSpeedMag < 1.15 && forwardInput === 0 && !isSkidding;
      if (isTrackStand) {
        bikeState.trackStandPhase += dt * 2.4;
      }

      // Saltito trasero (hop-skid) al clavar bloqueo o cambiar rápido de flanco en el bamboleo
      if (isSkidding && !bikeState.wasSkidding) {
        bikeState.hopVel = 1.25;
      } else if (
        isSkidding &&
        turnInput !== 0 &&
        bikeState.lastSkidTurn !== 0 &&
        turnInput !== bikeState.lastSkidTurn
      ) {
        bikeState.hopVel = Math.max(bikeState.hopVel, 0.92);
      }
      bikeState.wasSkidding = isSkidding;
      if (isSkidding && turnInput !== 0) {
        bikeState.lastSkidTurn = turnInput;
      } else if (!isSkidding) {
        bikeState.lastSkidTurn = 0;
      }

      bikeState.hopVel -= 19.5 * dt;
      bikeState.hopLiftM = Math.max(0, bikeState.hopLiftM + bikeState.hopVel * dt);
      if (bikeState.hopLiftM <= 0 && bikeState.hopVel < 0) {
        bikeState.hopVel = 0;
      }

      // Al esprintar, te pones de pie con firmeza; el tambaleo real del cuadro arranca al superar ~32 km/h
      const isStandingSprint = !isSkidding && sprint && forwardInput > 0;
      const targetStand = isTrackStand ? 0.72 : isStandingSprint ? 1.0 : 0.0;
      bikeState.standBlend += (targetStand - bikeState.standBlend) * Math.min(1, dt * 8.5);

      const targetSteer = isTrackStand
        ? 0.36 + Math.sin(bikeState.trackStandPhase) * 0.06
        : isSkidding
          ? turnInput * 0.16 - bikeState.whipAngle * 0.50
          : (bikeState.turnRateVel / Math.max(0.5, maxGripTurnRate)) * (0.28 - Math.min(0.16, nextSpeedMag * 0.009));

      // Inclinación centrípeta física real: atan(v * omega / g)
      const physicsBank = Math.atan((bikeState.turnRateVel * Math.max(0, vForward)) / 9.81);
      const targetLean = isTrackStand
        ? Math.sin(bikeState.trackStandPhase * 0.85) * 0.032
        : isSkidding
          ? turnInput * 0.30 + bikeState.whipAngle * 0.22
          : Math.max(-0.56, Math.min(0.56, physicsBank * 0.88));

      const targetSlopePitch = Math.atan(gradePct / 100);
      const targetLookYaw = isTrackStand
        ? 0.12
        : turnInput * 0.24 - bikeState.whipAngle * 0.35;

      const animSmooth = Math.min(1, dt * 13);
      bikeState.steerAngle += (targetSteer - bikeState.steerAngle) * animSmooth;
      bikeState.leanAngle += (targetLean - bikeState.leanAngle) * animSmooth;
      bikeState.slopePitch += (targetSlopePitch - bikeState.slopePitch) * Math.min(1, dt * 8);
      bikeState.lookYaw += (targetLookYaw - bikeState.lookYaw) * Math.min(1, dt * 10);

      if (isSkidding) {
        const lockedCrank = Math.round((bikeState.crankAngle - Math.PI * 0.5) / Math.PI) * Math.PI + Math.PI * 0.5;
        bikeState.crankAngle += (lockedCrank - bikeState.crankAngle) * Math.min(1, dt * 16);
        const [rx, rz] = fixieAvatar.getRearTireWorldXZ(
          freeState.yaw,
          freeState.x,
          freeState.z,
          bikeState.whipAngle
        );
        const rearGroundY = terrain.getHeightAtXZ(rx, rz);
        if (bikeState.hopLiftM < 0.018) {
          skidTrail.addPoint(rx, rearGroundY + 0.255, rz);
        } else {
          skidTrail.breakTrail();
        }
      } else if (isTrackStand) {
        const standCrank = Math.round((bikeState.crankAngle - Math.PI * 0.5) / Math.PI) * Math.PI + Math.PI * 0.5;
        bikeState.crankAngle += (standCrank - bikeState.crankAngle + Math.sin(bikeState.trackStandPhase) * 0.08) * Math.min(1, dt * 10);
        skidTrail.breakTrail();
      } else {
        // Piñón fijo real: las bielas SIEMPRE giran acopladas a la rueda trasera (sin rueda libre)
        bikeState.crankAngle += (bikeState.speedMs / (0.345 * 2.45)) * dt;
        skidTrail.breakTrail();
      }

      fixieAvatar.update(
        {
          speedMs: bikeState.speedMs,
          steerAngle: bikeState.steerAngle,
          leanAngle: bikeState.leanAngle,
          crankAngle: bikeState.crankAngle,
          slopePitch: bikeState.slopePitch,
          isSprinting: sprint && forwardInput > 0 && !isSkidding,
          isSkidding,
          whipAngle: bikeState.whipAngle,
          weightBias: bikeState.weightBias,
          standBlend: bikeState.standBlend,
          hopLiftM: bikeState.hopLiftM,
          lookYaw: bikeState.lookYaw,
        },
        freeState.yaw,
        freeState.x,
        bikeY,
        freeState.z,
        dt
      );

      // Dirección real del movimiento (inercia) para alinear la cámara al derrape
      let travelHeading = freeState.yaw;
      if (nextSpeedMag > 2.2 && vForward > 0.5) {
        const velYaw = Math.atan2(-bikeState.velX, -bikeState.velZ);
        const yawDiff = Math.atan2(Math.sin(velYaw - freeState.yaw), Math.cos(velYaw - freeState.yaw));
        travelHeading = freeState.yaw + yawDiff * (isSkidding ? 0.78 : 0.55);
      }
      const travelDirX = -Math.sin(travelHeading);
      const travelDirZ = -Math.cos(travelHeading);

      if (bikeState.chaseView) {
        if (!freeState.isDragging && Math.abs(bikeState.speedMs) > 1.8) {
          bikeState.camOrbitYaw *= Math.exp(-dt * 1.1);
        }

        // Encuadre 3/4 dinámico para ver bien al personaje, sus brazos/piernas y el derrape de lado
        const targetHeroYaw =
          bikeState.camPreset === '34'
            ? 0.42 + (Math.abs(bikeState.whipAngle) > 0.08 ? -bikeState.whipAngle * 0.25 : -turnInput * 0.14)
            : 0;
        bikeState.camHeroYaw += (targetHeroYaw - bikeState.camHeroYaw) * Math.min(1, dt * 4.2);

        const camYaw = travelHeading + bikeState.camHeroYaw + bikeState.camOrbitYaw;
        const camDirX = -Math.sin(camYaw);
        const camDirZ = -Math.cos(camYaw);

        const dynamicDist =
          bikeState.camPreset === '34'
            ? bikeState.chaseDist + Math.min(1.05, nextSpeedMag * 0.062)
            : bikeState.chaseDist + 0.55;
        const horizDist = dynamicDist * Math.cos(bikeState.camPitch);
        const vertOffset = 0.88 + dynamicDist * Math.sin(bikeState.camPitch);
        const idealCamX = freeState.x - camDirX * horizDist;
        const idealCamZ = freeState.z - camDirZ * horizDist;
        const camGround = terrain.getHeightAtXZ(idealCamX, idealCamZ);
        const idealCamY = Math.max(camGround + 0.85, bikeY + vertOffset);

        const camLerp = Math.min(1, dt * 11);
        bikeState.camPos.x += (idealCamX - bikeState.camPos.x) * camLerp;
        bikeState.camPos.y += (idealCamY - bikeState.camPos.y) * camLerp;
        bikeState.camPos.z += (idealCamZ - bikeState.camPos.z) * camLerp;

        const lookAhead = 2.2 + nextSpeedMag * 0.14;
        const idealLookX = freeState.x + travelDirX * lookAhead;
        const idealLookY = bikeY + 1.02 + gradePct * 0.03;
        const idealLookZ = freeState.z + travelDirZ * lookAhead;
        bikeState.camLook.x += (idealLookX - bikeState.camLook.x) * Math.min(1, dt * 14);
        bikeState.camLook.y += (idealLookY - bikeState.camLook.y) * Math.min(1, dt * 14);
        bikeState.camLook.z += (idealLookZ - bikeState.camLook.z) * Math.min(1, dt * 14);

        camera.position.copy(bikeState.camPos);
        camera.lookAt(bikeState.camLook);

        const targetFov = isSkidding ? 64 : sprint && bikeState.speedMs > 9 ? 67 : 60;
        if (Math.abs(camera.fov - targetFov) > 0.05) {
          camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 6);
          camera.updateProjectionMatrix();
        }
      } else {
        const headY = bikeY + 1.55;
        const aheadY = terrain.getHeightAtXZ(freeState.x + nextDirX * 25, freeState.z + nextDirZ * 25) + 1.55;
        camera.position.set(freeState.x, headY, freeState.z);
        lookTarget.set(
          freeState.x + nextDirX * 25,
          aheadY + Math.sin(freeState.pitch) * 25,
          freeState.z + nextDirZ * 25
        );
        camera.lookAt(lookTarget);
      }

      focusX = freeState.x + travelDirX * 120;
      focusZ = freeState.z + travelDirZ * 120;

      const absGround = terrain.getAbsoluteElevationAtXZ(freeState.x, freeState.z);
      const gradeSign = gradePct >= 0.05 ? '+' : '';
      const camLabel =
        bikeState.camPreset === '34' ? '3/4' : bikeState.camPreset === 'rear' ? 'Trasera' : 'Cabina';
      const skidPoseTag =
        bikeState.weightBias > 0.38
          ? ' DELANTE'
          : bikeState.weightBias < -0.35
            ? ' SENTADO'
            : '';
      flightModeLabel.textContent = isSkidding
        ? `Fixie · SKID${skidPoseTag} ${Math.round(Math.abs(bikeState.whipAngle) * 57.3)}°`
        : `Fixie · ${camLabel}`;
      flightAltEl.textContent = `${Math.round(absGround)} m · ${gradeSign}${gradePct.toFixed(1)}%`;
      flightSpeedEl.textContent = `${Math.abs(bikeState.speedMs * 3.6).toFixed(0)} km/h`;
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
