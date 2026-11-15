import * as THREE from 'three/webgpu';
import {
  attribute,
  color,
  float,
  fract,
  max,
  mix,
  normalWorld,
  positionGeometry,
  positionWorld,
  sin,
  smoothstep,
  step,
  uv,
  vertexColor,
} from 'three/tsl';

export const PALETTE = {
  sky: 0xa9cef2,
  fog: 0xdbe9f6,
  ground: 0xefece5,
  curbEdge: 0xd3cec4,
  pedestrianPath: 0xebe6dc,
  asphalt: 0x5d6470,
  asphaltSecondary: 0x717884,
  roadMarking: 0xf4f6f8,
  buildingTones: [
    0xf3f0e9, // alabastro luminoso (Cibeles / Banco de España)
    0xebe3d4, // crema piedra suave
    0xe4d7c3, // arena cálida pastel
    0xdfe4eb, // gris azulado pálido
    0xeee8dd, // marfil luminoso
    0xe9d8c9, // melocotón piedra sutil
  ] as const,
  roofFlat: 0xe6e2da,
  roofSloped: 0x9aa4b2,
  parkGrass: 0x9fe084,
  treeCrowns: [0x82c768, 0x92d377, 0xa2de87, 0x76b85e] as const,
  treeTrunk: 0x8a7562,
  water: 0x4ca0eb,
};

export function createGroundMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.94,
    metalness: 0.02,
  });

  const elevFactor = smoothstep(float(-45.0), float(48.0), positionWorld.y);
  const valleyTone = color(0xe4e0d8);
  const ridgeTone = color(0xf4f2ec);
  const baseHypso = mix(valleyTone, ridgeTone, elevFactor);
  const heightTone = mix(color(PALETTE.ground), baseHypso, float(0.65));
  const slopeShade = mix(float(0.92), float(1.0), smoothstep(float(0.86), float(0.995), normalWorld.y));

  mat.colorNode = heightTone.mul(slopeShade);
  return mat;
}

export function createParkMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.92,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });

  const wave = sin(positionWorld.x.mul(0.032))
    .mul(sin(positionWorld.z.mul(0.039)))
    .mul(0.5)
    .add(0.5);
  mat.colorNode = mix(color(0x91d675), color(0xb0e796), wave);
  return mat;
}

export function createWaterMaterial(): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: PALETTE.water,
    roughness: 0.16,
    metalness: 0.12,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/**
 * Material arquitectónico estilo Apple Maps DCE:
 * - Usa `aLocalHeight` para AO de contacto, zócalo de planta baja (~3.6m) e imposta sutil.
 * - Usa `aTopDist` para sombra bajo cornisa + filo luminoso superior.
 * - Usa ritmo de vanos/ventanas ultra sutil sin polígonos adicionales ni aliasing.
 * - Usa `aRoofType` (0 = fachada, 1 = azotea plana, 2 = tejado inclinado/cúpula, 3 = peto/casetón).
 */
