import type { DemGrid } from '../types/mapData';

export const ORIGIN_LON = -3.6941;
export const ORIGIN_LAT = 40.4152;
export const MAP_BBOX: [number, number, number, number] = [-3.7510, 40.3820, -3.6570, 40.4870];

const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
const METERS_PER_DEG_LAT = 110540;

/**
 * Convierte coordenadas WGS84 (lon, lat) al plano tangente local en metros (x, z),
 * centrado en la Fuente de Neptuno (0, 0). El Norte apunta hacia -Z.
 */
export function projectToMeters(lon: number, lat: number): [number, number] {
  const x = (lon - ORIGIN_LON) * METERS_PER_DEG_LON;
  const z = -(lat - ORIGIN_LAT) * METERS_PER_DEG_LAT;
  return [x, z];
}

/**
 * Convierte coordenadas locales en metros (x, z) de vuelta a WGS84 (lon, lat).
 */
export function unprojectFromMeters(x: number, z: number): [number, number] {
  const lon = ORIGIN_LON + x / METERS_PER_DEG_LON;
  const lat = ORIGIN_LAT - z / METERS_PER_DEG_LAT;
  return [lon, lat];
}

/**
 * Interpolador bilineal de elevaciones reales del terreno sobre el DEM precalculado.
 */
export class TerrainElevation {
  private readonly dem: DemGrid;
  public exaggeration: number;

  constructor(dem: DemGrid, exaggeration = 1.0) {
    this.dem = dem;
    this.exaggeration = exaggeration;
  }

  get originElevationM(): number {
    return this.dem.originElevationM;
  }

  get minElevationM(): number {
    return this.dem.minElevationM;
  }

  get maxElevationM(): number {
    return this.dem.maxElevationM;
  }

  get bbox(): [number, number, number, number] {
    return this.dem.bbox;
  }

  getHeightAtLonLat(lon: number, lat: number): number {
    const { cols, rows, bbox, values } = this.dem;
    const u = Math.max(0, Math.min(1, (lon - bbox[0]) / (bbox[2] - bbox[0])));
    const v = Math.max(0, Math.min(1, (lat - bbox[1]) / (bbox[3] - bbox[1])));

    const fx = u * (cols - 1);
    const fy = v * (rows - 1);
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const x1 = Math.min(cols - 1, x0 + 1);
    const y1 = Math.min(rows - 1, y0 + 1);
    const tx = fx - x0;
    const ty = fy - y0;

    const v00 = values[y0 * cols + x0] ?? 0;
    const v10 = values[y0 * cols + x1] ?? 0;
    const v01 = values[y1 * cols + x0] ?? 0;
    const v11 = values[y1 * cols + x1] ?? 0;

    const h0 = v00 * (1 - tx) + v10 * tx;
    const h1 = v01 * (1 - tx) + v11 * tx;
    return (h0 * (1 - ty) + h1 * ty) * this.exaggeration;
  }

  getHeightAtXZ(x: number, z: number): number {
    const [lon, lat] = unprojectFromMeters(x, z);
    return this.getHeightAtLonLat(lon, lat);
  }

  getAbsoluteElevationAtXZ(x: number, z: number): number {
    const [lon, lat] = unprojectFromMeters(x, z);
    return this.dem.originElevationM + this.getHeightAtLonLat(lon, lat) / (this.exaggeration || 1);
  }

  getSlopeGradeAtXZ(x: number, z: number, dirX: number, dirZ: number): number {
    const len = Math.hypot(dirX, dirZ) || 1;
    const nx = dirX / len;
    const nz = dirZ / len;
    const step = 5;
    const hAhead = this.getHeightAtXZ(x + nx * step, z + nz * step);
    const hBehind = this.getHeightAtXZ(x - nx * step, z - nz * step);
    return ((hAhead - hBehind) / (step * 2)) * 100;
  }

  getNormalAtXZ(x: number, z: number): [number, number, number] {
    const step = 4;
    const dhdx = (this.getHeightAtXZ(x + step, z) - this.getHeightAtXZ(x - step, z)) / (step * 2);
    const dhdz = (this.getHeightAtXZ(x, z + step) - this.getHeightAtXZ(x, z - step)) / (step * 2);
    const len = Math.hypot(dhdx, 1, dhdz) || 1;
    return [-dhdx / len, 1 / len, -dhdz / len];
  }
}
