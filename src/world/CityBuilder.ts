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
import {
  createMadridFacadeArrays,
  createMadridRoadTextures,
} from '../materials/MadridTextureAtlas';
import type { ChunkPayload, PolygonFeature, RoadFeature } from '../types/mapData';
import { PnoaOrthoClipmap } from './PnoaOrthoClipmap';

export interface SharedCityResources {
  groundMaterial: THREE.MeshStandardNodeMaterial;
  parkMaterial: THREE.MeshStandardNodeMaterial;
  waterMaterial: THREE.MeshStandardNodeMaterial;
  roadMaterial: THREE.MeshStandardNodeMaterial;
  buildingMaterial: THREE.MeshStandardNodeMaterial;
  treeMaterial: THREE.MeshStandardNodeMaterial;
  treePrototype: THREE.BufferGeometry;
  orthoClipmap: PnoaOrthoClipmap;
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
  const orthoClipmap = new PnoaOrthoClipmap();
  const facades = createMadridFacadeArrays();
  const roadTex = createMadridRoadTextures();

  return {
    groundMaterial: createGroundMaterial(orthoClipmap),
    parkMaterial: createParkMaterial(orthoClipmap),
    waterMaterial: createWaterMaterial(),
    roadMaterial: createRoadMaterial(roadTex),
    buildingMaterial: createBuildingMaterial(orthoClipmap, facades),
    treeMaterial: createTreeMaterial(),
    treePrototype: createCombinedTreePrototype(),
    orthoClipmap,
  };
}

export function buildBaseGroundMesh(
  resources: SharedCityResources,
  terrain: TerrainElevation
): THREE.Mesh {
  const [minLon, minLat, maxLon, maxLat] = terrain.bbox;
  const [minX, maxZ] = projectToMeters(minLon, minLat);
  const [maxX, minZ] = projectToMeters(maxLon, maxLat);

  const marginM = 1200;
  const widthM = Math.max(4000, maxX - minX + marginM * 2);
  const depthM = Math.max(4000, maxZ - minZ + marginM * 2);
  const centerX = (minX + maxX) * 0.5;
  const centerZ = (minZ + maxZ) * 0.5;

  const segsX = Math.min(300, Math.max(120, Math.round(widthM / 36)));
  const segsZ = Math.min(380, Math.max(120, Math.round(depthM / 36)));

  const geom = new THREE.PlaneGeometry(widthM, depthM, segsX, segsZ);
  geom.rotateX(-Math.PI / 2);
  geom.translate(centerX, 0, centerZ);

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

interface RoadStyleInfo {
  width: number;
  roadClass: number;
  laneCount: number;
  baseY: number;
}

function getRoadStyle(road: RoadFeature, roadIdx = 0): RoadStyleInfo {
  const hw = road.highway;
  const stagger = (roadIdx % 19) * 0.0008;

  if (hw === 'motorway' || hw === 'motorway_link') {
    const width = hw === 'motorway_link' ? 7.5 : road.lanes >= 4 ? 14.5 : 11.5;
    const laneCount = hw === 'motorway_link' ? 0 : road.lanes >= 4 ? 3 : 2;
    return { width, roadClass: 3, laneCount, baseY: 0.255 + stagger };
  }

  if (hw === 'trunk' || hw === 'primary' || hw === 'primary_link') {
    const width = road.oneway
      ? road.lanes >= 4
        ? 13.5
        : road.lanes === 3
          ? 11.2
          : 9.0
      : road.lanes >= 4
        ? 17.5
        : 14.0;
    const laneCount = road.oneway
      ? road.lanes >= 4
        ? 3
        : road.lanes === 3
          ? 2
          : 1
      : road.lanes >= 4
        ? 3
        : 1;
    return { width, roadClass: 3, laneCount, baseY: 0.25 + stagger };
  }

  if (hw === 'secondary' || hw === 'secondary_link' || hw === 'tertiary' || hw === 'tertiary_link') {
    const width = road.oneway ? (road.lanes >= 3 ? 9.8 : 7.6) : 9.4;
    const laneCount = road.oneway ? (road.lanes >= 3 ? 2 : 1) : 1;
    return { width, roadClass: 2, laneCount, baseY: 0.21 + stagger };
  }

  if (hw === 'residential' || hw === 'living_street' || hw === 'unclassified' || hw === 'service') {
    const width = hw === 'service' ? 4.2 : 6.0;
    return { width, roadClass: 1, laneCount: 0, baseY: 0.17 + stagger };
  }

  const width = hw === 'pedestrian' ? 4.2 : 2.5;
  return { width, roadClass: 0, laneCount: 0, baseY: 0.11 + stagger * 0.5 };
}

function subdividePolylineXZ(pts: [number, number][], maxSegLen = 10): [number, number][] {
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

interface JunctionHub {
  cx: number;
  cz: number;
  hubRadius: number;
  maxHalfW: number;
  maxRoadClass: number;
}

function refinePolylineNearJunctions(
  pts: [number, number][],
  junctions: JunctionHub[]
): [number, number][] {
  if (pts.length < 2 || junctions.length === 0) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, z0] = pts[i - 1];
    const [x1, z1] = pts[i];
    const segLen = Math.hypot(x1 - x0, z1 - z0);
    if (segLen > 2.4) {
      const mx = (x0 + x1) * 0.5;
      const mz = (z0 + z1) * 0.5;
      const reach = segLen * 0.5 + 18;
      let near = false;
      for (let j = 0; j < junctions.length; j++) {
        const jc = junctions[j];
        if (Math.hypot(mx - jc.cx, mz - jc.cz) < jc.hubRadius + reach) {
          near = true;
          break;
        }
      }
      if (near) {
        const steps = Math.ceil(segLen / 2.2);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
        }
      }
    }
    out.push([x1, z1]);
  }
  return out;
}

