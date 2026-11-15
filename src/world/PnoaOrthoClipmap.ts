import * as THREE from 'three/webgpu';
import { clamp, float, positionWorld, smoothstep, texture, uniform, vec2 } from 'three/tsl';
import { projectToMeters, unprojectFromMeters } from '../geo/projection';

const PNOA_WMTS_URL =
  'https://www.ign.es/wmts/pnoa-ma?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  '&LAYER=OI.OrthoimageCoverage&STYLE=default&FORMAT=image/jpeg' +
  '&TILEMATRIXSET=GoogleMapsCompatible&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

function lonToTileX(lon: number, zoom: number): number {
  return Math.floor(((lon + 180) / 360) * (1 << zoom));
}

function latToTileY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180;
  const n = Math.log(Math.tan(Math.PI * 0.25 + rad * 0.5));
  return Math.floor(((1 - n / Math.PI) * 0.5) * (1 << zoom));
}

function tileXToLon(tx: number, zoom: number): number {
  return (tx / (1 << zoom)) * 360 - 180;
}

function tileYToLat(ty: number, zoom: number): number {
  const n = Math.PI - (2 * Math.PI * ty) / (1 << zoom);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export interface OrthoSampleNodes {
  orthoColor: ReturnType<typeof texture>;
  orthoMask: ReturnType<typeof float>;
}

/**
 * Clipmap dinámico con la Ortofotografía oficial de España (IGN PNOA WMTS):
 * - Mantiene una ventana de 1024×1024 m en alta resolución centrada en la cámara/bici (~0.45–0.8 m/px).
 * - Carga primero nivel z=17 para cobertura instantánea del entorno y refina el área cercana a z=18.
 * - Proyecta exactamente cada tesela EPSG:3857 al plano métrico local `projectToMeters()` sin desfase.
 */
export class PnoaOrthoClipmap {
  public readonly texture: THREE.CanvasTexture;
  /** vec4(originX, originZ, invSpan, readyAlpha) */
  public readonly boundsUniform: ReturnType<typeof uniform<THREE.Vector4>>;

  private readonly canvasSize = 1280;
  private readonly spanM = 1024;
  private readonly recenterThresholdM = 190;
  private readonly maxTileCache = 260;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tileCache = new Map<string, ImageBitmap>();
  private readonly pendingTiles = new Map<string, Promise<ImageBitmap | null>>();

  private centerX = Infinity;
  private centerZ = Infinity;
  private currentAbort: AbortController | null = null;
  private activeBatchId = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvasSize;
    this.canvas.height = this.canvasSize;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('No se pudo inicializar el contexto 2D para PNOA Clipmap.');
    }
    this.ctx = ctx;
    this.ctx.fillStyle = '#ddd7cb';
    this.ctx.fillRect(0, 0, this.canvasSize, this.canvasSize);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.anisotropy = 8;

    this.boundsUniform = uniform(new THREE.Vector4(-512, -512, 1 / this.spanM, 0));
  }

  /**
   * Nodos TSL reutilizables para muestrear la ortofoto en cualquier material por `positionWorld.xz`.
   */
  sampleWorldOrtho(): OrthoSampleNodes {
    const b = this.boundsUniform;
    const uRaw = positionWorld.x.sub(b.x).mul(b.z);
    // CanvasTexture tiene flipY=true: la fila superior del canvas (minZ = Norte) es v=1.0
    const vRaw = float(1.0).sub(positionWorld.z.sub(b.y).mul(b.z));
    const orthoUV = vec2(clamp(uRaw, 0.002, 0.998), clamp(vRaw, 0.002, 0.998));

    const edgeU = smoothstep(float(0.0), float(0.11), uRaw).mul(
      smoothstep(float(1.0), float(0.89), uRaw)
    );
    const edgeV = smoothstep(float(0.0), float(0.11), vRaw).mul(
      smoothstep(float(1.0), float(0.89), vRaw)
    );
    const orthoMask = edgeU.mul(edgeV).mul(b.w);
    const orthoColor = texture(this.texture, orthoUV);
    return { orthoColor, orthoMask };
  }

  /**
   * Actualiza la ventana de ortofoto si el foco se desplazó más de `recenterThresholdM`.
   */
  update(focusX: number, focusZ: number): void {
    const dx = focusX - this.centerX;
    const dz = focusZ - this.centerZ;
    if (dx * dx + dz * dz < this.recenterThresholdM * this.recenterThresholdM) {
      return;
    }

    // Snap a rejilla de 32 m para evitar micro-recalculados continuos
    const nextCenterX = Math.round(focusX / 32) * 32;
    const nextCenterZ = Math.round(focusZ / 32) * 32;
    this.centerX = nextCenterX;
    this.centerZ = nextCenterZ;

    if (this.currentAbort) {
      this.currentAbort.abort();
    }
    this.currentAbort = new AbortController();
    const batchId = ++this.activeBatchId;
    void this.refreshWindow(nextCenterX, nextCenterZ, batchId, this.currentAbort.signal);
  }

  private async refreshWindow(
    cx: number,
    cz: number,
    batchId: number,
    signal: AbortSignal
  ): Promise<void> {
    const half = this.spanM * 0.5;
    const minX = cx - half;
    const maxX = cx + half;
    const minZ = cz - half;
    const maxZ = cz + half;

    // 1. Nivel z=17 sobre toda la ventana (1024×1024 m) + z=18 sobre los 540 m centrales
    const [lonW, latN] = unprojectFromMeters(minX, minZ);
    const [lonE, latS] = unprojectFromMeters(maxX, maxZ);

    const z17Tiles = this.collectTileCoords(lonW, latS, lonE, latN, 17);

    const innerHalf = 270;
    const [inLonW, inLatN] = unprojectFromMeters(cx - innerHalf, cz - innerHalf);
    const [inLonE, inLatS] = unprojectFromMeters(cx + innerHalf, cz + innerHalf);
    const z18Tiles = this.collectTileCoords(inLonW, inLatS, inLonE, inLatN, 18);

    // Pintar primero cualquier tile z=17 ya cacheado para tener respuesta visual instantánea
    const z17Loaded = await Promise.all(
      z17Tiles.map((t) => this.fetchTile(t.z, t.x, t.y, signal).then((bmp) => ({ ...t, bmp })))
    );
    if (signal.aborted || batchId !== this.activeBatchId) return;

    this.ctx.fillStyle = '#ddd7cb';
    this.ctx.fillRect(0, 0, this.canvasSize, this.canvasSize);

    let drawnAny = false;
    for (const item of z17Loaded) {
      if (item.bmp) {
        this.blitTile(item.bmp, item.z, item.x, item.y, minX, minZ);
        drawnAny = true;
      }
    }

    if (drawnAny) {
      this.boundsUniform.value.set(minX, minZ, 1 / this.spanM, 1);
      this.texture.needsUpdate = true;
    }

    // 2. Superponer z=18 de alta nitidez en la zona central alrededor de la bici
    const z18Loaded = await Promise.all(
      z18Tiles.map((t) => this.fetchTile(t.z, t.x, t.y, signal).then((bmp) => ({ ...t, bmp })))
    );
    if (signal.aborted || batchId !== this.activeBatchId) return;

    let drawnHi = false;
    for (const item of z18Loaded) {
      if (item.bmp) {
        this.blitTile(item.bmp, item.z, item.x, item.y, minX, minZ);
        drawnHi = true;
      }
    }

    if (drawnHi) {
      this.boundsUniform.value.set(minX, minZ, 1 / this.spanM, 1);
      this.texture.needsUpdate = true;
    }
  }

  private collectTileCoords(
    lonW: number,
    latS: number,
    lonE: number,
    latN: number,
    z: number
  ): { z: number; x: number; y: number }[] {
    const tx0 = lonToTileX(lonW, z);
    const tx1 = lonToTileX(lonE, z);
    const ty0 = latToTileY(latN, z);
    const ty1 = latToTileY(latS, z);
    const list: { z: number; x: number; y: number }[] = [];
    for (let y = ty0; y <= ty1; y++) {
      for (let x = tx0; x <= tx1; x++) {
        list.push({ z, x, y });
      }
    }
    return list;
  }

  private blitTile(
    bmp: ImageBitmap,
    z: number,
    tx: number,
    ty: number,
    winMinX: number,
    winMinZ: number
  ): void {
    const lon0 = tileXToLon(tx, z);
    const lon1 = tileXToLon(tx + 1, z);
    const latN = tileYToLat(ty, z);
    const latS = tileYToLat(ty + 1, z);

    const [mx0, mzN] = projectToMeters(lon0, latN);
    const [mx1, mzS] = projectToMeters(lon1, latS);

    const scale = this.canvasSize / this.spanM;
    const dx = (mx0 - winMinX) * scale;
    const dy = (mzN - winMinZ) * scale;
    const dw = (mx1 - mx0) * scale;
    const dh = (mzS - mzN) * scale;

    // Solape mínimo de 0.6 px para evitar micro-costuras de redondeo entre teselas vecinas
    this.ctx.drawImage(bmp, dx - 0.3, dy - 0.3, dw + 0.6, dh + 0.6);
  }

  private fetchTile(
    z: number,
    x: number,
    y: number,
    signal: AbortSignal
  ): Promise<ImageBitmap | null> {
    const key = `${z}/${x}/${y}`;
    const cached = this.tileCache.get(key);
    if (cached) {
      // Refrescar orden LRU
      this.tileCache.delete(key);
      this.tileCache.set(key, cached);
      return Promise.resolve(cached);
    }

    const inflight = this.pendingTiles.get(key);
    if (inflight) return inflight;

    const url = PNOA_WMTS_URL.replace('{z}', String(z))
      .replace('{y}', String(y))
      .replace('{x}', String(x));

    const promise = (async (): Promise<ImageBitmap | null> => {
      try {
        const res = await fetch(url, { mode: 'cors', signal });
        if (!res.ok) return null;
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);

        this.tileCache.set(key, bmp);
        if (this.tileCache.size > this.maxTileCache) {
          const oldestKey = this.tileCache.keys().next().value;
          if (oldestKey) {
            const oldest = this.tileCache.get(oldestKey);
            oldest?.close();
            this.tileCache.delete(oldestKey);
          }
        }
        return bmp;
      } catch {
        return null;
      } finally {
        this.pendingTiles.delete(key);
      }
    })();

    this.pendingTiles.set(key, promise);
    return promise;
  }

  dispose(): void {
    if (this.currentAbort) this.currentAbort.abort();
    for (const bmp of this.tileCache.values()) {
      bmp.close();
    }
    this.tileCache.clear();
    this.pendingTiles.clear();
    this.texture.dispose();
  }
}
