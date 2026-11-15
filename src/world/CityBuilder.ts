import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { projectToMeters, type TerrainElevation } from '../geo/projection';
import {
  createBuildingMaterial,
  createGroundMaterial,
  createParkMaterial,
  createRoadMaterial,
  createTreeMaterial,
  createWaterMaterial,
  PALETTE,
} from '../materials/CityMaterials';
import type { ChunkPayload, PolygonFeature, RoadFeature } from '../types/mapData';

export interface SharedCityResources {
  groundMaterial: THREE.MeshStandardNodeMaterial;
  parkMaterial: THREE.MeshStandardNodeMaterial;
  waterMaterial: THREE.MeshStandardNodeMaterial;
  roadMaterial: THREE.MeshStandardNodeMaterial;
  buildingMaterial: THREE.MeshStandardNodeMaterial;
  treeMaterial: THREE.MeshStandardNodeMaterial;
  treePrototype: THREE.BufferGeometry;
}

export interface ChunkBuildResult {
  group: THREE.Group;
  buildingsCount: number;
  treesCount: number;
}

function hashString(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0) / 4294967295;
}

function ringToShapeVectors(ring: [number, number][]): THREE.Vector2[] {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const [x, z] = projectToMeters(ring[i][0], ring[i][1]);
    const v = new THREE.Vector2(x, -z);
    if (pts.length === 0 || pts[pts.length - 1].distanceToSquared(v) > 0.01) {
      pts.push(v);
    }
  }
  if (pts.length > 1 && pts[0].distanceToSquared(pts[pts.length - 1]) < 0.01) {
    pts.pop();
  }
  return pts;
}

function signedArea2D(pts: THREE.Vector2[]): number {
  let area = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    area += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return area * 0.5;
}

function ensureWinding(pts: THREE.Vector2[], wantClockwise: boolean): THREE.Vector2[] {
  const isCW = THREE.ShapeUtils.isClockWise(pts);
  return isCW !== wantClockwise ? [...pts].reverse() : pts;
}

function parsePolygonRings(rings: [number, number][][]): {
  outer: THREE.Vector2[];
  holes: THREE.Vector2[][];
} | null {
  if (rings.length === 0) return null;
  let outer = ringToShapeVectors(rings[0]);
  if (outer.length < 3 || Math.abs(signedArea2D(outer)) < 1.5) return null;
  outer = ensureWinding(outer, false);

  const holes: THREE.Vector2[][] = [];
  for (let h = 1; h < rings.length; h++) {
    let hole = ringToShapeVectors(rings[h]);
    if (hole.length < 3 || Math.abs(signedArea2D(hole)) < 1.0) continue;
    hole = ensureWinding(hole, true);
    holes.push(hole);
  }
  return { outer, holes };
}

/**
 * Prototipo de árbol estilo Apple Maps (~165 triángulos totales) en 1 sola geometría:
 * tronco ligero de 5 caras (aIsCrown = 0) + copa orgánica de 2 lóbulos suavizados (aIsCrown = 1).
 */
function createCombinedTreePrototype(): THREE.BufferGeometry {
  const trunkRaw = new THREE.CylinderGeometry(0.14, 0.22, 1.75, 5, 1, false);
  trunkRaw.translate(0, 0.875, 0);
  const trunk = trunkRaw.index ? trunkRaw.toNonIndexed() : trunkRaw;
  if (trunk !== trunkRaw) trunkRaw.dispose();
  trunk.deleteAttribute('uv');
  const trunkCount = trunk.getAttribute('position').count;
  trunk.setAttribute('aIsCrown', new THREE.Float32BufferAttribute(new Float32Array(trunkCount).fill(0), 1));

  const lobe1Raw = new THREE.IcosahedronGeometry(1.42, 1);
  lobe1Raw.scale(1.05, 0.88, 1.05);
  lobe1Raw.translate(-0.14, 2.88, 0.1);
  const lobe1 = lobe1Raw.index ? lobe1Raw.toNonIndexed() : lobe1Raw;
  if (lobe1 !== lobe1Raw) lobe1Raw.dispose();
  lobe1.deleteAttribute('uv');
  const lobe1Count = lobe1.getAttribute('position').count;
  lobe1.setAttribute('aIsCrown', new THREE.Float32BufferAttribute(new Float32Array(lobe1Count).fill(1), 1));

  const lobe2Raw = new THREE.IcosahedronGeometry(1.02, 1);
  lobe2Raw.scale(1.0, 0.92, 1.0);
  lobe2Raw.translate(0.46, 3.32, -0.28);
  const lobe2 = lobe2Raw.index ? lobe2Raw.toNonIndexed() : lobe2Raw;
  if (lobe2 !== lobe2Raw) lobe2Raw.dispose();
  lobe2.deleteAttribute('uv');
  const lobe2Count = lobe2.getAttribute('position').count;
  lobe2.setAttribute('aIsCrown', new THREE.Float32BufferAttribute(new Float32Array(lobe2Count).fill(1), 1));

  const merged = mergeGeometries([trunk, lobe1, lobe2], false);
  trunk.dispose();
  lobe1.dispose();
  lobe2.dispose();
  if (!merged) return lobe1;
  merged.computeVertexNormals();
  return merged;
}

export function createSharedCityResources(): SharedCityResources {
  return {
    groundMaterial: createGroundMaterial(),
    parkMaterial: createParkMaterial(),
    waterMaterial: createWaterMaterial(),
    roadMaterial: createRoadMaterial(),
    buildingMaterial: createBuildingMaterial(),
    treeMaterial: createTreeMaterial(),
    treePrototype: createCombinedTreePrototype(),
  };
}