export function createBuildingMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.89,
    metalness: 0.02,
  });

  const baseTone = vertexColor();
  const localHeight = attribute('aLocalHeight', 'float');
  const topDist = attribute('aTopDist', 'float');
  const roofType = attribute('aRoofType', 'float');

  const isWall = float(1.0).sub(step(float(0.5), roofType));
  const isFlatRoof = step(float(0.5), roofType).mul(float(1.0).sub(step(float(1.5), roofType)));
  const isSlopedRoof = step(float(1.5), roofType).mul(float(1.0).sub(step(float(2.5), roofType)));
  const isTrim = step(float(2.5), roofType);

  const totalHeight = localHeight.add(topDist);
  const isMultiStory = smoothstep(float(5.5), float(7.5), totalHeight);

  // AO de acera + sombra bajo cornisa + filo superior
  const groundAo = mix(float(0.82), float(1.0), smoothstep(float(0.0), float(3.8), localHeight));
  const underCorniceAo = mix(float(0.91), float(1.0), smoothstep(float(0.35), float(2.2), topDist));
  const corniceLip = smoothstep(float(0.45), float(0.0), topDist).mul(0.045);

  // Zócalo de planta baja + línea de imposta arquitectónica (~3.6 m)
  const plinthMask = float(1.0)
    .sub(smoothstep(float(3.35), float(3.75), localHeight))
    .mul(isMultiStory)
    .mul(isWall);
  const plinthShade = mix(float(1.0), float(0.945), plinthMask);
  const beltCourse = smoothstep(float(0.34), float(0.0), localHeight.sub(3.62).abs())
    .mul(isMultiStory)
    .mul(isWall)
    .mul(0.032);

  // Ritmo minimalista de plantas y huecos de ventana usando tangente exacta al muro
  const alongWallM = positionWorld.x.mul(normalWorld.z).sub(positionWorld.z.mul(normalWorld.x));
  const bayPhase = fract(alongWallM.div(3.25));
  const floorPhase = fract(localHeight.sub(3.8).div(3.35));

  const horizWin = smoothstep(float(0.18), float(0.31), bayPhase).mul(
    smoothstep(float(0.82), float(0.69), bayPhase)
  );
  const vertWin = smoothstep(float(0.22), float(0.35), floorPhase).mul(
    smoothstep(float(0.82), float(0.69), floorPhase)
  );
  const abovePlinth = smoothstep(float(3.95), float(4.45), localHeight);
  const belowCornice = smoothstep(float(1.05), float(1.75), topDist);

  const winMask = horizWin
    .mul(vertWin)
    .mul(abovePlinth)
    .mul(belowCornice)
    .mul(isMultiStory)
    .mul(isWall);

  const floorBands = sin(localHeight.mul(1.88)).mul(0.010).add(0.990);
  const wallShade = mix(
    float(1.0),
    underCorniceAo.mul(floorBands).mul(plinthShade).add(corniceLip).add(beltCourse),
    isWall
  );

  const flatTone = mix(baseTone.mul(0.96), color(PALETTE.roofFlat), float(0.55));
  const slopedTone = mix(baseTone.mul(0.90), color(PALETTE.roofSloped), float(0.62));
  const trimTone = mix(baseTone, color(0xf6f3ee), float(0.54));

  let surfaceColor = mix(baseTone, flatTone, isFlatRoof);
  surfaceColor = mix(surfaceColor, slopedTone, isSlopedRoof);
  surfaceColor = mix(surfaceColor, trimTone, isTrim);
  surfaceColor = mix(surfaceColor, color(0xc9d2de), winMask.mul(0.13));

  mat.colorNode = surfaceColor.mul(groundAo).mul(wallShade);
  return mat;
}

/**
 * Material único para toda la red viaria (1 draw call por chunk):
 * `aRoadClass`:
 *   -1 = bordillo inferior (cubierto limpiamente por el asfalto en los cruces)
 *    0 = sendero de parque / calle peatonal
 *    1 = residencial / servicio (sin líneas discontinuas)
 *    2 = secundaria / terciaria
 *    3 = primaria / gran avenida
 * `aLaneCount`: 0..3 divisores de carril discontinuos
 * `aMarkMask`: 0 en intersecciones / rotondas, 1 en tramos abiertos
 * `aCrosswalk`: 1 en bandas de paso de cebra antes de cruces
 */
