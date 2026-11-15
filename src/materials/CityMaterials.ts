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
  sky: 0x9bc4ec,
  fog: 0xcfe3f7,
  ground: 0xd5cfc6,
  asphalt: 0x333842,
  roadMarking: 0xf1f5f9,
  buildingTones: [
    0xece5d8, // blanco roto / piedra caliza
    0xe2d4be, // crema / arena suave
    0xdcc19e, // ocre cálido madrileño
    0xd6a994, // terracota pastel
    0xcfd5da, // gris piedra claro
    0xe6d8c8, // marfil cálido
  ] as const,
  roofClay: 0xb8846d,
  parkGrass: 0x5d9456,
  treeCrowns: [0x467f43, 0x55914f, 0x67a359, 0x73a857] as const,
  treeTrunk: 0x6b4f3b,
  water: 0x2b7cd3,
};

export function createGroundMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.94,
    metalness: 0.04,
  });

  const elevFactor = smoothstep(float(-45.0), float(48.0), positionWorld.y);
  const valleyTone = color(0xc6bfb4);
  const ridgeTone = color(0xe0d8cc);
  const baseHypso = mix(valleyTone, ridgeTone, elevFactor);
  const heightTone = mix(color(PALETTE.ground), baseHypso, float(0.75));
  const slopeShade = mix(float(0.86), float(1.0), smoothstep(float(0.86), float(0.995), normalWorld.y));

  mat.colorNode = heightTone.mul(slopeShade);
  return mat;
}

export function createParkMaterial(): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: PALETTE.parkGrass,
    roughness: 0.92,
    metalness: 0.02,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
}

export function createWaterMaterial(): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({
    color: PALETTE.water,
    roughness: 0.14,
    metalness: 0.15,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
}

/**
 * Material de edificios estilo Apple Maps DCE:
 * - Usa color por vértice para variación tonal entre bloques.
 * - Evalúa AO de contacto con el suelo en TSL mediante `aLocalHeight` (0..h en metros),
 *   evitando que la interpolación de vértice estire la sombra en edificios altos.
 * - Diferencia sutilmente los tejados respecto a las fachadas con `normalWorld.y`.
 */
export function createBuildingMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.03,
  });

  const baseTone = vertexColor();
  const localHeight = attribute('aLocalHeight', 'float');
  const groundAo = mix(float(0.76), float(1.0), smoothstep(float(0.0), float(4.2), localHeight));
  const roofMask = smoothstep(float(0.55), float(0.9), normalWorld.y);
  const roofTone = mix(baseTone.mul(0.92), color(PALETTE.roofClay), float(0.58));
  const finalColor = mix(baseTone, roofTone, roofMask);

  mat.colorNode = finalColor.mul(groundAo);
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
    float(0.78),
    float(1.12),
    smoothstep(float(1.8), float(4.3), positionGeometry.y)
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