export function buildBaseGroundMesh(
  resources: SharedCityResources,
  terrain: TerrainElevation
): THREE.Mesh {
  const geom = new THREE.PlaneGeometry(3800, 3200, 160, 135);
  geom.rotateX(-Math.PI / 2);
  geom.translate(-80, 0, -250);

  const posAttr = geom.getAttribute('position');
  for (let i = 0; i < posAttr.count; i++) {
    const vx = posAttr.getX(i);
    const vz = posAttr.getZ(i);
    posAttr.setY(i, terrain.getHeightAtXZ(vx, vz) - 0.22);
  }
  posAttr.needsUpdate = true;
  geom.computeVertexNormals();

  const mesh = new THREE.Mesh(geom, resources.groundMaterial);
  mesh.name = 'ground-base';
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function pushSubdividedSurfaceTriangle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  yOffset: number,
  terrain: TerrainElevation,
  subdivideMaxEdge: number,
  depth: number,
  positions: number[],
  normals: number[]
): void {
  if (depth < 5 && subdivideMaxEdge > 0) {
    const lenAB = Math.hypot(bx - ax, bz - az);
    const lenBC = Math.hypot(cx - bx, cz - bz);
    const lenCA = Math.hypot(ax - cx, az - cz);
    if (Math.max(lenAB, lenBC, lenCA) > subdivideMaxEdge) {
      const abx = (ax + bx) * 0.5;
      const abz = (az + bz) * 0.5;
      const bcx = (bx + cx) * 0.5;
      const bcz = (bz + cz) * 0.5;
      const cax = (cx + ax) * 0.5;
      const caz = (cz + az) * 0.5;
      const nextDepth = depth + 1;
      pushSubdividedSurfaceTriangle(ax, az, abx, abz, cax, caz, yOffset, terrain, subdivideMaxEdge, nextDepth, positions, normals);
      pushSubdividedSurfaceTriangle(abx, abz, bx, bz, bcx, bcz, yOffset, terrain, subdivideMaxEdge, nextDepth, positions, normals);
      pushSubdividedSurfaceTriangle(cax, caz, bcx, bcz, cx, cz, yOffset, terrain, subdivideMaxEdge, nextDepth, positions, normals);
      pushSubdividedSurfaceTriangle(abx, abz, bcx, bcz, cax, caz, yOffset, terrain, subdivideMaxEdge, nextDepth, positions, normals);
      return;
    }
  }

  const ay = terrain.getHeightAtXZ(ax, az) + yOffset;
  const by = terrain.getHeightAtXZ(bx, bz) + yOffset;
  const cy = terrain.getHeightAtXZ(cx, cz) + yOffset;
  const na = terrain.getNormalAtXZ(ax, az);
  const nb = terrain.getNormalAtXZ(bx, bz);
  const nc = terrain.getNormalAtXZ(cx, cz);

  positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  normals.push(na[0], na[1], na[2], nb[0], nb[1], nb[2], nc[0], nc[1], nc[2]);
}

function buildPolygonSurfaceMesh(
  features: PolygonFeature[],
  yOffset: number,
  material: THREE.Material,
  name: string,
  terrain: TerrainElevation,
  subdivideMaxEdge = 24
): THREE.Mesh | null {
  const positions: number[] = [];
  const normals: number[] = [];

  for (const feat of features) {
    const parsed = parsePolygonRings(feat.rings);
    if (!parsed) continue;

    let triangles: number[][];
    try {
      triangles = THREE.ShapeUtils.triangulateShape(parsed.outer, parsed.holes);
    } catch {
      continue;
    }

    const allPts: THREE.Vector2[] = [...parsed.outer];
    for (const h of parsed.holes) {
      for (const pt of h) allPts.push(pt);
    }

    for (let t = 0; t < triangles.length; t++) {
      const [ia, ib, ic] = triangles[t];
      const a = allPts[ia];
      const b = allPts[ib];
      const c = allPts[ic];
      if (!a || !b || !c) continue;
      pushSubdividedSurfaceTriangle(
        a.x,
        -a.y,
        b.x,
        -b.y,
        c.x,
        -c.y,
        yOffset,
        terrain,
        subdivideMaxEdge,
        0,
        positions,
        normals
      );
    }
  }

  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

function getRoadStyle(road: RoadFeature): { width: number; roadClass: number; baseY: number } {
  const hw = road.highway;
  if (hw === 'trunk' || hw === 'primary' || hw === 'primary_link') {
    const width = road.oneway ? (road.lanes >= 4 ? 13.0 : 11.0) : 20.0;
    return { width, roadClass: 3, baseY: 0.28 };
  }
  if (hw === 'secondary' || hw === 'secondary_link' || hw === 'tertiary' || hw === 'tertiary_link') {
    const width = road.oneway ? 8.5 : 10.0;
    return { width, roadClass: 2, baseY: 0.22 };
  }
  if (hw === 'residential' || hw === 'living_street' || hw === 'unclassified' || hw === 'service') {
    const width = hw === 'service' ? 4.4 : 6.0;
    return { width, roadClass: 1, baseY: 0.16 };
  }
  const width = hw === 'pedestrian' ? 3.8 : 2.6;
  return { width, roadClass: 0, baseY: 0.10 };
}

function subdividePolylineXZ(pts: [number, number][], maxSegLen = 12): [number, number][] {
  if (pts.length < 2) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1];
    const [x1, z1] = pts[i];
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if (dist > maxSegLen) {
      const steps = Math.ceil(dist / maxSegLen);
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
      }
    }
    out.push([x1, z1]);
  }
  return out;
}

interface RoadVertexSample {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
}

