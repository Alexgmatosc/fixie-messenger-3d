export type RoofShape =
  | 'flat'
  | 'gabled'
  | 'hipped'
  | 'pyramidal'
  | 'mansard'
  | 'dome'
  | 'round'
  | 'skillion';

export interface BuildingFeature {
  id: string;
  name?: string;
  height: number;
  minHeight?: number;
  roofShape?: RoofShape;
  roofHeight?: number;
  isPart?: boolean;
  parent3dId?: number;
  lod2Tier?: 'base' | 'main' | 'attic' | 'tower';
  hasCornice?: boolean;
  facadeId?: number;
  rings: [number, number][][];
}

export interface RoadFeature {
  id: string;
  name?: string;
  highway: string;
  oneway: boolean;
  lanes: number;
  coords: [number, number][];
}

export interface PolygonFeature {
  id: string;
  name?: string;
  rings: [number, number][][];
}

export interface ChunkPayload {
  cx: number;
  cz: number;
  key: string;
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  parks: PolygonFeature[];
  water: PolygonFeature[];
  trees: [number, number][];
}

export interface DemGrid {
  cols: number;
  rows: number;
  bbox: [number, number, number, number];
  originElevationM: number;
  minElevationM: number;
  maxElevationM: number;
  values: number[];
}

export interface ChunkManifestEntry {
  key: string;
  cx: number;
  cz: number;
  file: string;
  meshFile?: string;
  counts: {
    buildings: number;
    roads: number;
    parks: number;
    water: number;
    trees: number;
  };
}

export interface ChunkManifest {
  meta: {
    origin: { lon: number; lat: number };
    bbox: [number, number, number, number];
    chunkSizeM: number;
    generatedAt: string;
    source: string;
  };
  totals: {
    chunks: number;
    buildings: number;
    roads: number;
    parks: number;
    water: number;
    trees: number;
  };
  dem: DemGrid;
  chunks: ChunkManifestEntry[];
}

export interface PoiDefinition {
  id: string;
  label: string;
  lon: number;
  lat: number;
  heightOffsetM: number;
  category: 'landmark' | 'park' | 'neighborhood';
}
