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
 * Prototipo de árbol ultra-ligero (~90 triángulos totales) en 1 sola geometría:
 * cilindro de 5 caras para el tronco (aIsCrown = 0) + 1 icosaedro subdividido nivel 1 para la copa (aIsCrown = 1).
 */
function createCombinedTreePrototype(): THREE.BufferGeometry {
  const trunkRaw = new THREE.CylinderGeometry(0.14, 0.22, 1.85, 5, 1, false);
  trunkRaw.translate(0, 0.925, 0);
  const trunk = trunkRaw.index ? trunkRaw.toNonIndexed() : trunkRaw;
  if (trunk !== trunkRaw) trunkRaw.dispose();
  trunk.deleteAttribute('uv');
  const trunkCount = trunk.getAttribute('position').count;
  trunk.setAttribute('aIsCrown', new THREE.Float32BufferAttribute(new Float32Array(trunkCount).fill(0), 1));

  const crownRaw = new THREE.IcosahedronGeometry(1.55, 1);
  crownRaw.scale(1.0, 0.84, 1.0);
  crownRaw.translate(0, 3.05, 0);
  const crown = crownRaw.index ? crownRaw.toNonIndexed() : crownRaw;
  if (crown !== crownRaw) crownRaw.dispose();
  crown.deleteAttribute('uv');
  const crownCount = crown.getAttribute('position').count;
  crown.setAttribute('aIsCrown', new THREE.Float32BufferAttribute(new Float32Array(crownCount).fill(1), 1));

  const merged = mergeGeometries([trunk, crown], false);
  trunk.dispose();
  crown.dispose();
  if (!merged) return crown;
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

/**
 * Extrusor directo de edificios adaptado al relieve real con faldón de cimentación enterrado.
 */
function buildBuildingsMesh(
  buildings: ChunkPayload['buildings'],
  material: THREE.Material,
  terrain: TerrainElevation
): THREE.Mesh | null {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const localHeights: number[] = [];
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
    for (const pt of parsed.outer) {
      const py = terrain.getHeightAtXZ(pt.x, -pt.y);
      sumBaseY += py;
      if (py < minRingY) minRingY = py;
    }
    const baseY = sumBaseY / parsed.outer.length;
    const h = b.height;
    const roofY = baseY + h;
    const botY = Math.min(baseY, minRingY) - 3.0;

    const hVal = hashString(b.id);
    const toneHex = PALETTE.buildingTones[Math.floor(hVal * PALETTE.buildingTones.length)];
    tempColor.setHex(toneHex);
    const shade = 0.96 + hashString(b.id + '_s') * 0.08;
    const cr = tempColor.r * shade;
    const cg = tempColor.g * shade;
    const cb = tempColor.b * shade;

    // 1. Tejado superior (y = baseY + h, normal = +Y)
    const allPts: THREE.Vector2[] = [...parsed.outer];
    for (const hole of parsed.holes) {
      for (const pt of hole) allPts.push(pt);
    }

    for (let t = 0; t < roofTris.length; t++) {
      const [ia, ib, ic] = roofTris[t];
      const a = allPts[ia];
      const bPt = allPts[ib];
      const c = allPts[ic];
      if (!a || !bPt || !c) continue;

      positions.push(
        a.x, roofY, -a.y,
        bPt.x, roofY, -bPt.y,
        c.x, roofY, -c.y
      );
      normals.push(0, 1, 0, 0, 1, 0, 0, 1, 0);
      colors.push(cr, cg, cb, cr, cg, cb, cr, cg, cb);
      localHeights.push(h, h, h);
    }

    // 2. Muros verticales (anillo exterior CCW + huecos interiores CW) con cimentación en pendiente
    const rings = [parsed.outer, ...parsed.holes];
    for (const ring of rings) {
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p0 = ring[i];
        const p1 = ring[(i + 1) % n];

        const x0 = p0.x;
        const z0 = -p0.y;
        const x1 = p1.x;
        const z1 = -p1.y;

        const dx = x1 - x0;
        const dz = z1 - z0;
        const len = Math.hypot(dx, dz);
        if (len < 1e-4) continue;

        const nx = -dz / len;
        const nz = dx / len;

        positions.push(
          x0, botY, z0,
          x1, botY, z1,
          x1, roofY, z1,
          x0, botY, z0,
          x1, roofY, z1,
          x0, roofY, z0
        );
        for (let k = 0; k < 6; k++) {
          normals.push(nx, 0, nz);
          colors.push(cr, cg, cb);
        }
        localHeights.push(0, 0, h, 0, h, h);
      }
    }
  }

  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geom.setAttribute('aLocalHeight', new THREE.Float32BufferAttribute(localHeights, 1));

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