function buildRoadsMesh(
  roads: RoadFeature[],
  material: THREE.Material,
  terrain: TerrainElevation
): THREE.Mesh | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const roadClasses: number[] = [];

  for (const road of roads) {
    const rawPts = road.coords.map(([lon, lat]) => projectToMeters(lon, lat));
    const pts = subdividePolylineXZ(rawPts, 12);
    if (pts.length < 2) continue;

    const { width, roadClass, baseY } = getRoadStyle(road);
    const halfW = width * 0.5;
    const isClosed =
      pts.length >= 4 &&
      Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.3;

    const leftPts: RoadVertexSample[] = [];
    const rightPts: RoadVertexSample[] = [];
    const cumDist: number[] = [0];

    for (let i = 1; i < pts.length; i++) {
      cumDist.push(
        cumDist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
      );
    }

    for (let i = 0; i < pts.length; i++) {
      let prevIdx = i - 1;
      let nextIdx = i + 1;
      if (isClosed) {
        if (i === 0) prevIdx = pts.length - 2;
        if (i === pts.length - 1) nextIdx = 1;
      }

      let tx = 0;
      let tz = 0;
      if (prevIdx >= 0 && nextIdx < pts.length) {
        const dx1 = pts[i][0] - pts[prevIdx][0];
        const dz1 = pts[i][1] - pts[prevIdx][1];
        const len1 = Math.hypot(dx1, dz1) || 1;
        const dx2 = pts[nextIdx][0] - pts[i][0];
        const dz2 = pts[nextIdx][1] - pts[i][1];
        const len2 = Math.hypot(dx2, dz2) || 1;
        tx = dx1 / len1 + dx2 / len2;
        tz = dz1 / len1 + dz2 / len2;
      } else if (nextIdx < pts.length) {
        tx = pts[nextIdx][0] - pts[i][0];
        tz = pts[nextIdx][1] - pts[i][1];
      } else if (prevIdx >= 0) {
        tx = pts[i][0] - pts[prevIdx][0];
        tz = pts[i][1] - pts[prevIdx][1];
      }

      const tLen = Math.hypot(tx, tz);
      if (tLen < 1e-4) {
        const fallbackIdx = i > 0 ? i - 1 : i + 1;
        tx = (pts[i][0] - pts[fallbackIdx][0]) * (i > 0 ? 1 : -1);
        tz = (pts[i][1] - pts[fallbackIdx][1]) * (i > 0 ? 1 : -1);
      }
      const normLen = Math.hypot(tx, tz) || 1;
      tx /= normLen;
      tz /= normLen;

      let nx = -tz;
      let nz = tx;

      if (prevIdx >= 0 && nextIdx < pts.length) {
        const dx1 = pts[i][0] - pts[prevIdx][0];
        const dz1 = pts[i][1] - pts[prevIdx][1];
        const len1 = Math.hypot(dx1, dz1) || 1;
        const n1x = -dz1 / len1;
        const n1z = dx1 / len1;
        const dot = nx * n1x + nz * n1z;
        const miter = dot > 0.55 ? Math.min(1.6, 1 / dot) : 1.0;
        nx *= miter;
        nz *= miter;
      }

      const lx = pts[i][0] - nx * halfW;
      const lz = pts[i][1] - nz * halfW;
      const ln = terrain.getNormalAtXZ(lx, lz);
      leftPts.push({
        x: lx,
        y: terrain.getHeightAtXZ(lx, lz) + baseY,
        z: lz,
        nx: ln[0],
        ny: ln[1],
        nz: ln[2],
      });

      const rx = pts[i][0] + nx * halfW;
      const rz = pts[i][1] + nz * halfW;
      const rn = terrain.getNormalAtXZ(rx, rz);
      rightPts.push({
        x: rx,
        y: terrain.getHeightAtXZ(rx, rz) + baseY,
        z: rz,
        nx: rn[0],
        ny: rn[1],
        nz: rn[2],
      });
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const l0 = leftPts[i];
      const r0 = rightPts[i];
      const l1 = leftPts[i + 1];
      const r1 = rightPts[i + 1];
      const v0 = cumDist[i];
      const v1 = cumDist[i + 1];

      positions.push(
        l0.x, l0.y, l0.z,
        r0.x, r0.y, r0.z,
        l1.x, l1.y, l1.z,
        r0.x, r0.y, r0.z,
        r1.x, r1.y, r1.z,
        l1.x, l1.y, l1.z
      );
      normals.push(
        l0.nx, l0.ny, l0.nz,
        r0.nx, r0.ny, r0.nz,
        l1.nx, l1.ny, l1.nz,
        r0.nx, r0.ny, r0.nz,
        r1.nx, r1.ny, r1.nz,
        l1.nx, l1.ny, l1.nz
      );

      for (let k = 0; k < 6; k++) {
        roadClasses.push(roadClass);
      }

      uvs.push(
        0, v0,
        1, v0,
        0, v1,
        1, v0,
        1, v1,
        0, v1
      );
    }
  }

  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute('aRoadClass', new THREE.Float32BufferAttribute(roadClasses, 1));

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'chunk-roads';
  mesh.receiveShadow = true;
  return mesh;
}

interface BuildingEmitBuffers {
  positions: number[];
  normals: number[];
  colors: number[];
  localHeights: number[];
  topDists: number[];
  roofTypes: number[];
}

function pushBuildingTri(
  buf: BuildingEmitBuffers,
  ax: number, ay: number, az: number, alh: number, atd: number,
  bx: number, by: number, bz: number, blh: number, btd: number,
  cx: number, cy: number, cz: number, clh: number, ctd: number,
  nx: number, ny: number, nz: number,
  cr: number, cg: number, cb: number,
  roofType: number
): void {
  buf.positions.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  buf.normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  buf.colors.push(cr, cg, cb, cr, cg, cb, cr, cg, cb);
  buf.localHeights.push(alh, blh, clh);
  buf.topDists.push(atd, btd, ctd);
  buf.roofTypes.push(roofType, roofType, roofType);
}

function pushBuildingAutoTri(
  buf: BuildingEmitBuffers,
  ax: number, ay: number, az: number, alh: number, atd: number,
  bx: number, by: number, bz: number, blh: number, btd: number,
  cx: number, cy: number, cz: number, clh: number, ctd: number,
  cr: number, cg: number, cb: number,
  roofType: number
): void {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const vx = cx - ax;
  const vy = cy - ay;
  const vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  nx /= len;
  ny /= len;
  nz /= len;
  pushBuildingTri(
    buf,
    ax, ay, az, alh, atd,
    bx, by, bz, blh, btd,
    cx, cy, cz, clh, ctd,
    nx, ny, nz,
    cr, cg, cb,
    roofType
  );
}