function segIntersectXZ(
  ax: number, az: number, bx: number, bz: number,
  cx: number, cz: number, dx: number, dz: number
): [number, number] | null {
  const rx = bx - ax;
  const rz = bz - az;
  const sx = dx - cx;
  const sz = dz - cz;
  const denom = rx * sz - rz * sx;
  if (Math.abs(denom) < 1e-6) return null;
  const qpx = cx - ax;
  const qpz = cz - az;
  const t = (qpx * sz - qpz * sx) / denom;
  const u = (qpx * rz - qpz * rx) / denom;
  if (t >= 0.02 && t <= 0.98 && u >= 0.02 && u <= 0.98) {
    return [ax + t * rx, az + t * rz];
  }
  return null;
}

interface JunctionNodeCluster {
  xSum: number;
  zSum: number;
  count: number;
  angles: number[];
  roadIds: Set<number>;
  maxHalfW: number;
  maxClass: number;
  minClass: number;
}

function addLegAngle(angles: number[], dx: number, dz: number): void {
  const len = Math.hypot(dx, dz);
  if (len < 0.05) return;
  const ang = Math.atan2(dz, dx);
  for (let i = 0; i < angles.length; i++) {
    let diff = Math.abs(ang - angles[i]);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff < 0.38) return; // < ~22°, misma dirección
  }
  angles.push(ang);
}

interface RoadVertexSample {
  x: number;
  z: number;
  nx: number;
  nz: number;
}

function pushJunctionDisc(
  cx: number,
  cz: number,
  radius: number,
  yOffset: number,
  roadClass: number,
  terrain: TerrainElevation,
  positions: number[],
  normals: number[],
  uvs: number[],
  roadClasses: number[],
  laneCounts: number[],
  markMasks: number[],
  crosswalks: number[]
): void {
  const segs = 12;
  const cy = terrain.getHeightAtXZ(cx, cz) + yOffset;
  const cn = terrain.getNormalAtXZ(cx, cz);

  for (let i = 0; i < segs; i++) {
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const x0 = cx + Math.cos(a0) * radius;
    const z0 = cz + Math.sin(a0) * radius;
    const x1 = cx + Math.cos(a1) * radius;
    const z1 = cz + Math.sin(a1) * radius;

    const y0 = terrain.getHeightAtXZ(x0, z0) + yOffset;
    const y1 = terrain.getHeightAtXZ(x1, z1) + yOffset;
    const n0 = terrain.getNormalAtXZ(x0, z0);
    const n1 = terrain.getNormalAtXZ(x1, z1);

    positions.push(cx, cy, cz, x1, y1, z1, x0, y0, z0);
    normals.push(
      cn[0], cn[1], cn[2],
      n1[0], n1[1], n1[2],
      n0[0], n0[1], n0[2]
    );
    uvs.push(0.5, 0, 0.5, 0, 0.5, 0);
    for (let k = 0; k < 3; k++) {
      roadClasses.push(roadClass);
      laneCounts.push(0);
      markMasks.push(0);
      crosswalks.push(0);
    }
  }
}

