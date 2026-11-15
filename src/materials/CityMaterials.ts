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
  fog: 0xd9e7f5,
  ground: 0xe2dfd8,
  asphalt: 0x4e545e,
  roadMarking: 0xf4f6f8,
  buildingTones: [
    0xf0ede6, // alabastro luminoso (Cibeles / Banco de España)
    0xe9e1d2, // crema piedra suave
    0xe2d5c1, // arena cálida pastel
    0xdce1e8, // gris azulado pálido
    0xebe5da, // marfil luminoso
    0xe6d4c5, // melocotón piedra sutil
  ] as const,
  roofFlat: 0xe5e1d9,
  roofSloped: 0x9aa4b2,
  parkGrass: 0x7cc466,
  treeCrowns: [0x76b85c, 0x87c56b, 0x97d079, 0x6ba955] as const,
  treeTrunk: 0x87725e,
  water: 0x4998e6,
};

export function createGroundMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.94,
    metalness: 0.02,
  });

  const elevFactor = smoothstep(float(-45.0), float(48.0), positionWorld.y);
  const valleyTone = color(0xd6d2ca);
  const ridgeTone = color(0xe9e6df);
  const baseHypso = mix(valleyTone, ridgeTone, elevFactor);
  const heightTone = mix(color(PALETTE.ground), baseHypso, float(0.65));
  const slopeShade = mix(float(0.90), float(1.0), smoothstep(float(0.86), float(0.995), normalWorld.y));

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

  const wave = sin(positionWorld.x.mul(0.035))
    .mul(sin(positionWorld.z.mul(0.042)))
    .mul(0.5)
    .add(0.5);
  mat.colorNode = mix(color(0x74bd5e), color(0x88ce6f), wave);
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
 * - Usa `aLocalHeight` para AO de contacto con el suelo/acera.
 * - Usa `aTopDist` (distancia desde cornisa) para sombra bajo cornisa + filo luminoso superior.
 * - Usa `aRoofType` (0 = fachada, 1 = azotea plana, 2 = tejado inclinado/cúpula, 3 = peto/casetón)
 *   para diferenciar cubiertas, petos y volúmenes sin coste de draw calls.
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

  const groundAo = mix(float(0.80), float(1.0), smoothstep(float(0.0), float(4.0), localHeight));
  const underCorniceAo = mix(float(0.91), float(1.0), smoothstep(float(0.35), float(2.2), topDist));
  const corniceLip = smoothstep(float(0.45), float(0.0), topDist).mul(0.045);
  const floorBands = sin(localHeight.mul(1.85)).mul(0.011).add(0.989);

  const wallShade = mix(float(1.0), underCorniceAo.mul(floorBands).add(corniceLip), isWall);

  const flatTone = mix(baseTone.mul(0.96), color(PALETTE.roofFlat), float(0.55));
  const slopedTone = mix(baseTone.mul(0.90), color(PALETTE.roofSloped), float(0.62));
  const trimTone = mix(baseTone, color(0xf4f1eb), float(0.52));

  let surfaceColor = mix(baseTone, flatTone, isFlatRoof);
  surfaceColor = mix(surfaceColor, slopedTone, isSlopedRoof);
  surfaceColor = mix(surfaceColor, trimTone, isTrim);

  mat.colorNode = surfaceColor.mul(groundAo).mul(wallShade);
  return mat;
}

/**
 * Material único para toda la red viaria (1 draw call):
 * `aRoadClass`:
 *   0 = peatonal / acera (#262b38)
 *   1 = residencial / servicio (#181c26 con bordillo tenue)
 *   2 = secundaria / terciaria (asfalto + línea central discontinua)
 *   3 = primaria / Paseo del Prado (asfalto + divisoria de carriles + bordillos)
 */
export function createRoadMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.05,
    polygonOffset: true,
    polygonOffsetFactor: -3,
    polygonOffsetUnits: -3,
  });

  const roadUV = uv();
  const roadClass = attribute('aRoadClass', 'float');

  const asphaltColor = color(PALETTE.asphalt);
  const sidewalkColor = color(PALETTE.ground);
  const markingColor = color(PALETTE.roadMarking);

  const isDriveable = step(float(0.5), roadClass);
  const isSecondaryPlus = step(float(1.5), roadClass);
  const isPrimary = step(float(2.5), roadClass);

  // Bordillos laterales sutiles (u < 0.045 o u > 0.955)
  const leftCurb = float(1.0).sub(step(float(0.045), roadUV.x));
  const rightCurb = step(float(0.955), roadUV.x);
  const curbMask = max(leftCurb, rightCurb).mul(isDriveable);

  // Patrón discontinuo longitudinal (uv.y está en metros)
  const dashPattern = step(float(0.52), fract(roadUV.y.mul(0.095)));

  // Línea central en u = 0.5
  const distCenter = roadUV.x.sub(0.5).abs();
  const centerLineMask = float(1.0)
    .sub(step(float(0.016), distCenter))
    .mul(dashPattern)
    .mul(isSecondaryPlus);

  // Líneas de carril adicionales para grandes avenidas (u = 0.28 y u = 0.72)
  const lane1Dist = roadUV.x.sub(0.28).abs();
  const lane2Dist = roadUV.x.sub(0.72).abs();
  const laneLine1 = float(1.0).sub(step(float(0.011), lane1Dist));
  const laneLine2 = float(1.0).sub(step(float(0.011), lane2Dist));
  const multiLaneMask = max(laneLine1, laneLine2).mul(dashPattern).mul(isPrimary);

  const lineMask = max(curbMask.mul(0.55), max(centerLineMask.mul(0.9), multiLaneMask.mul(0.7)));
  const surfaceBase = mix(sidewalkColor, asphaltColor, isDriveable);

  mat.colorNode = mix(surfaceBase, markingColor, lineMask);
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
    float(0.86),
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