function pushWallQuad(
  buf: BuildingEmitBuffers,
  x0: number, z0: number,
  x1: number, z1: number,
  botY: number, topY: number,
  botLH: number, topLH: number,
  botTD: number, topTD: number,
  cr: number, cg: number, cb: number,
  roofType: number
): void {
  const dx = x1 - x0;
  const dz = z1 - z0;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return;
  const nx = -dz / len;
  const nz = dx / len;

  pushBuildingTri(
    buf,
    x0, botY, z0, botLH, botTD,
    x1, botY, z1, botLH, botTD,
    x1, topY, z1, topLH, topTD,
    nx, 0, nz,
    cr, cg, cb,
    roofType
  );
  pushBuildingTri(
    buf,
    x0, botY, z0, botLH, botTD,
    x1, topY, z1, topLH, topTD,
    x0, topY, z0, topLH, topTD,
    nx, 0, nz,
    cr, cg, cb,
    roofType
  );
}

function pointInVec2Ring(x: number, y: number, ring: THREE.Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].x;
    const yi = ring[i].y;
    const xj = ring[j].x;
    const yj = ring[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInParsedShapeXZ(
  x: number,
  z: number,
  outer: THREE.Vector2[],
  holes: THREE.Vector2[][]
): boolean {
  const y2 = -z;
  if (!pointInVec2Ring(x, y2, outer)) return false;
  for (const h of holes) {
    if (pointInVec2Ring(x, y2, h)) return false;
  }
  return true;
}

function computeStarMinApothem(outer: THREE.Vector2[], cx2: number, cy2: number): number {
  let minApothem = Infinity;
  const n = outer.length;
  for (let i = 0; i < n; i++) {
    const p0 = outer[i];
    const p1 = outer[(i + 1) % n];
    const edgeLen = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    if (edgeLen < 1e-4) continue;
    const cross = (p0.x - cx2) * (p1.y - cy2) - (p0.y - cy2) * (p1.x - cx2);
    const apothem = cross / edgeLen;
    if (apothem < minApothem) minApothem = apothem;
  }
  return minApothem;
}

function emitOrientedRooftopBox(
  buf: BuildingEmitBuffers,
  cx: number,
  cz: number,
  ux: number,
  uz: number,
  hu: number,
  hv: number,
  deckY: number,
  boxH: number,
  deckLocalH: number,
  outer: THREE.Vector2[],
  holes: THREE.Vector2[][],
  cr: number,
  cg: number,
  cb: number
): void {
  const vx = -uz;
  const vz = ux;
  const margin = 0.85;
  const corners: [number, number][] = [
    [cx - ux * hu + vx * hv, cz - uz * hu + vz * hv],
    [cx + ux * hu + vx * hv, cz + uz * hu + vz * hv],
    [cx + ux * hu - vx * hv, cz + uz * hu - vz * hv],
    [cx - ux * hu - vx * hv, cz - uz * hu - vz * hv],
  ];
  for (const [kx, kz] of corners) {
    const mx = cx + (kx - cx) * ((Math.max(hu, hv) + margin) / Math.max(hu, hv));
    const mz = cz + (kz - cz) * ((Math.max(hu, hv) + margin) / Math.max(hu, hv));
    if (!pointInParsedShapeXZ(mx, mz, outer, holes)) return;
  }

  const topY = deckY + boxH;
  const topLH = deckLocalH + boxH;
  for (let i = 0; i < 4; i++) {
    const p0 = corners[i];
    const p1 = corners[(i + 1) % 4];
    pushWallQuad(buf, p0[0], p0[1], p1[0], p1[1], deckY, topY, deckLocalH, topLH, boxH, 0, cr, cg, cb, 3);
  }
  pushBuildingTri(
    buf,
    corners[0][0], topY, corners[0][1], topLH, 5,
    corners[1][0], topY, corners[1][1], topLH, 5,
    corners[2][0], topY, corners[2][1], topLH, 5,
    0, 1, 0, cr, cg, cb, 3
  );
  pushBuildingTri(
    buf,
    corners[0][0], topY, corners[0][1], topLH, 5,
    corners[2][0], topY, corners[2][1], topLH, 5,
    corners[3][0], topY, corners[3][1], topLH, 5,
    0, 1, 0, cr, cg, cb, 3
  );
}

/**
 * Extrusor arquitectónico estilo Apple Maps DCE:
 * - Soporta `building:part`, `minHeight`, tejados reales OSM (`pyramidal`, `dome`, `mansard`,
 *   `hipped`, `gabled`, `skillion`) y azoteas con peto perimetral + casetones procedurales.
 */
function buildBuildingsMesh(
  buildings: ChunkPayload['buildings'],
  material: THREE.Material,
  terrain: TerrainElevation
): THREE.Mesh | null {
  const buf: BuildingEmitBuffers = {
    positions: [],
    normals: [],
    colors: [],
    localHeights: [],
    topDists: [],
    roofTypes: [],
  };
  const tempColor = new THREE.Color();

  for (const b of buildings) {
    const parsed = parsePolygonRings(b.rings);
    if (!parsed) continue;

    let roofTris: number[][];
    try {
      roofTris = THREE.ShapeUtils.triangulateShape(parsed.outer, parsed.holes);
    } catch {
      continue;
    }

    let sumBaseY = 0;
    let minRingY = Infinity;
    let sumX = 0;
    let sumY2 = 0;
    for (const pt of parsed.outer) {
      const py = terrain.getHeightAtXZ(pt.x, -pt.y);
      sumBaseY += py;
      if (py < minRingY) minRingY = py;
      sumX += pt.x;
      sumY2 += pt.y;
    }
    const baseY = sumBaseY / parsed.outer.length;
    const cx2 = sumX / parsed.outer.length;
    const cy2 = sumY2 / parsed.outer.length;
    const cx = cx2;
    const cz = -cy2;

    const minH = b.minHeight ?? 0;
    const totalH = b.height;
    const roofShape = b.roofShape;
    const hasCustomRoof = Boolean(roofShape && roofShape !== 'flat');
    const roofH = hasCustomRoof
      ? Math.min(Math.max(1.2, totalH - minH - 1.5), Math.max(1.2, b.roofHeight ?? 3.5))
      : 0;
    const wallTopLocal = hasCustomRoof ? Math.max(minH + 1.8, totalH - roofH) : totalH;
    const wallSpan = Math.max(1.0, wallTopLocal - minH);

    const botY = minH > 0.2 ? baseY + minH : Math.min(baseY, minRingY) - 3.0;
    const wallTopY = baseY + wallTopLocal;
    const peakY = wallTopY + roofH;
    const botLH = minH > 0.2 ? minH : 0;

    const hVal = hashString(b.id);
    const toneHex = PALETTE.buildingTones[Math.floor(hVal * PALETTE.buildingTones.length)];
    tempColor.setHex(toneHex);
    const shade = 0.96 + hashString(b.id + '_s') * 0.08;
    const cr = tempColor.r * shade;
    const cg = tempColor.g * shade;
    const cb = tempColor.b * shade;

    const allPts: THREE.Vector2[] = [...parsed.outer];
    for (const hole of parsed.holes) {
      for (const pt of hole) allPts.push(pt);
    }

    // 1. Muros verticales (anillo exterior CCW + huecos interiores CW)
    const rings = [parsed.outer, ...parsed.holes];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p0 = ring[i];
        const p1 = ring[(i + 1) % n];
        pushWallQuad(
          buf,
          p0.x, -p0.y,
          p1.x, -p1.y,
          botY, wallTopY,
          botLH, wallTopLocal,
          wallSpan, 0,
          cr, cg, cb,
          0
        );
      }
    }

    // Tapa inferior solo cuando el bloque vuela (minHeight > 0.2 m, p. ej. arcos o voladizos)
    if (minH > 0.2) {
      for (let t = 0; t < roofTris.length; t++) {
        const [ia, ib, ic] = roofTris[t];
        const a = allPts[ia];
        const bPt = allPts[ib];
        const c = allPts[ic];
        if (!a || !bPt || !c) continue;
        pushBuildingTri(
          buf,
          a.x, botY, -a.y, botLH, wallSpan,
          c.x, botY, -c.y, botLH, wallSpan,
          bPt.x, botY, -bPt.y, botLH, wallSpan,
          0, -1, 0, cr, cg, cb, 0
        );
      }
    }

    const area = Math.abs(signedArea2D(parsed.outer));
    const minApothem = parsed.holes.length === 0 ? computeStarMinApothem(parsed.outer, cx2, cy2) : -1;
    const isStarShaped = minApothem > 1.8 && pointInParsedShapeXZ(cx, cz, parsed.outer, parsed.holes);

    const emitFlatTriangles = (pts2d: THREE.Vector2[], tris: number[][], yLvl: number, lh: number, rType: number) => {
      for (let t = 0; t < tris.length; t++) {
        const [ia, ib, ic] = tris[t];
        const a = pts2d[ia];
        const bPt = pts2d[ib];
        const c = pts2d[ic];
        if (!a || !bPt || !c) continue;
        pushBuildingTri(
          buf,
          a.x, yLvl, -a.y, lh, 5,
          bPt.x, yLvl, -bPt.y, lh, 5,
          c.x, yLvl, -c.y, lh, 5,
          0, 1, 0, cr, cg, cb, rType
        );
      }
    };

    const emitStarInsetRoof = (insetScale: number, rTypeSlope: number, rTypeCap: number, withCap: boolean) => {
      const n = parsed.outer.length;
      const innerPts: THREE.Vector2[] = [];
      for (let i = 0; i < n; i++) {
        const p = parsed.outer[i];
        innerPts.push(new THREE.Vector2(cx2 + (p.x - cx2) * insetScale, cy2 + (p.y - cy2) * insetScale));
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const p0 = parsed.outer[i];
        const p1 = parsed.outer[j];
        const q0 = innerPts[i];
        const q1 = innerPts[j];
        pushBuildingAutoTri(
          buf,
          p0.x, wallTopY, -p0.y, wallTopLocal, 5,
          p1.x, wallTopY, -p1.y, wallTopLocal, 5,
          q1.x, peakY, -q1.y, wallTopLocal + roofH, 5,
          cr, cg, cb, rTypeSlope
        );
        pushBuildingAutoTri(
          buf,
          p0.x, wallTopY, -p0.y, wallTopLocal, 5,
          q1.x, peakY, -q1.y, wallTopLocal + roofH, 5,
          q0.x, peakY, -q0.y, wallTopLocal + roofH, 5,
          cr, cg, cb, rTypeSlope
        );
      }
      if (withCap) {
        try {
          const capTris = THREE.ShapeUtils.triangulateShape(innerPts, []);
          emitFlatTriangles(innerPts, capTris, peakY, wallTopLocal + roofH, rTypeCap);
        } catch {
          // Ignorar si polígono degenera al encoger
        }
      }
    };

    // 2. Cubierta real OSM o detalles procedurales Apple Maps
    if ((roofShape === 'pyramidal' || roofShape === 'round') && isStarShaped) {
      const n = parsed.outer.length;
      for (let i = 0; i < n; i++) {
        const p0 = parsed.outer[i];
        const p1 = parsed.outer[(i + 1) % n];
        pushBuildingAutoTri(
          buf,
          p0.x, wallTopY, -p0.y, wallTopLocal, 5,
          p1.x, wallTopY, -p1.y, wallTopLocal, 5,
          cx, peakY, cz, wallTopLocal + roofH, 5,
          cr, cg, cb, 2
        );
      }
    } else if (roofShape === 'dome' && isStarShaped) {
      const ringsR = [1.0, 0.72, 0.38];
      const ringsH = [0.0, 0.58, 0.90];
      const n = parsed.outer.length;
      const scaleRing = (rFrac: number, hFrac: number) => ({
        y: wallTopY + roofH * hFrac,
        lh: wallTopLocal + roofH * hFrac,
        pts: parsed.outer.map((p) => [cx + (p.x - cx) * rFrac, cz + (-p.y - cz) * rFrac] as [number, number]),
      });
      const r0 = scaleRing(ringsR[0], ringsH[0]);
      const r1 = scaleRing(ringsR[1], ringsH[1]);
      const r2 = scaleRing(ringsR[2], ringsH[2]);
      const pairs: [typeof r0, typeof r1][] = [[r0, r1], [r1, r2]];
      for (const [lo, hi] of pairs) {
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          pushBuildingAutoTri(
            buf,
            lo.pts[i][0], lo.y, lo.pts[i][1], lo.lh, 5,
            lo.pts[j][0], lo.y, lo.pts[j][1], lo.lh, 5,
            hi.pts[j][0], hi.y, hi.pts[j][1], hi.lh, 5,
            cr, cg, cb, 2
          );
          pushBuildingAutoTri(
            buf,
            lo.pts[i][0], lo.y, lo.pts[i][1], lo.lh, 5,
            hi.pts[j][0], hi.y, hi.pts[j][1], hi.lh, 5,
            hi.pts[i][0], hi.y, hi.pts[i][1], hi.lh, 5,
            cr, cg, cb, 2
          );
        }
      }
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        pushBuildingAutoTri(
          buf,
          r2.pts[i][0], r2.y, r2.pts[i][1], r2.lh, 5,
          r2.pts[j][0], r2.y, r2.pts[j][1], r2.lh, 5,
          cx, peakY, cz, wallTopLocal + roofH, 5,
          cr, cg, cb, 2
        );
      }
    } else if (roofShape === 'mansard' && isStarShaped) {
      const insetScale = 1 - Math.min(0.32, 2.1 / minApothem);
      emitStarInsetRoof(insetScale, 2, 1, true);
    } else if (roofShape === 'gabled' && parsed.outer.length === 4 && parsed.holes.length === 0) {
      const q = parsed.outer;
      const d01 = Math.hypot(q[1].x - q[0].x, q[1].y - q[0].y);
      const d12 = Math.hypot(q[2].x - q[1].x, q[2].y - q[1].y);
      const i0 = d01 <= d12 ? 0 : 1;
      const a0 = q[i0];
      const a1 = q[(i0 + 1) % 4];
      const b0 = q[(i0 + 2) % 4];
      const b1 = q[(i0 + 3) % 4];
      const ra: [number, number] = [(a0.x + a1.x) * 0.5, -(a0.y + a1.y) * 0.5];
      const rb: [number, number] = [(b0.x + b1.x) * 0.5, -(b0.y + b1.y) * 0.5];
      const peakLH = wallTopLocal + roofH;

      // 2 vertientes inclinadas
      pushBuildingAutoTri(buf, a1.x, wallTopY, -a1.y, wallTopLocal, 5, b0.x, wallTopY, -b0.y, wallTopLocal, 5, rb[0], peakY, rb[1], peakLH, 5, cr, cg, cb, 2);
      pushBuildingAutoTri(buf, a1.x, wallTopY, -a1.y, wallTopLocal, 5, rb[0], peakY, rb[1], peakLH, 5, ra[0], peakY, ra[1], peakLH, 5, cr, cg, cb, 2);
      pushBuildingAutoTri(buf, b1.x, wallTopY, -b1.y, wallTopLocal, 5, a0.x, wallTopY, -a0.y, wallTopLocal, 5, ra[0], peakY, ra[1], peakLH, 5, cr, cg, cb, 2);
      pushBuildingAutoTri(buf, b1.x, wallTopY, -b1.y, wallTopLocal, 5, ra[0], peakY, ra[1], peakLH, 5, rb[0], peakY, rb[1], peakLH, 5, cr, cg, cb, 2);

      // 2 piñones triangulares de fachada
      pushBuildingAutoTri(buf, a0.x, wallTopY, -a0.y, wallTopLocal, wallSpan * 0.2, a1.x, wallTopY, -a1.y, wallTopLocal, wallSpan * 0.2, ra[0], peakY, ra[1], peakLH, 0, cr, cg, cb, 0);
      pushBuildingAutoTri(buf, b0.x, wallTopY, -b0.y, wallTopLocal, wallSpan * 0.2, b1.x, wallTopY, -b1.y, wallTopLocal, wallSpan * 0.2, rb[0], peakY, rb[1], peakLH, 0, cr, cg, cb, 0);
    } else if ((roofShape === 'hipped' || roofShape === 'gabled') && isStarShaped) {
      emitStarInsetRoof(0.42, 2, 2, true);
    } else {
      // Azotea plana: añadir peto perimetral si es polígono estrellado limpio (<= 10 vértices)
      let deckY = wallTopY;
      let deckLH = wallTopLocal;
      const canParapet = isStarShaped && parsed.outer.length <= 10 && area >= 70 && wallTopLocal >= 6.0;
      if (canParapet) {
        const rimH = 0.45;
        const rimTopY = wallTopY + rimH;
        const recessY = wallTopY - 0.10;
        const scale = 1 - Math.min(0.16, 0.72 / minApothem);
        const innerPts = parsed.outer.map(
          (p) => new THREE.Vector2(cx2 + (p.x - cx2) * scale, cy2 + (p.y - cy2) * scale)
        );
        const n = parsed.outer.length;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          const p0 = parsed.outer[i];
          const p1 = parsed.outer[j];
          const q0 = innerPts[i];
          const q1 = innerPts[j];
          // Cara exterior del peto
          pushWallQuad(buf, p0.x, -p0.y, p1.x, -p1.y, wallTopY, rimTopY, wallTopLocal, wallTopLocal + rimH, rimH, 0, cr, cg, cb, 3);
          // Coronación horizontal del peto
          pushBuildingTri(
            buf,
            p0.x, rimTopY, -p0.y, wallTopLocal + rimH, 5,
            p1.x, rimTopY, -p1.y, wallTopLocal + rimH, 5,
            q1.x, rimTopY, -q1.y, wallTopLocal + rimH, 5,
            0, 1, 0, cr, cg, cb, 3
          );
          pushBuildingTri(
            buf,
            p0.x, rimTopY, -p0.y, wallTopLocal + rimH, 5,
            q1.x, rimTopY, -q1.y, wallTopLocal + rimH, 5,
            q0.x, rimTopY, -q0.y, wallTopLocal + rimH, 5,
            0, 1, 0, cr, cg, cb, 3
          );
          // Cara interior del peto hacia la azotea rebajada (winding invertido q1 -> q0)
          pushWallQuad(buf, q1.x, -q1.y, q0.x, -q0.y, recessY, rimTopY, wallTopLocal - 0.1, wallTopLocal + rimH, rimH + 0.1, 0, cr, cg, cb, 0);
        }
        try {
          const innerTris = THREE.ShapeUtils.triangulateShape(innerPts, []);
          emitFlatTriangles(innerPts, innerTris, recessY, wallTopLocal - 0.1, 1);
          deckY = recessY;
          deckLH = wallTopLocal - 0.1;
        } catch {
          emitFlatTriangles(allPts, roofTris, wallTopY, wallTopLocal, 1);
        }
      } else {
        emitFlatTriangles(allPts, roofTris, wallTopY, wallTopLocal, 1);
      }

      // Casetones / lucernarios procedurales en azoteas medianas y grandes
      if (area >= 95 && wallTopLocal >= 7.0) {
        let bestLenSq = 0;
        let ux = 1;
        let uz = 0;
        for (let i = 0; i < parsed.outer.length; i++) {
          const p0 = parsed.outer[i];
          const p1 = parsed.outer[(i + 1) % parsed.outer.length];
          const dx = p1.x - p0.x;
          const dz = -(p1.y - p0.y);
          const lSq = dx * dx + dz * dz;
          if (lSq > bestLenSq) {
            bestLenSq = lSq;
            const len = Math.sqrt(lSq) || 1;
            ux = dx / len;
            uz = dz / len;
          }
        }
        const vx = -uz;
        const vz = ux;
        let minU = Infinity;
        let maxU = -Infinity;
        let minV = Infinity;
        let maxV = -Infinity;
        for (const p of parsed.outer) {
          const px = p.x - cx;
          const pz = -p.y - cz;
          const u = px * ux + pz * uz;
          const v = px * vx + pz * vz;
          if (u < minU) minU = u;
          if (u > maxU) maxU = u;
          if (v < minV) minV = v;
          if (v > maxV) maxV = v;
        }
        const spanU = maxU - minU;
        const spanV = maxV - minV;
        if (spanU >= 8 && spanV >= 7) {
          const r1 = hashString(b.id + '_c1');
          const r2 = hashString(b.id + '_c2');
          const offU = (r1 - 0.5) * Math.min(4.5, spanU * 0.22);
          const offV = (r2 - 0.5) * Math.min(4.0, spanV * 0.22);
          const hu = Math.min(2.6, Math.max(1.4, spanU * 0.12));
          const hv = Math.min(2.2, Math.max(1.2, spanV * 0.13));
          const casH = 1.9 + r1 * 1.1;
          emitOrientedRooftopBox(
            buf,
            cx + ux * offU + vx * offV,
            cz + uz * offU + vz * offV,
            ux, uz, hu, hv, deckY, casH, deckLH,
            parsed.outer, parsed.holes, cr, cg, cb
          );
          if (area >= 280) {
            const offU2 = -offU + (r2 - 0.5) * 2.5;
            const offV2 = -offV * 0.5;
            emitOrientedRooftopBox(
              buf,
              cx + ux * offU2 + vx * offV2,
              cz + uz * offU2 + vz * offV2,
              ux, uz, Math.min(2.0, hu * 0.85), Math.min(1.5, hv * 0.78),
              deckY, 0.95 + r2 * 0.55, deckLH,
              parsed.outer, parsed.holes, cr, cg, cb
            );
          }
        }
      }
    }
  }

  if (buf.positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(buf.positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(buf.colors, 3));
  geom.setAttribute('aLocalHeight', new THREE.Float32BufferAttribute(buf.localHeights, 1));
  geom.setAttribute('aTopDist', new THREE.Float32BufferAttribute(buf.topDists, 1));
  geom.setAttribute('aRoofType', new THREE.Float32BufferAttribute(buf.roofTypes, 1));

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'chunk-buildings';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function pointInRingXZ(x: number, z: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const zi = ring[i][1];
    const xj = ring[j][0];
    const zj = ring[j][1];
    const intersect = zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function buildChunkTrees(
  data: ChunkPayload,
  resources: SharedCityResources,
  terrain: TerrainElevation
): { treesMesh: THREE.InstancedMesh | null; count: number } {
  const MAX_TREES_PER_CHUNK = 180;
  const records: { x: number; z: number; scale: number; rotY: number }[] = [];
  const cellSize = 9.0;
  const minDistSq = 8.5 * 8.5;
  const grid = new Map<string, [number, number][]>();

  function tryAddTree(x: number, z: number, seedKey: string): void {
    if (records.length >= MAX_TREES_PER_CHUNK) return;

    const cx = Math.floor(x / cellSize);
    const cz = Math.floor(z / cellSize);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = grid.get(`${cx + dx},${cz + dz}`);
        if (!list) continue;
        for (const [ox, oz] of list) {
          if ((x - ox) ** 2 + (z - oz) ** 2 < minDistSq) return;
        }
      }
    }

    const key = `${cx},${cz}`;
    const cell = grid.get(key) || [];
    cell.push([x, z]);
    grid.set(key, cell);

    const h1 = hashString(seedKey);
    const h2 = hashString(seedKey + '_r');
    records.push({
      x,
      z,
      scale: 0.78 + h1 * 0.5,
      rotY: h2 * Math.PI * 2,
    });
  }

  // 1. Árboles reales de OSM
  for (let i = 0; i < data.trees.length; i++) {
    const [x, z] = projectToMeters(data.trees[i][0], data.trees[i][1]);
    tryAddTree(x, z, `osm_${data.key}_${i}`);
  }

  // 2. Arbolado en avenidas principales
  for (const road of data.roads) {
    if (records.length >= MAX_TREES_PER_CHUNK) break;
    if (road.highway !== 'trunk' && road.highway !== 'primary') continue;
    const pts = road.coords.map(([lon, lat]) => projectToMeters(lon, lat));
    const { width } = getRoadStyle(road);
    const offsetDist = width * 0.5 + 2.5;

    let accum = 0;
    const step = 20.0;
    for (let i = 1; i < pts.length; i++) {
      const [x0, z0] = pts[i - 1];
      const [x1, z1] = pts[i];
      const segLen = Math.hypot(x1 - x0, z1 - z0);
      if (segLen < 1) continue;
      const ux = (x1 - x0) / segLen;
      const uz = (z1 - z0) / segLen;
      const nx = -uz;
      const nz = ux;

      while (accum < segLen) {
        const bx = x0 + ux * accum;
        const bz = z0 + uz * accum;
        tryAddTree(bx + nx * offsetDist, bz + nz * offsetDist, `${road.id}_L_${Math.round(bx)}_${Math.round(bz)}`);
        tryAddTree(bx - nx * offsetDist, bz - nz * offsetDist, `${road.id}_R_${Math.round(bx)}_${Math.round(bz)}`);
        accum += step;
      }
      accum -= segLen;
    }
  }

  // 3. Arbolado disperso en parques (spacing 26 m)
  const spacing = 26.0;
  for (const park of data.parks) {
    if (records.length >= MAX_TREES_PER_CHUNK) break;
    const outer = park.rings[0].map(([lon, lat]) => projectToMeters(lon, lat));
    if (outer.length < 3) continue;
    const holes = park.rings.slice(1).map((r) => r.map(([lon, lat]) => projectToMeters(lon, lat)));

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const [px, pz] of outer) {
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (pz < minZ) minZ = pz;
      if (pz > maxZ) maxZ = pz;
    }
    if ((maxX - minX) * (maxZ - minZ) < 280) continue;

    for (let gx = minX + 6; gx < maxX - 6; gx += spacing) {
      for (let gz = minZ + 6; gz < maxZ - 6; gz += spacing) {
        if (records.length >= MAX_TREES_PER_CHUNK) break;
        const jx = gx + (hashString(`jx_${gx}_${gz}`) - 0.5) * 10.0;
        const jz = gz + (hashString(`jz_${gx}_${gz}`) - 0.5) * 10.0;
        if (!pointInRingXZ(jx, jz, outer)) continue;
        if (holes.some((h) => pointInRingXZ(jx, jz, h))) continue;
        tryAddTree(jx, jz, `pk_${park.id}_${Math.round(jx)}_${Math.round(jz)}`);
      }
    }
  }

  if (records.length === 0) {
    return { treesMesh: null, count: 0 };
  }

  const treesMesh = new THREE.InstancedMesh(
    resources.treePrototype,
    resources.treeMaterial,
    records.length
  );
  treesMesh.name = 'chunk-trees';
  treesMesh.castShadow = false;
  treesMesh.receiveShadow = true;

  const dummy = new THREE.Object3D();
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    const groundY = terrain.getHeightAtXZ(rec.x, rec.z);
    dummy.position.set(rec.x, groundY - 0.05, rec.z);
    dummy.rotation.set(0, rec.rotY, 0);
    dummy.scale.setScalar(rec.scale);
    dummy.updateMatrix();
    treesMesh.setMatrixAt(i, dummy.matrix);
  }
  treesMesh.instanceMatrix.needsUpdate = true;

  return { treesMesh, count: records.length };
}

