/**
 * Verified ground-truth fixtures for Madrid LoD2 SLPK E2E tests.
 * Derived exclusively from PROJECT.md Interface Contracts, src/geo/projection.ts,
 * public/data/chunks/manifest.json, and read-only inspection of MODELADO_3D_MADRID.slpk.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export const PATHS = Object.freeze({
  repoRoot: REPO_ROOT,
  slpkArchive: path.join(REPO_ROOT, 'scripts', '.cache-lod2', 'MODELADO_3D_MADRID.slpk'),
  baseChunksDir: path.join(REPO_ROOT, 'public', 'data', 'chunks'),
  baseManifest: path.join(REPO_ROOT, 'public', 'data', 'chunks', 'manifest.json'),
  lod2Manifest: path.join(REPO_ROOT, 'public', 'data', 'chunks-lod2', 'manifest.json'),
  slpkChunksDir: path.join(REPO_ROOT, 'public', 'data', 'chunks-slpk'),
  slpkManifest: path.join(REPO_ROOT, 'public', 'data', 'chunks-slpk', 'manifest.json'),
  packageJson: path.join(REPO_ROOT, 'package.json'),
  distDir: path.join(REPO_ROOT, 'dist'),
});

// Projection & Chunk Grid Contract (PROJECT.md § Interface Contract 1)
export const ORIGIN_LON = -3.6941;
export const ORIGIN_LAT = 40.4152;
export const MAP_BBOX = Object.freeze([-3.7510, 40.3820, -3.6570, 40.4870]);
export const CHUNK_SIZE_M = 400;
export const METERS_PER_DEG_LON = 111320 * Math.cos((ORIGIN_LAT * Math.PI) / 180);
export const METERS_PER_DEG_LAT = 110540;

// SLPK Binary Chunk Format v1 Contract (PROJECT.md § Interface Contract 3)
export const SLPK_MAGIC = 0x4b504c53; // "SLPK" little-endian
export const SLPK_VERSION = 1;
export const SLPK_HEADER_BYTES = 32;
export const MAX_ROOF_TYPE = 5;
export const MAX_WALL_STYLE = 7;
export const UPWARD_ROOF_MIN_TOP_DIST = 5.0;

// Runtime ChunkManager limits (PROJECT.md & Explorer 3)
export const VISIBLE_RADIUS_M = 780;
export const WARM_CACHE_MAX_CHUNKS = 55;

export const BASE_MANIFEST_EXPECTATIONS = Object.freeze({
  totalChunks: 452,
  totalBuildings: 57406,
  dem: Object.freeze({
    cols: 220,
    rows: 290,
    bbox: Object.freeze([-3.753, 40.38, -3.655, 40.489]),
    originElevationM: 652.2,
    minElevationM: 569.4,
    maxElevationM: 755.1,
    valuesLength: 63800,
  }),
});

export const SLPK_ARCHIVE_EXPECTATIONS = Object.freeze({
  nodepagesCount: 119,
  totalNodes: 7606,
  totalLeaves: 5396,
  leavesInMapBbox: 2458,
  featuresInMapBbox: 100273,
});

export const CAPA_CATEGORIES_IN_MAP_BBOX = Object.freeze({
  '01_EDIFICIO_P': 74183,
  '01_PORCHE_CASETA_COBERTIZO_P': 14829,
  '01_MARQUESINA_P': 6835,
  '06_ASCENSOR_P': 2537,
  '01_QUIOSCO_OBRA_P': 858,
  '01_LUCERNARIO_P': 548,
  '01_CONSTRUCCION_PERMANENTE_VIA_P': 178,
  '01_GRADAS_P': 155,
  '01_DEPOSITO_ELEVADO_P': 147,
  '01_PRESA_EMBALSE_P': 3,
});

export const LANDMARKS = Object.freeze({
  neptuno: Object.freeze({
    id: 'neptuno',
    poiLabel: 'Fuente de Neptuno',
    lon: -3.6941,
    lat: 40.4152,
    x: 0.0,
    z: 0.0,
    chunkKey: '0_0',
    demRelM: -0.0048,
    demAbsM: 652.1952,
    leafNode: 3927,
    featOid: 4632,
    altura: 27.66,
    tris: 9674,
    slopedTris: 1600,
  }),
  cibeles: Object.freeze({
    id: 'cibeles',
    poiLabel: 'Plaza de Cibeles',
    lon: -3.6930,
    lat: 40.4193,
    palacioLon: -3.6921,
    palacioLat: 40.4189,
    x: 93.23,
    z: -453.21,
    palacioX: 169.51,
    palacioZ: -409.0,
    chunkKey: '0_-2',
    neighborChunkKey: '0_-1',
    demRelM: 3.906,
    demAbsM: 656.106,
    leafNode: 3933,
    featOid: 261207,
    altura: 63.93,
    tris: 7374,
    slopedTris: 482,
    skylightOid: 133939,
    skylightAltura: 19.08,
    skylightTris: 56,
  }),
  granVia: Object.freeze({
    callao: Object.freeze({
      lon: -3.7058,
      lat: 40.4201,
      x: -991.64,
      z: -541.65,
      chunkKey: '-3_-2',
      demRelM: 24.33,
      demAbsM: 676.53,
    }),
    telefonica: Object.freeze({
      lon: -3.7016,
      lat: 40.4204,
      x: -635.66,
      z: -574.81,
      chunkKey: '-2_-2',
      demRelM: 32.848,
      demAbsM: 685.048,
      leafNode: 6219,
      featOid: 383649,
      altura: 84.75,
      tris: 1622,
      boundarySkylightChunkKey: '-3_-2',
      boundarySkylightOid: 190462,
    }),
    metropolis: Object.freeze({
      lon: -3.6976,
      lat: 40.4189,
      x: -296.64,
      z: -409.0,
      chunkKey: '-1_-2',
      neighborChunkKey: '-1_-1',
      demRelM: 17.902,
      demAbsM: 670.102,
      leafNode: 6200,
      featOid: 392672,
      altura: 38.78,
      tris: 1228,
      slopedTris: 204,
    }),
  }),
  palacioReal: Object.freeze({
    id: 'palacio',
    poiLabel: 'Palacio Real',
    lon: -3.7143,
    lat: 40.4179,
    x: -1712.06,
    z: -298.46,
    chunkKey: '-5_-1',
    demRelM: -0.729,
    demAbsM: 651.471,
    leafNode: 6334,
    domeOid: 2015,
    domeAltura: 77.37,
    domeTris: 4500,
    domeSlopedTris: 466,
    steepLowDemAbsM: 626.15,
    steepHighDemAbsM: 654.37,
  }),
  cuestaDeLaVega: Object.freeze({
    lon: -3.7145,
    lat: 40.4148,
    x: -1729.01,
    z: 44.22,
    chunkKey: '-5_0',
    demRelM: -16.12,
    demAbsM: 636.08,
    leafNode: 2915,
    featOid: 374025,
    altura: 25.55,
    tris: 446,
  }),
  atocha: Object.freeze({
    id: 'atocha',
    poiLabel: 'Estación de Atocha',
    lon: -3.6907,
    lat: 40.4068,
    x: 288.17,
    z: 928.54,
    chunkKey: '0_2',
    neighborChunkKey: '1_2',
    roadStructChunkKey: '0_3',
    demRelM: -21.825,
    demAbsM: 630.375,
    leafNode: 7536,
    canopyOid: 199804,
    canopyCapa: '01_MARQUESINA_P',
    canopyAltura: 26.15,
    canopyTris: 6076,
    canopySlopedTris: 1676,
    canopyBaseDeltaM: 11.97,
    canopyApproxX: 380,
    canopyApproxZ: 1140,
  }),
  retiro: Object.freeze({
    id: 'retiro',
    poiLabel: 'Estanque del Retiro',
    lon: -3.6836,
    lat: 40.4173,
    x: 889.93,
    z: -232.13,
    chunkKey: '2_-1',
    demRelM: 21.25,
    demAbsM: 673.45,
    leafNode: 3911,
    pavilionOid: 356596,
    pavilionTris: 2562,
    kioskOid: 395925,
  }),
  sol: Object.freeze({
    id: 'sol',
    poiLabel: 'Puerta del Sol',
    lon: -3.7038,
    lat: 40.4169,
    chunkKey: '-3_-1',
  }),
  azca: Object.freeze({
    id: 'azca',
    poiLabel: 'AZCA / Bernabéu',
    lon: -3.6915,
    lat: 40.4508,
    chunkKey: '0_-10',
  }),
  castilla: Object.freeze({
    id: 'castilla',
    poiLabel: 'Plaza de Castilla',
    lon: -3.6893,
    lat: 40.4668,
    chunkKey: '1_-15',
  }),
  ventas: Object.freeze({
    id: 'ventas',
    poiLabel: 'Plaza de Las Ventas',
    lon: -3.6633,
    lat: 40.4321,
    chunkKey: '6_-5',
  }),
  matadero: Object.freeze({
    id: 'matadero',
    poiLabel: 'Matadero / Madrid Río',
    lon: -3.6977,
    lat: 40.3917,
    chunkKey: '-1_6',
  }),
  debod: Object.freeze({
    id: 'debod',
    poiLabel: 'Templo de Debod / Pza. España',
    lon: -3.7177,
    lat: 40.4241,
    chunkKey: '-6_-3',
  }),
});

export const BOUNDARY_CHUNKS = Object.freeze({
  emptyPerimeter: Object.freeze(['-11_-14', '-10_-14']),
  lowCountBorder: Object.freeze([
    Object.freeze({ key: '-10_-6', osmBuildings: 1, slpkFeatures: 11 }),
    Object.freeze({ key: '-11_-13', osmBuildings: 5, slpkFeatures: 60 }),
  ]),
  osmZeroSlpkPositive: Object.freeze({
    key: '-12_-12',
    osmBuildings: 0,
    slpkFeatures: 236,
    sourceLeafNode: 4544,
  }),
  presaEmbalse: Object.freeze({
    leafNode: 7603,
    lon: -3.697224,
    lat: 40.386424,
    chunkKey: '-1_7',
    capa: '01_PRESA_EMBALSE_P',
  }),
});

export const OUTSIDE_MAP_BBOX_LEAVES = Object.freeze({
  north: Object.freeze({ node: 1996, resource: 1995, lon: -3.686950, lat: 40.504973, chunkKey: '1_-25' }),
  south: Object.freeze({ node: 936, resource: 935, lon: -3.731482, lat: 40.366594, chunkKey: '-8_13' }),
  east: Object.freeze({ node: 5, resource: 4, lon: -3.634837, lat: 40.419512, chunkKey: '12_-2', verts: 29226 }),
  west: Object.freeze({ node: 1094, resource: 1093, lon: -3.751214, lat: 40.370547, chunkKey: '-13_12' }),
  trailingNewlineCapa: Object.freeze({ node: 4897, resource: 4896, lon: -3.651477, lat: 40.466750, chunkKey: '9_-15' }),
});

export const BBOX_SUBSETS = Object.freeze({
  neptunoSmall: '-3.698,40.413,-3.690,40.418',
  eastOutsideMap: '-3.6400,40.4150,-3.6300,40.4250',
  oceanEmpty: '0,0,0.001,0.001',
});

export const GIT_EXPECTATIONS = Object.freeze({
  expectedBranch: 'feat/madrid-lod2-map',
  baseBranch: 'main',
});
