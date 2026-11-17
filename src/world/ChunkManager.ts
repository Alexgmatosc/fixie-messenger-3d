import * as THREE from 'three/webgpu';
import type { TerrainElevation } from '../geo/projection';
import type { ChunkManifest, ChunkManifestEntry, ChunkPayload } from '../types/mapData';
import {
  buildChunkGroup,
  disposeChunkGroup,
  type SharedCityResources,
} from './CityBuilder';

interface CachedChunk {
  entry: ChunkManifestEntry;
  group: THREE.Group;
  buildingsCount: number;
  treesCount: number;
  lastUsedFrame: number;
  visible: boolean;
}

export interface StreamingStats {
  activeChunks: number;
  cachedChunks: number;
  totalChunks: number;
  loadedBuildings: number;
  loadedTrees: number;
}

/**
 * Gestor de Spatial Chunk Streaming en dos niveles (Visible + Warm LRU Pool):
 * - Los bloques dentro de `visibleRadiusM` se renderizan (`group.visible = true`).
 * - Los bloques fuera de rango se ocultan al instante sin destruir su geometría (0 ms al girar).
 * - Solo cuando la caché supera `warmCacheMaxChunks` se liberan los más antiguos por LRU.
 */
export class ChunkManager {
  private manifest: ChunkManifest;
  private readonly scene: THREE.Scene;
  private readonly resources: SharedCityResources;
  private readonly terrain: TerrainElevation;
  private readonly cache = new Map<string, CachedChunk>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly pendingBuild: {
    entry: ChunkManifestEntry;
    payload: ChunkPayload;
    slpkMeshBuffer?: ArrayBuffer | null;
  }[] = [];

  private readonly visibleRadiusM = 780;
  private readonly warmCacheMaxChunks = 55;
  private readonly maxConcurrentFetches = 4;
  private readonly maxBuildsPerFrame = 1;

  private frameCounter = 0;
  private lastScanX = Infinity;
  private lastScanZ = Infinity;

  constructor(
    manifest: ChunkManifest,
    scene: THREE.Scene,
    resources: SharedCityResources,
    terrain: TerrainElevation
  ) {
    this.manifest = manifest;
    this.scene = scene;
    this.resources = resources;
    this.terrain = terrain;
  }

  get totalChunks(): number {
    return this.manifest.totals.chunks;
  }

  setManifest(nextManifest: ChunkManifest): void {
    for (const ctrl of this.inflight.values()) {
      ctrl.abort();
    }
    this.inflight.clear();
    this.pendingBuild.length = 0;

    for (const chunk of this.cache.values()) {
      this.scene.remove(chunk.group);
      disposeChunkGroup(chunk.group, this.resources);
    }
    this.cache.clear();

    this.manifest = nextManifest;
    this.lastScanX = Infinity;
    this.lastScanZ = Infinity;
  }

  update(focusX: number, focusZ: number): void {
    this.frameCounter++;
    const chunkSize = this.manifest.meta.chunkSizeM;
    const halfChunk = chunkSize * 0.5;
    const visibleSq = this.visibleRadiusM * this.visibleRadiusM;

    // 1. Construir como máximo 1 chunk por frame (construcción rápida < 2 ms)
    let built = 0;
    while (built < this.maxBuildsPerFrame && this.pendingBuild.length > 0) {
      const item = this.pendingBuild.shift()!;
      if (this.cache.has(item.entry.key)) continue;

      const result = buildChunkGroup(
        item.payload,
        this.resources,
        this.terrain,
        item.slpkMeshBuffer
      );
      const centerX = item.entry.cx * chunkSize + halfChunk;
      const centerZ = item.entry.cz * chunkSize + halfChunk;
      const isVis = (centerX - focusX) ** 2 + (centerZ - focusZ) ** 2 <= visibleSq;

      result.group.visible = isVis;
      this.scene.add(result.group);
      this.cache.set(item.entry.key, {
        entry: item.entry,
        group: result.group,
        buildingsCount: result.buildingsCount,
        treesCount: result.treesCount,
        lastUsedFrame: this.frameCounter,
        visible: isVis,
      });
      built++;
    }

    // 2. Evitar re-escanear todos los chunks si el foco apenas se movió (< 30 m)
    const movedSq = (focusX - this.lastScanX) ** 2 + (focusZ - this.lastScanZ) ** 2;
    if (movedSq < 900 && this.inflight.size === 0 && this.pendingBuild.length === 0) {
      return;
    }
    this.lastScanX = focusX;
    this.lastScanZ = focusZ;

    // 3. Alternar visibilidad sin destruir geometría
    for (const chunk of this.cache.values()) {
      const centerX = chunk.entry.cx * chunkSize + halfChunk;
      const centerZ = chunk.entry.cz * chunkSize + halfChunk;
      const isVis = (centerX - focusX) ** 2 + (centerZ - focusZ) ** 2 <= visibleSq;
      if (chunk.visible !== isVis) {
        chunk.visible = isVis;
        chunk.group.visible = isVis;
      }
      if (isVis) {
        chunk.lastUsedFrame = this.frameCounter;
      }
    }

    // 4. Liberar por LRU solo si superamos el tope de caché caliente
    if (this.cache.size > this.warmCacheMaxChunks) {
      const victims = Array.from(this.cache.entries())
        .filter(([, c]) => !c.visible)
        .sort((a, b) => a[1].lastUsedFrame - b[1].lastUsedFrame);

      while (this.cache.size > this.warmCacheMaxChunks && victims.length > 0) {
        const [key, victim] = victims.shift()!;
        this.scene.remove(victim.group);
        disposeChunkGroup(victim.group, this.resources);
        this.cache.delete(key);
      }
    }

    // 5. Cancelar descargas fuera de radio visible ampliado
    for (const [key, ctrl] of this.inflight.entries()) {
      const entry = this.manifest.chunks.find((c) => c.key === key);
      if (!entry) continue;
      const centerX = entry.cx * chunkSize + halfChunk;
      const centerZ = entry.cz * chunkSize + halfChunk;
      if ((centerX - focusX) ** 2 + (centerZ - focusZ) ** 2 > visibleSq * 1.4) {
        ctrl.abort();
        this.inflight.delete(key);
      }
    }

    // 6. Descargar chunks faltantes dentro del radio visible, del más cercano al más lejano
    if (this.inflight.size >= this.maxConcurrentFetches) return;

    const candidates: { entry: ChunkManifestEntry; distSq: number }[] = [];
    for (const entry of this.manifest.chunks) {
      if (
        this.cache.has(entry.key) ||
        this.inflight.has(entry.key) ||
        this.pendingBuild.some((p) => p.entry.key === entry.key)
      ) {
        continue;
      }
      const centerX = entry.cx * chunkSize + halfChunk;
      const centerZ = entry.cz * chunkSize + halfChunk;
      const distSq = (centerX - focusX) ** 2 + (centerZ - focusZ) ** 2;
      if (distSq <= visibleSq) {
        candidates.push({ entry, distSq });
      }
    }

    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.distSq - b.distSq);