export function buildChunkGroup(
  data: ChunkPayload,
  resources: SharedCityResources,
  terrain: TerrainElevation
): ChunkBuildResult {
  const group = new THREE.Group();
  group.name = `chunk_${data.key}`;

  const parks = buildPolygonSurfaceMesh(data.parks, 0.03, resources.parkMaterial, 'chunk-parks', terrain, 24);
  if (parks) group.add(parks);

  const water = buildPolygonSurfaceMesh(data.water, 0.24, resources.waterMaterial, 'chunk-water', terrain, 20);
  if (water) group.add(water);

  const roads = buildRoadsMesh(data.roads, resources.roadMaterial, terrain);
  if (roads) group.add(roads);

  const buildings = buildBuildingsMesh(data.buildings, resources.buildingMaterial, terrain);
  if (buildings) group.add(buildings);

  const { treesMesh, count: treesCount } = buildChunkTrees(data, resources, terrain);
  if (treesMesh) group.add(treesMesh);

  return {
    group,
    buildingsCount: data.buildings.length,
    treesCount,
  };
}

export function disposeChunkGroup(
  group: THREE.Group,
  resources: SharedCityResources
): void {
  for (const child of group.children) {
    if (child instanceof THREE.Mesh) {
      const geom = child.geometry;
      if (geom !== resources.treePrototype) {
        geom.dispose();
      }
    }
  }
}