export function createRoadMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.04,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  const roadUV = uv();
  const roadClass = attribute('aRoadClass', 'float');
  const laneCount = attribute('aLaneCount', 'float');
  const markMask = attribute('aMarkMask', 'float');
  const crosswalkAttr = attribute('aCrosswalk', 'float');

  const curbColor = color(PALETTE.curbEdge);
  const pedColor = color(PALETTE.pedestrianPath);
  const resAsphalt = color(PALETTE.asphaltSecondary);
  const secAsphalt = color(0x646b77);
  const priAsphalt = color(PALETTE.asphalt);
  const markingColor = color(PALETTE.roadMarking);

  const isPed = step(float(-0.5), roadClass).mul(float(1.0).sub(step(float(0.5), roadClass)));
  const isRes = step(float(0.5), roadClass).mul(float(1.0).sub(step(float(1.5), roadClass)));
  const isSec = step(float(1.5), roadClass).mul(float(1.0).sub(step(float(2.5), roadClass)));
  const isPri = step(float(2.5), roadClass);

  const surfaceWithPed = mix(curbColor, pedColor, isPed);
  const surfaceWithRes = mix(surfaceWithPed, resAsphalt, isRes);
  const surfaceWithSec = mix(surfaceWithRes, secAsphalt, isSec);
  const surfaceBase = mix(surfaceWithSec, priAsphalt, isPri);

  // Patrón discontinuo longitudinal solo en tramos con markMask = 1 y roadClass >= 2
  const dashPattern = step(float(0.56), fract(roadUV.y.mul(0.105)));
  const isMarkable = step(float(1.5), roadClass).mul(step(float(0.5), markMask));

  const hasOneLane = step(float(0.5), laneCount).mul(float(1.0).sub(step(float(1.5), laneCount)));
  const hasTwoLanes = step(float(1.5), laneCount).mul(float(1.0).sub(step(float(2.5), laneCount)));
  const hasThreeLanes = step(float(2.5), laneCount);

  const d50 = float(1.0).sub(step(float(0.014), roadUV.x.sub(0.5).abs()));
  const d33 = max(
    float(1.0).sub(step(float(0.012), roadUV.x.sub(0.333).abs())),
    float(1.0).sub(step(float(0.012), roadUV.x.sub(0.667).abs()))
  );
  const d25_75 = max(
    float(1.0).sub(step(float(0.011), roadUV.x.sub(0.25).abs())),
    float(1.0).sub(step(float(0.011), roadUV.x.sub(0.75).abs()))
  );
  const d25_50_75 = max(d50, d25_75);

  const laneMask = d50
    .mul(hasOneLane)
    .add(d33.mul(hasTwoLanes))
    .add(d25_50_75.mul(hasThreeLanes))
    .mul(dashPattern)
    .mul(isMarkable);

  // Pasos de cebra (aCrosswalk > 0.5) transversales a la calzada
  const inCrossWidth = step(float(0.08), roadUV.x).mul(float(1.0).sub(step(float(0.92), roadUV.x)));
  const zebraStripes = step(float(0.46), fract(roadUV.x.mul(10.0)));
  const crossMask = step(float(0.5), crosswalkAttr)
    .mul(inCrossWidth)
    .mul(zebraStripes)
    .mul(step(float(1.5), roadClass));

  const finalMarkMask = max(laneMask.mul(0.84), crossMask.mul(0.92));

  mat.colorNode = mix(surfaceBase, markingColor, finalMarkMask);
  return mat;
}

export function createTreeMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.02,
  });

  const isCrown = attribute('aIsCrown', 'float');
  const tintFactor = sin(
    positionWorld.x.mul(0.17).add(positionWorld.z.mul(0.23))
  )
    .mul(0.5)
    .add(0.5);

  const crownBase = mix(
    color(PALETTE.treeCrowns[0]),
    color(PALETTE.treeCrowns[2]),
    tintFactor
  );
  const verticalShade = mix(
    float(0.87),
    float(1.08),
    smoothstep(float(1.8), float(4.6), positionGeometry.y)
  );
  const topHighlight = mix(
    float(0.94),
    float(1.08),
    smoothstep(float(0.1), float(0.85), normalWorld.y)
  );
  const crownFinal = crownBase.mul(verticalShade).mul(topHighlight);

  mat.colorNode = mix(color(PALETTE.treeTrunk), crownFinal, isCrown);
  return mat;
}