function segDistSqXZ(
  px: number, pz: number,
  ax: number, az: number,
  bx: number, bz: number
): number {
  const vx = bx - ax;
  const vz = bz - az;
  const lenSq = vx * vx + vz * vz;
  if (lenSq < 1e-8) {
    const dx = px - ax;
    const dz = pz - az;
    return dx * dx + dz * dz;
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / lenSq));
  const cx = ax + t * vx;
  const cz = az + t * vz;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
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
  const laneCounts: number[] = [];
  const markMasks: number[] = [];
  const crosswalks: number[] = [];

  interface PreparedRoad {
    roadIdx: number;
    rawPts: [number, number][];
    totalLen: number;
    style: RoadStyleInfo;
    isClosed: boolean;
    isRoundabout: boolean;
  }

  const prepared: PreparedRoad[] = [];
  for (let idx = 0; idx < roads.length; idx++) {
    const road = roads[idx];
    const rawPts = road.coords.map(([lon, lat]) => projectToMeters(lon, lat));
    if (rawPts.length < 2) continue;

    let totalLen = 0;
    let totalAbsTurn = 0;
    for (let i = 1; i < rawPts.length; i++) {
      totalLen += Math.hypot(rawPts[i][0] - rawPts[i - 1][0], rawPts[i][1] - rawPts[i - 1][1]);
      if (i >= 2) {
        const dx0 = rawPts[i - 1][0] - rawPts[i - 2][0];
        const dz0 = rawPts[i - 1][1] - rawPts[i - 2][1];
        const dx1 = rawPts[i][0] - rawPts[i - 1][0];
        const dz1 = rawPts[i][1] - rawPts[i - 1][1];
        const l0 = Math.hypot(dx0, dz0);
        const l1 = Math.hypot(dx1, dz1);
        if (l0 > 0.2 && l1 > 0.2) {
          const dot = Math.max(-1, Math.min(1, (dx0 * dx1 + dz0 * dz1) / (l0 * l1)));
          totalAbsTurn += Math.acos(dot);
        }
      }
    }
    const isClosed =
      rawPts.length >= 4 &&
      Math.hypot(rawPts[0][0] - rawPts[rawPts.length - 1][0], rawPts[0][1] - rawPts[rawPts.length - 1][1]) < 0.5;
    const isRoundaboutArc = road.oneway && totalLen < 180 && totalAbsTurn > 0.55;
    const isRoundabout = (isClosed && totalLen < 420) || isRoundaboutArc;

    prepared.push({
      roadIdx: idx,
      rawPts,
      totalLen,
      style: getRoadStyle(road, idx),
      isClosed,
      isRoundabout,
    });
  }

  // 1. Detectar intersecciones entre vías rodadas (nodos compartidos + cruces 2D)
  const clusterMap = new Map<string, JunctionNodeCluster>();
  const CELL_CLUSTER = 1.6;

  interface DriveSeg {
    roadIdx: number;
    halfW: number;
    roadClass: number;
    ax: number;
    az: number;
    bx: number;
    bz: number;
    dirX: number;
    dirZ: number;
    minX: number;
    maxX: number;
    minZ: number;
    maxZ: number;
  }
  const driveSegs: DriveSeg[] = [];

  for (const pr of prepared) {
    if (pr.style.roadClass < 1) continue;
    const halfW = pr.style.width * 0.5;
    const pts = pr.rawPts;

    for (let i = 0; i < pts.length; i++) {
      const [x, z] = pts[i];
      const kx = Math.round(x / CELL_CLUSTER);
      const kz = Math.round(z / CELL_CLUSTER);
      const key = `${kx}_${kz}`;
      let cluster = clusterMap.get(key);
      if (!cluster) {
        cluster = {
          xSum: 0,
          zSum: 0,
          count: 0,
          angles: [],
          roadIds: new Set<number>(),
          maxHalfW: halfW,
          maxClass: pr.style.roadClass,
          minClass: pr.style.roadClass,
        };
        clusterMap.set(key, cluster);
      }
      cluster.xSum += x;
      cluster.zSum += z;
      cluster.count++;
      cluster.roadIds.add(pr.roadIdx);
      if (halfW > cluster.maxHalfW) cluster.maxHalfW = halfW;
      if (pr.style.roadClass > cluster.maxClass) cluster.maxClass = pr.style.roadClass;
      if (pr.style.roadClass < cluster.minClass) cluster.minClass = pr.style.roadClass;

      if (i > 0) {
        addLegAngle(cluster.angles, pts[i - 1][0] - x, pts[i - 1][1] - z);
      }
      if (i < pts.length - 1) {
        addLegAngle(cluster.angles, pts[i + 1][0] - x, pts[i + 1][1] - z);
      }
    }

    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0];
      const az = pts[i][1];
      const bx = pts[i + 1][0];
      const bz = pts[i + 1][1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      driveSegs.push({
        roadIdx: pr.roadIdx,
        halfW,
        roadClass: pr.style.roadClass,
        ax,
        az,
        bx,
        bz,
        dirX: (bx - ax) / len,
        dirZ: (bz - az) / len,
        minX: Math.min(ax, bx),
        maxX: Math.max(ax, bx),
        minZ: Math.min(az, bz),
        maxZ: Math.max(az, bz),
      });
    }
  }

  const rawJunctions: JunctionHub[] = [];
  for (const cl of clusterMap.values()) {
    const legCount = cl.angles.length;
    const isMultiRoadSplit =
      cl.roadIds.size >= 2 && (legCount >= 3 || cl.maxClass > cl.minClass);
    if (legCount >= 3 || isMultiRoadSplit) {
      const hubRadius = Math.min(15.0, Math.max(4.8, cl.maxHalfW * 1.25 + 1.8));
      rawJunctions.push({
        cx: cl.xSum / cl.count,
        cz: cl.zSum / cl.count,
        hubRadius,
        maxHalfW: cl.maxHalfW,
        maxRoadClass: cl.maxClass,
      });
    }
  }

  // Cruces 2D entre segmentos sin nodo compartido (ej. calzadas dobles cruzándose)
  const CROSS_CELL = 24;
  const segGrid = new Map<string, number[]>();
  for (let i = 0; i < driveSegs.length; i++) {
    const s = driveSegs[i];
    const cMinX = Math.floor(s.minX / CROSS_CELL);
    const cMaxX = Math.floor(s.maxX / CROSS_CELL);
    const cMinZ = Math.floor(s.minZ / CROSS_CELL);
    const cMaxZ = Math.floor(s.maxZ / CROSS_CELL);
    for (let gx = cMinX; gx <= cMaxX; gx++) {
      for (let gz = cMinZ; gz <= cMaxZ; gz++) {
        const k = `${gx}_${gz}`;
        let arr = segGrid.get(k);
        if (!arr) {
          arr = [];
          segGrid.set(k, arr);
        }
        arr.push(i);
      }
    }
  }

  const testedPairs = new Set<number>();
  const nSegs = driveSegs.length;
  for (const bucket of segGrid.values()) {
    for (let i = 0; i < bucket.length; i++) {
      const ia = bucket[i];
      const a = driveSegs[ia];
      for (let j = i + 1; j < bucket.length; j++) {
        const ib = bucket[j];
        const b = driveSegs[ib];
        if (a.roadIdx === b.roadIdx) continue;
        if (
          a.maxX < b.minX ||
          a.minX > b.maxX ||
          a.maxZ < b.minZ ||
          a.minZ > b.maxZ
        ) {
          continue;
        }
        const pairKey = ia < ib ? ia * nSegs + ib : ib * nSegs + ia;
        if (testedPairs.has(pairKey)) continue;
        testedPairs.add(pairKey);

        const hit = segIntersectXZ(a.ax, a.az, a.bx, a.bz, b.ax, b.az, b.bx, b.bz);
        if (hit) {
          const maxHalfW = Math.max(a.halfW, b.halfW);
          rawJunctions.push({
            cx: hit[0],
            cz: hit[1],
            hubRadius: Math.min(15.0, Math.max(4.8, maxHalfW * 1.25 + 1.8)),
            maxHalfW,
            maxRoadClass: Math.max(a.roadClass, b.roadClass),
          });
        }
      }
    }
  }

  // Fusionar hubs casi idénticos (< 3.2 m) conservando el radio mayor
  const junctions: JunctionHub[] = [];
  for (const rj of rawJunctions) {
    let merged = false;
    for (const existing of junctions) {
      if (Math.hypot(rj.cx - existing.cx, rj.cz - existing.cz) < 3.2) {
        existing.cx = (existing.cx + rj.cx) * 0.5;
        existing.cz = (existing.cz + rj.cz) * 0.5;
        existing.hubRadius = Math.max(existing.hubRadius, rj.hubRadius);
        existing.maxHalfW = Math.max(existing.maxHalfW, rj.maxHalfW);
        existing.maxRoadClass = Math.max(existing.maxRoadClass, rj.maxRoadClass);
        merged = true;
        break;
      }
    }
    if (!merged) junctions.push(rj);
  }

  // 2. Tapas circulares de bordillo e intersección en cada cruce
  for (const junc of junctions) {
    pushJunctionDisc(
      junc.cx,
      junc.cz,
      junc.maxHalfW + 0.55,
      0.135,
      -1,
      terrain,
      positions,
      normals,
      uvs,
      roadClasses,
      laneCounts,
      markMasks,
      crosswalks
    );
    const capY = junc.maxRoadClass === 3 ? 0.246 : junc.maxRoadClass === 2 ? 0.206 : 0.166;
    pushJunctionDisc(
      junc.cx,
      junc.cz,
      junc.maxHalfW * 0.98,
      capY,
      junc.maxRoadClass,
      terrain,
      positions,
      normals,
      uvs,
      roadClasses,
      laneCounts,
      markMasks,
      crosswalks
    );
  }

  // 3. Emitir cintas viales (bordillo inferior para rodadas + calzada superior con marcas filtradas)
  for (const pr of prepared) {
    const { roadClass, width, laneCount, baseY } = pr.style;
    const isDriveable = roadClass >= 1;
    let pts = subdividePolylineXZ(pr.rawPts, 10);
    if (isDriveable && junctions.length > 0) {
      pts = refinePolylineNearJunctions(pts, junctions);
    }
    if (pts.length < 2) continue;

    const halfW = width * 0.5;
    const centerSamples: RoadVertexSample[] = [];
    const cumDist: number[] = [0];

    for (let i = 1; i < pts.length; i++) {
      cumDist.push(
        cumDist[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])
      );
    }

    for (let i = 0; i < pts.length; i++) {
      let prevIdx = i - 1;
      let nextIdx = i + 1;
      if (pr.isClosed) {
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
        const miter = dot > 0.55 ? Math.min(1.55, 1 / dot) : 1.0;
        nx *= miter;
        nz *= miter;
      }

      centerSamples.push({ x: pts[i][0], z: pts[i][1], nx, nz });
    }

    const emitStrip = (
      stripHalfW: number,
      stripBaseY: number,
      stripClass: number,
      stripLanes: number,
      allowMarkings: boolean
    ): void => {
      const leftPts: { x: number; y: number; z: number; nx: number; ny: number; nz: number }[] = [];
      const rightPts: { x: number; y: number; z: number; nx: number; ny: number; nz: number }[] = [];

      for (let i = 0; i < centerSamples.length; i++) {
        const s = centerSamples[i];
        const lx = s.x - s.nx * stripHalfW;
        const lz = s.z - s.nz * stripHalfW;
        const ln = terrain.getNormalAtXZ(lx, lz);
        leftPts.push({
          x: lx,
          y: terrain.getHeightAtXZ(lx, lz) + stripBaseY,
          z: lz,
          nx: ln[0],
          ny: ln[1],
          nz: ln[2],
        });

        const rx = s.x + s.nx * stripHalfW;
        const rz = s.z + s.nz * stripHalfW;
        const rn = terrain.getNormalAtXZ(rx, rz);
        rightPts.push({
          x: rx,
          y: terrain.getHeightAtXZ(rx, rz) + stripBaseY,
          z: rz,
          nx: rn[0],
          ny: rn[1],
          nz: rn[2],
        });
      }

      for (let i = 0; i < centerSamples.length - 1; i++) {
        const l0 = leftPts[i];
        const r0 = rightPts[i];
        const l1 = leftPts[i + 1];
        const r1 = rightPts[i + 1];
        const v0 = cumDist[i];
        const v1 = cumDist[i + 1];

        let segMarkMask = 0;
        let segCrosswalk = 0;

        if (allowMarkings) {
          const sdx = centerSamples[i + 1].x - centerSamples[i].x;
          const sdz = centerSamples[i + 1].z - centerSamples[i].z;
          const sLen = Math.hypot(sdx, sdz) || 1;
          const segDirX = sdx / sLen;
          const segDirZ = sdz / sLen;
          const mx = (centerSamples[i].x + centerSamples[i + 1].x) * 0.5;
          const mz = (centerSamples[i].z + centerSamples[i + 1].z) * 0.5;

          let insideAnyHub = false;
          let inCrosswalkZone = false;

          for (let j = 0; j < junctions.length; j++) {
            const junc = junctions[j];
            const d = Math.hypot(mx - junc.cx, mz - junc.cz);
            if (d <= junc.hubRadius) {
              insideAnyHub = true;
              break;
            }
            if (
              !pr.isRoundabout &&
              pr.totalLen >= 28 &&
              stripClass >= 2 &&
              junc.maxRoadClass >= 2 &&
              d > junc.hubRadius + 0.5 &&
              d <= junc.hubRadius + 2.85
            ) {
              inCrosswalkZone = true;
            }
          }

          if (!insideAnyHub) {
            const cgx = Math.floor(mx / CROSS_CELL);
            const cgz = Math.floor(mz / CROSS_CELL);
            outerGrid: for (let ox = cgx - 1; ox <= cgx + 1; ox++) {
              for (let oz = cgz - 1; oz <= cgz + 1; oz++) {
                const bucket = segGrid.get(`${ox}_${oz}`);
                if (!bucket) continue;
                for (let k = 0; k < bucket.length; k++) {
                  const b = driveSegs[bucket[k]];
                  if (b.roadIdx === pr.roadIdx) continue;
                  const headingDot = Math.abs(segDirX * b.dirX + segDirZ * b.dirZ);
                  const clearR = headingDot < 0.88 ? b.halfW + 2.5 : b.roadClass > stripClass ? b.halfW + 1.0 : 0;
                  if (clearR > 0 && segDistSqXZ(mx, mz, b.ax, b.az, b.bx, b.bz) <= clearR * clearR) {
                    insideAnyHub = true;
                    break outerGrid;
                  }
                }
              }
            }
          }

          if (!insideAnyHub) {
            if (inCrosswalkZone) {
              segCrosswalk = 1;
            } else {
              segMarkMask = 1;
            }
          }
        }

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
          roadClasses.push(stripClass);
          laneCounts.push(stripLanes);
          markMasks.push(segMarkMask);
          crosswalks.push(segCrosswalk);
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
    };

    if (isDriveable) {
      // Bordillo inferior (y = 0.135) cubierto limpiamente por el asfalto de cualquier calle que cruce
      emitStrip(halfW + 0.55, 0.135, -1, 0, false);
    }
    emitStrip(halfW, baseY, roadClass, laneCount, isDriveable && roadClass >= 2);
  }

  if (positions.length === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geom.setAttribute('aRoadClass', new THREE.Float32BufferAttribute(roadClasses, 1));
  geom.setAttribute('aLaneCount', new THREE.Float32BufferAttribute(laneCounts, 1));
  geom.setAttribute('aMarkMask', new THREE.Float32BufferAttribute(markMasks, 1));
  geom.setAttribute('aCrosswalk', new THREE.Float32BufferAttribute(crosswalks, 1));

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
  wallStyles: number[];
  currentWallStyle: number;
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
  buf.wallStyles.push(buf.currentWallStyle, buf.currentWallStyle, buf.currentWallStyle);
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
function chooseBuildingWallStyle(
  b: ChunkPayload['buildings'][number],
  hVal: number,
  worldX: number,
  worldZ: number
): number {
  if (typeof b.facadeId === 'number') {
    return b.facadeId;
  }

  const name = b.name?.toLowerCase() ?? '';
  const hasClassicRoof =
    b.roofShape === 'dome' ||
    b.roofShape === 'mansard' ||
    b.roofShape === 'pyramidal' ||
    b.roofShape === 'hipped' ||
    b.roofShape === 'gabled';
  const isHistoricName =
    /palacio|museo|banco|ayuntamiento|congreso|teatro|cibeles|metr[oó]polis|telefon|telef[oó]nica|real|prado|estaci|iglesia|parroquia|catedral/.test(
      name
    );

  // Torres de cristal solo en distrito financiero norte (AZCA / Cuatro Torres: z < -2530)
  // o rascacielos modernos >= 54 m sin cubierta histórica
  const inNorthBusinessDistrict = worldZ < -2530;
  if (
    !hasClassicRoof &&
    !isHistoricName &&
    (/bbva|picasso|azca|cuatro torres|cristal|cepsa/.test(name) ||
      (inNorthBusinessDistrict && b.height >= 30) ||
      b.height >= 54)
  ) {
    return 4; // Muro cortina acristalado azul-plata
  }

  // Hitos barrocos de ladrillo y granito (Parroquia San José, Calatravas, Oratorios)
  if (/parroquia|iglesia|san jos[eé]|calatrava|oratorio/.test(name)) {
    return 7;
  }

  // Hitos Beaux-Arts de Gran Vía / Alcalá (Edificio Metrópolis, Grassy, Telefónica, Banco de España)
  if (
    b.id === 'way/332068538' ||
    /metr[oó]polis|grassy|telef[oó]nica|c[ií]rculo de bellas artes|banco de espa[nñ]a|capitol|carri[oó]n/.test(
      name
    )
  ) {
    return 6;
  }

  // Corredor monumental Gran Vía / Alcalá (entre Cibeles y Callao)
  const inGranViaAlcalaCorridor =
    worldX >= -1100 && worldX <= -50 && worldZ >= -600 && worldZ <= -310;
  if (inGranViaAlcalaCorridor && (b.height >= 18 || hasClassicRoof)) {
    return hVal > 0.78 && b.height < 26 ? 7 : 6;
  }

  // En Centro / Retiro / Salamanca: edificios altos/singulares y cúpulas usan piedra noble
  if (
    b.roofShape === 'dome' ||
    b.roofShape === 'mansard' ||
    b.roofShape === 'pyramidal' ||
    isHistoricName ||
    b.height >= 23
  ) {
    return 1;
  }

  if (b.height >= 15) {
    if (hVal < 0.52) return 0; // Ensanche clásico (balcones forja + revoco claro)
    if (hVal < 0.80) return 2; // Ladrillo madrileño fino
    return 1; // Piedra noble
  }

  if (hVal < 0.36) return 2;
  if (hVal < 0.72) return 0;
  return 3;
}

function emitPerimeterCorniceLedge(
  buf: BuildingEmitBuffers,
  outer: THREE.Vector2[],
  topY: number,
  topLH: number,
  cr: number,
  cg: number,
  cb: number
): void {
  const n = outer.length;
  if (n < 3 || n > 24) return;
  const edgeNX = new Float32Array(n);
  const edgeNZ = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p0 = outer[i];
    const p1 = outer[(i + 1) % n];
    const dx = p1.x - p0.x;
    const dz = -(p1.y - p0.y);
    const len = Math.hypot(dx, dz) || 1;
    edgeNX[i] = -dz / len;
    edgeNZ[i] = dx / len;
  }

  const overhang = 0.26;
  const ledgeBot = topY - 0.34;
  const ledgeTop = topY + 0.04;
  const extX = new Float32Array(n);
  const extZ = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    let mx = edgeNX[prev] + edgeNX[i];
    let mz = edgeNZ[prev] + edgeNZ[i];
    const mLen = Math.hypot(mx, mz);
    if (mLen < 0.05) {
      extX[i] = outer[i].x + edgeNX[i] * overhang;
      extZ[i] = -outer[i].y + edgeNZ[i] * overhang;
    } else {
      mx /= mLen;
      mz /= mLen;
      const dot = Math.max(0.45, mx * edgeNX[i] + mz * edgeNZ[i]);
      const dist = Math.min(overhang * 1.6, overhang / dot);
      extX[i] = outer[i].x + mx * dist;
      extZ[i] = -outer[i].y + mz * dist;
    }
  }

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p0 = outer[i];
    const p1 = outer[j];
    const ax = p0.x;
    const az = -p0.y;
    const bx = p1.x;
    const bz = -p1.y;
    const ex0 = extX[i];
    const ez0 = extZ[i];
    const ex1 = extX[j];
    const ez1 = extZ[j];

    pushWallQuad(buf, ex0, ez0, ex1, ez1, ledgeBot, ledgeTop, topLH - 0.34, topLH + 0.04, 0.38, 0, cr, cg, cb, 3);
    pushBuildingTri(buf, ax, ledgeTop, az, topLH, 0, bx, ledgeTop, bz, topLH, 0, ex1, ledgeTop, ez1, topLH, 0, 0, 1, 0, cr, cg, cb, 3);
    pushBuildingTri(buf, ax, ledgeTop, az, topLH, 0, ex1, ledgeTop, ez1, topLH, 0, ex0, ledgeTop, ez0, topLH, 0, 0, 1, 0, cr, cg, cb, 3);
    pushBuildingTri(buf, ax, ledgeBot, az, topLH - 0.34, 0.34, ex1, ledgeBot, ez1, topLH - 0.34, 0.34, bx, ledgeBot, bz, topLH - 0.34, 0.34, 0, -1, 0, cr, cg, cb, 3);
    pushBuildingTri(buf, ax, ledgeBot, az, topLH - 0.34, 0.34, ex0, ledgeBot, ez0, topLH - 0.34, 0.34, ex1, ledgeBot, ez1, topLH - 0.34, 0.34, 0, -1, 0, cr, cg, cb, 3);
  }
}

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
    wallStyles: [],
    currentWallStyle: 0,
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
    const isMetropolisDome = b.id === 'way/332068538';
    let roofH = hasCustomRoof
      ? Math.min(Math.max(1.2, totalH - minH - 1.5), Math.max(1.2, b.roofHeight ?? 3.5))
      : 0;
    if (roofShape === 'dome' && totalH >= 22) {
      roofH = Math.max(roofH, isMetropolisDome ? 6.8 : 4.2);
    }
    const wallTopLocal = hasCustomRoof ? Math.max(minH + 1.8, totalH - roofH) : totalH;
    const wallSpan = Math.max(1.0, wallTopLocal - minH);

    const botY = minH > 0.2 ? baseY + minH : Math.min(baseY, minRingY) - 3.0;
    const wallTopY = baseY + wallTopLocal;
    const peakY = wallTopY + roofH;
    const botLH = minH > 0.2 ? minH : 0;

    const hVal = hashString(b.id);
    buf.currentWallStyle = chooseBuildingWallStyle(b, hashString(b.id + '_ws'), cx, cz);
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
    const isDarkSlateMonument = roofShape === 'pyramidal' && totalH >= 20;
    if ((roofShape === 'pyramidal' || roofShape === 'round') && isStarShaped) {
      const n = parsed.outer.length;
      const rType = isDarkSlateMonument ? 4 : 2;
      for (let i = 0; i < n; i++) {
        const p0 = parsed.outer[i];
        const p1 = parsed.outer[(i + 1) % n];
        pushBuildingAutoTri(
          buf,
          p0.x, wallTopY, -p0.y, wallTopLocal, 5,
          p1.x, wallTopY, -p1.y, wallTopLocal, 5,
          cx, peakY, cz, wallTopLocal + roofH, 5,
          cr, cg, cb, rType
        );
      }
    } else if (roofShape === 'dome' && isStarShaped) {
      // Cúpulas madrileñas de pizarra oscura + corona / linterna dorada en cúpulas monumentales
      const ringsR = [1.0, 0.80, 0.48, 0.20];
      const ringsH = [0.0, 0.44, 0.78, 0.96];
      const n = parsed.outer.length;
      const scaleRing = (rFrac: number, hFrac: number) => ({
        y: wallTopY + roofH * hFrac,
        lh: wallTopLocal + roofH * hFrac,
        pts: parsed.outer.map((p) => [cx + (p.x - cx) * rFrac, cz + (-p.y - cz) * rFrac] as [number, number]),
      });
      const r0 = scaleRing(ringsR[0], ringsH[0]);
      const r1 = scaleRing(ringsR[1], ringsH[1]);
      const r2 = scaleRing(ringsR[2], ringsH[2]);
      const r3 = scaleRing(ringsR[3], ringsH[3]);
      const pairs: [typeof r0, typeof r1, number][] = [
        [r0, r1, 4],
        [r1, r2, 4],
        [r2, r3, totalH >= 26 ? 5 : 4],
      ];
      for (const [lo, hi, rType] of pairs) {
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          pushBuildingAutoTri(
            buf,
            lo.pts[i][0], lo.y, lo.pts[i][1], lo.lh, 5,
            lo.pts[j][0], lo.y, lo.pts[j][1], lo.lh, 5,
            hi.pts[j][0], hi.y, hi.pts[j][1], hi.lh, 5,
            cr, cg, cb, rType
          );
          pushBuildingAutoTri(
            buf,
            lo.pts[i][0], lo.y, lo.pts[i][1], lo.lh, 5,
            hi.pts[j][0], hi.y, hi.pts[j][1], hi.lh, 5,
            hi.pts[i][0], hi.y, hi.pts[i][1], hi.lh, 5,
            cr, cg, cb, rType
          );
        }
      }
      const capType = totalH >= 26 ? 5 : 4;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        pushBuildingAutoTri(
          buf,
          r3.pts[i][0], r3.y, r3.pts[i][1], r3.lh, 5,
          r3.pts[j][0], r3.y, r3.pts[j][1], r3.lh, 5,
          cx, peakY, cz, wallTopLocal + roofH, 5,
          cr, cg, cb, capType
        );
      }

      // Escultura de la Victoria Alada dorada y linterna en Edificio Metrópolis (Alcalá / Gran Vía)
      if (isMetropolisDome) {
        const pedBase = peakY - 0.1;
        const pedTop = peakY + 1.85;
        const pedR = 0.72;
        const figTop = pedTop + 2.45;
        // Pedestal octagonal dorado
        for (let k = 0; k < 6; k++) {
          const a0 = (k / 6) * Math.PI * 2;
          const a1 = ((k + 1) / 6) * Math.PI * 2;
          const x0 = cx + Math.cos(a0) * pedR;
          const z0 = cz + Math.sin(a0) * pedR;
          const x1 = cx + Math.cos(a1) * pedR;
          const z1 = cz + Math.sin(a1) * pedR;
          pushWallQuad(
            buf,
            x0, z0, x1, z1,
            pedBase, pedTop,
            wallTopLocal + roofH, wallTopLocal + roofH + 1.8,
            1.5, 0.2,
            cr, cg, cb, 5
          );
          // Cuerpo estilizado de la Victoria
          pushBuildingAutoTri(
            buf,
            cx + Math.cos(a0) * 0.36, pedTop, cz + Math.sin(a0) * 0.36, wallTopLocal + roofH + 1.8, 1.5,
            cx + Math.cos(a1) * 0.36, pedTop, cz + Math.sin(a1) * 0.36, wallTopLocal + roofH + 1.8, 1.5,
            cx, figTop, cz, wallTopLocal + roofH + 4.3, 0.1,
            cr, cg, cb, 5
          );
        }
        // Alas doradas desplegadas
        const wingY0 = pedTop + 1.45;
        const wingY1 = pedTop + 3.15;
        for (const side of [-1, 1]) {
          pushBuildingAutoTri(
            buf,
            cx, wingY0, cz, wallTopLocal + roofH + 3.2, 0.8,
            cx + side * 2.25, wingY1, cz - 0.55, wallTopLocal + roofH + 4.8, 0.1,
            cx + side * 0.85, wingY0 - 0.45, cz + 0.25, wallTopLocal + roofH + 2.8, 1.0,
            cr, cg, cb, 5
          );
          pushBuildingAutoTri(
            buf,
            cx, wingY0, cz, wallTopLocal + roofH + 3.2, 0.8,
            cx + side * 0.85, wingY0 - 0.45, cz + 0.25, wallTopLocal + roofH + 2.8, 1.0,
            cx + side * 2.25, wingY1, cz - 0.55, wallTopLocal + roofH + 4.8, 0.1,
            cr, cg, cb, 5
          );
        }
      }
    } else if (roofShape === 'mansard' && isStarShaped) {
      const insetScale = 1 - Math.min(0.32, 2.1 / minApothem);
      emitStarInsetRoof(insetScale, 4, 1, true);
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

      // Cornisa volada arquitectónica en cuerpos principales clásicos y LoD2
      if (
        !hasCustomRoof &&
        buf.currentWallStyle !== 4 &&
        (b.hasCornice || (!b.parent3dId && wallTopLocal >= 12))
      ) {
        emitPerimeterCorniceLedge(buf, parsed.outer, wallTopY, wallTopLocal, cr, cg, cb);
      }

      // Casetones / lucernarios procedurales solo en edificios OSM planos (LoD2 ya trae volúmenes reales)
      if (!b.parent3dId && area >= 95 && wallTopLocal >= 7.0) {
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
  geom.setAttribute('aWallStyle', new THREE.Float32BufferAttribute(buf.wallStyles, 1));

  const mesh = new THREE.Mesh(geom, material);
  mesh.name = 'chunk-buildings';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

const SLPK_MAGIC = 0x4b504c53;

function align4(n: number): number {
  return (n + 3) & ~3;
}

export function parseSlpkBuildingGeometry(
  buffer: ArrayBuffer
): { geometry: THREE.BufferGeometry; buildingCount: number } | null {
  if (buffer.byteLength < 32) return null;
  const header = new Uint32Array(buffer, 0, 8);
  if (header[0] !== SLPK_MAGIC || header[1] !== 1) return null;

  const V = header[2];
  const I = header[3];
  const buildingCount = header[4];
  if (V === 0) return null;

  const off0 = 32;
  const off1 = off0 + V * 12;
  const off2 = off1 + V * 12;
  const off3 = off2 + align4(V * 3);
  const off4 = off3 + V * 4;
  const off5 = off4 + V * 4;
  const off6 = off5 + align4(V);
  const off7 = off6 + align4(V);
  if (buffer.byteLength < off7 + I * 4) return null;

  const positions = new Float32Array(buffer, off0, V * 3);
  const normals = new Float32Array(buffer, off1, V * 3);
  const colU8 = new Uint8Array(buffer, off2, V * 3);
  const localHeights = new Float32Array(buffer, off3, V);
  const topDists = new Float32Array(buffer, off4, V);
  const rtU8 = new Uint8Array(buffer, off5, V);
  const wsU8 = new Uint8Array(buffer, off6, V);

  const colors = new Float32Array(V * 3);
  const inv255 = 1 / 255;
  for (let i = 0; i < V * 3; i++) {
    colors[i] = colU8[i] * inv255;
  }

  const roofTypes = new Float32Array(V);
  const wallStyles = new Float32Array(V);
  for (let i = 0; i < V; i++) {
    roofTypes[i] = rtU8[i];
    wallStyles[i] = wsU8[i];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute('aLocalHeight', new THREE.Float32BufferAttribute(localHeights, 1));
  geometry.setAttribute('aTopDist', new THREE.Float32BufferAttribute(topDists, 1));
  geometry.setAttribute('aRoofType', new THREE.Float32BufferAttribute(roofTypes, 1));
  geometry.setAttribute('aWallStyle', new THREE.Float32BufferAttribute(wallStyles, 1));

  if (I > 0) {
    const indices = new Uint32Array(buffer, off7, I);
    geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
  }

  return { geometry, buildingCount };
}

export function buildSlpkBuildingsMesh(
  buffer: ArrayBuffer,
  material: THREE.Material
): { mesh: THREE.Mesh; buildingCount: number } | null {
  const parsed = parseSlpkBuildingGeometry(buffer);
  if (!parsed) return null;
  const mesh = new THREE.Mesh(parsed.geometry, material);
  mesh.name = 'chunk-buildings';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return { mesh, buildingCount: parsed.buildingCount };
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
  terrain: TerrainElevation,
  slpkMeshBuffer?: ArrayBuffer | null
): ChunkBuildResult {
  const group = new THREE.Group();
  group.name = `chunk_${data.key}`;

  const parks = buildPolygonSurfaceMesh(data.parks, 0.03, resources.parkMaterial, 'chunk-parks', terrain, 24);
  if (parks) group.add(parks);

  const water = buildPolygonSurfaceMesh(data.water, 0.24, resources.waterMaterial, 'chunk-water', terrain, 20);
  if (water) group.add(water);

  const roads = buildRoadsMesh(data.roads, resources.roadMaterial, terrain);
  if (roads) group.add(roads);

  let buildingsCount = data.buildings.length;
  if (slpkMeshBuffer) {
    const slpkBuilt = buildSlpkBuildingsMesh(slpkMeshBuffer, resources.buildingMaterial);
    if (slpkBuilt) {
      group.add(slpkBuilt.mesh);
      buildingsCount = slpkBuilt.buildingCount;
    }
  } else {
    const buildings = buildBuildingsMesh(data.buildings, resources.buildingMaterial, terrain);
    if (buildings) group.add(buildings);
  }

  const { treesMesh, count: treesCount } = buildChunkTrees(data, resources, terrain);
  if (treesMesh) group.add(treesMesh);

  return {
    group,
    buildingsCount,
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