    for (const { entry } of candidates) {
      if (this.inflight.size >= this.maxConcurrentFetches) break;
      this.startFetch(entry);
    }
  }

  private resolveChunkUrl(entry: ChunkManifestEntry): string {
    return entry.file.startsWith('/') ? entry.file : `/data/chunks/${entry.file}`;
  }

  private startFetch(entry: ChunkManifestEntry): void {
    const controller = new AbortController();
    const targetManifest = this.manifest;
    this.inflight.set(entry.key, controller);

    const jsonPromise = fetch(this.resolveChunkUrl(entry), { signal: controller.signal }).then(
      (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<ChunkPayload>;
      }
    );
    const meshPromise = entry.meshFile
      ? fetch(entry.meshFile, { signal: controller.signal }).then((res) =>
          res.ok ? res.arrayBuffer() : null
        )
      : Promise.resolve(null);

    Promise.all([jsonPromise, meshPromise])
      .then(([payload, slpkMeshBuffer]) => {
        this.inflight.delete(entry.key);
        if (this.manifest !== targetManifest) return;
        this.pendingBuild.push({ entry, payload, slpkMeshBuffer });
      })
      .catch((err) => {
        this.inflight.delete(entry.key);
        if (err instanceof Error && err.name !== 'AbortError') {
          console.warn(`Error cargando chunk ${entry.key}:`, err);
        }
      });
  }

  async preloadAround(focusX: number, focusZ: number, radiusM = 740): Promise<void> {
    const targetManifest = this.manifest;
    const chunkSize = targetManifest.meta.chunkSizeM;
    const halfChunk = chunkSize * 0.5;
    const rSq = radiusM * radiusM;

    const initial = targetManifest.chunks
      .map((entry) => {
        const cx = entry.cx * chunkSize + halfChunk;
        const cz = entry.cz * chunkSize + halfChunk;
        return { entry, distSq: (cx - focusX) ** 2 + (cz - focusZ) ** 2 };
      })
      .filter((item) => item.distSq <= rSq)
      .sort((a, b) => a.distSq - b.distSq);

    await Promise.all(
      initial.map(async ({ entry }) => {
        if (this.cache.has(entry.key) || this.manifest !== targetManifest) return;
        const [res, meshRes] = await Promise.all([
          fetch(this.resolveChunkUrl(entry)),
          entry.meshFile ? fetch(entry.meshFile) : Promise.resolve(null),
        ]);
        if (!res.ok || this.manifest !== targetManifest) return;
        const [payload, slpkMeshBuffer] = await Promise.all([
          res.json() as Promise<ChunkPayload>,
          meshRes && meshRes.ok ? meshRes.arrayBuffer() : Promise.resolve(null),
        ]);
        if (this.manifest !== targetManifest || this.cache.has(entry.key)) return;
        const result = buildChunkGroup(payload, this.resources, this.terrain, slpkMeshBuffer);
        result.group.visible = true;
        this.scene.add(result.group);
        this.cache.set(entry.key, {
          entry,
          group: result.group,
          buildingsCount: result.buildingsCount,
          treesCount: result.treesCount,
          lastUsedFrame: this.frameCounter,
          visible: true,
        });
      })
    );
  }

  getStats(): StreamingStats {
    let activeChunks = 0;
    let loadedBuildings = 0;
    let loadedTrees = 0;
    for (const chunk of this.cache.values()) {
      if (!chunk.visible) continue;
      activeChunks++;
      loadedBuildings += chunk.buildingsCount;
      loadedTrees += chunk.treesCount;
    }
    return {
      activeChunks,
      cachedChunks: this.cache.size,
      totalChunks: this.manifest.totals.chunks,
      loadedBuildings,
      loadedTrees,
    };
  }
}
