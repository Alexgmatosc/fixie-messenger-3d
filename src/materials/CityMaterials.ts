import * as THREE from 'three/webgpu';
import {
  attribute,
  bumpMap,
  color,
  float,
  int,
  max,
  mix,
  normalWorld,
  positionGeometry,
  positionWorld,
  sin,
  smoothstep,
  step,
  texture,
  uv,
  vec2,
  vertexColor,
} from 'three/tsl';
import type { PnoaOrthoClipmap } from '../world/PnoaOrthoClipmap';
import type { MadridFacadeArrays, MadridRoadTextures } from './MadridTextureAtlas';

export const PALETTE = {
  sky: 0x80b6ea,
  fog: 0xd6e7f7,
  ground: 0xe6e1d7,
  curbEdge: 0xc9c3b8,
  pedestrianPath: 0xe9e4da,
  asphalt: 0x464a52,
  asphaltSecondary: 0x575c65,
  roadMarking: 0xf4f6f8,
  buildingTones: [
    0xf5f0e6, // piedra caliza blanca cálida (Metrópolis / Cibeles / Banco de España)
    0xeee5d5, // crema ensanche luminoso
    0xe8dac3, // arena piedra de Salamanca / Chamberí
    0xf1ebdf, // marfil claro Gran Vía
    0xe4e6ea, // gris piedra claro
    0xede0cf, // ocre suave madrileño
  ] as const,
  roofFlat: 0xdfd8cd,
  roofSloped: 0x8f9aa8,
  parkGrass: 0x6ea655,
  treeCrowns: [0x5d8d46, 0x6ea055, 0x7bad61, 0x4e7a3b] as const,
  treeTrunk: 0x746150,
  water: 0x4298e3,
};

export function createGroundMaterial(ortho?: PnoaOrthoClipmap): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.94,
    metalness: 0.02,
  });

  const elevFactor = smoothstep(float(-45.0), float(48.0), positionWorld.y);
  const valleyTone = color(0xded9cf);
  const ridgeTone = color(0xefece5);
  const baseHypso = mix(valleyTone, ridgeTone, elevFactor);
  const heightTone = mix(color(PALETTE.ground), baseHypso, float(0.65));
  const slopeShade = mix(float(0.92), float(1.0), smoothstep(float(0.86), float(0.995), normalWorld.y));

  const baseColor = heightTone.mul(slopeShade);
  if (ortho) {
    const { orthoColor, orthoMask } = ortho.sampleWorldOrtho();
    // Variación suave PNOA para no crear borrones grises en isletas/medianas a ras de rueda
    const liftedOrtho = mix(orthoColor.rgb, color(0xeae5dc), float(0.45));
    mat.colorNode = mix(baseColor, liftedOrtho, orthoMask.mul(0.32));
  } else {
    mat.colorNode = baseColor;
  }

  return mat;
}

export function createParkMaterial(ortho?: PnoaOrthoClipmap): THREE.MeshStandardNodeMaterial {
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
  const procGrass = mix(color(0x91d675), color(0xb0e796), wave);

  if (ortho) {
    const { orthoColor, orthoMask } = ortho.sampleWorldOrtho();
    // Ortofoto real de parques (caminos de albero, parterres del Retiro) con leve refuerzo verde vivo
    const vibrantParkOrtho = mix(orthoColor.rgb, procGrass, float(0.20));
    mat.colorNode = mix(procGrass, vibrantParkOrtho, orthoMask.mul(0.84));
  } else {
    mat.colorNode = procGrass;
  }

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
 * Material arquitectónico híbrido de Madrid:
 * - Fachadas: DataArrayTexture PBR de 6 estilos madrileños (Ensanche, Palacio, Ladrillo,
 *   Residencial moderno, Muro Cortina de cristal y Bajos Comerciales de calle) con relieve (bump)
 *   y rugosidad/reflejo por ventana.
 * - Cubiertas y tejados: Ortofoto aérea real IGN PNOA proyectada en coordenadas métricas de mundo,
 *   con transición suave al tono arquitectónico fuera de la ventana activa.
 */
export function createBuildingMaterial(
  ortho?: PnoaOrthoClipmap,
  facades?: MadridFacadeArrays
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.88,
    metalness: 0.03,
  });

  const baseTone = vertexColor();
  const localHeight = attribute('aLocalHeight', 'float');
  const topDist = attribute('aTopDist', 'float');
  const roofType = attribute('aRoofType', 'float');
  const wallStyle = attribute('aWallStyle', 'float');

  const isWall = float(1.0).sub(step(float(0.5), roofType));
  const isFlatRoof = step(float(0.5), roofType).mul(float(1.0).sub(step(float(1.5), roofType)));
  const isSlopedRoof = step(float(1.5), roofType).mul(float(1.0).sub(step(float(2.5), roofType)));
  const isTrim = step(float(2.5), roofType).mul(float(1.0).sub(step(float(3.5), roofType)));
  const isSlateDome = step(float(3.5), roofType).mul(float(1.0).sub(step(float(4.5), roofType)));
  const isGoldDetail = step(float(4.5), roofType);

  const totalHeight = localHeight.add(topDist);
  const isMultiStory = smoothstep(float(5.5), float(7.5), totalHeight);

  // AO de acera + sombra bajo cornisa + filo superior
  const groundAo = mix(float(0.80), float(1.0), smoothstep(float(0.0), float(3.4), localHeight));
  const underCorniceAo = mix(float(0.90), float(1.0), smoothstep(float(0.35), float(2.2), topDist));
  const corniceLip = smoothstep(float(0.45), float(0.0), topDist).mul(0.048);

  // Zona de planta baja comercial (localHeight < 3.82 m) en edificios de varias plantas
  const plinthMask = float(1.0)
    .sub(smoothstep(float(3.65), float(3.98), localHeight))
    .mul(isMultiStory)
    .mul(isWall);

  // Coordenadas métricas exactas sobre el plano de fachada
  const alongWallM = positionWorld.x.mul(normalWorld.z).sub(positionWorld.z.mul(normalWorld.x));

  let wallColor: ReturnType<typeof mix> | typeof baseTone = baseTone;
  let wallRoughness = float(0.88);
  let wallMetalness = float(0.03);
  let wallBumpHeight = float(0.5);

  if (facades) {
    const upperUV = vec2(alongWallM.div(13.0), localHeight.sub(3.82).div(13.4));
    const groundUV = vec2(alongWallM.div(13.0), localHeight.div(3.82));
    const upperLayer = int(wallStyle.add(0.25));
    const groundLayer = int(5);

    const upperAlbedo = texture(facades.albedoArray, upperUV).depth(upperLayer);
    const upperPbr = texture(facades.pbrArray, upperUV).depth(upperLayer);
    const groundAlbedo = texture(facades.albedoArray, groundUV).depth(groundLayer);
    const groundPbr = texture(facades.pbrArray, groundUV).depth(groundLayer);

    // Las torres acristaladas (estilo >= 3.5) mantienen muro cortina hasta ras de acera
    const isGlassTower = step(float(3.5), wallStyle);
    const shopfrontBlend = plinthMask.mul(float(1.0).sub(isGlassTower));

    const texAlbedo = mix(upperAlbedo.rgb, groundAlbedo.rgb, shopfrontBlend);
    const texPbr = mix(upperPbr, groundPbr, shopfrontBlend);

    // tintMask (alpha de pbrArray): permite que el color de edificio tiña revoco/piedra
    // pero respete los ladrillos, forjas negras, escaparates y vidrio reflectante
    const tintedAlbedo = mix(texAlbedo, texAlbedo.mul(baseTone), texPbr.a.mul(0.82));

    wallColor = tintedAlbedo;
    wallRoughness = texPbr.g;
    wallMetalness = texPbr.b.mul(0.58);
    wallBumpHeight = texPbr.r;
  }

  const wallShade = mix(
    float(1.0),
    underCorniceAo.add(corniceLip),
    isWall
  );

  let flatTone: ReturnType<typeof mix> | typeof baseTone = mix(
    baseTone.mul(0.95),
    color(PALETTE.roofFlat),
    float(0.52)
  );
  let slopedTone: ReturnType<typeof mix> | typeof baseTone = mix(
    baseTone.mul(0.88),
    color(PALETTE.roofSloped),
    float(0.60)
  );
  const trimTone = mix(baseTone, color(0xf6f3ee), float(0.54));

  if (ortho) {
    const { orthoColor, orthoMask } = ortho.sampleWorldOrtho();
    // Tejados reales de Madrid desde PNOA (tejas terracota, cubiertas, patios)
    const roofPhotoFlat = mix(orthoColor.rgb, flatTone, float(0.14));
    const roofPhotoSloped = mix(orthoColor.rgb, slopedTone, float(0.22));
    flatTone = mix(flatTone, roofPhotoFlat, orthoMask.mul(0.88));
    slopedTone = mix(slopedTone, roofPhotoSloped, orthoMask.mul(0.82));
  }

  const slateTone = color(0x272c36);
  const goldTone = color(0xd8b14e);

  let surfaceColor = mix(baseTone, wallColor, isWall);
  surfaceColor = mix(surfaceColor, flatTone, isFlatRoof);
  surfaceColor = mix(surfaceColor, slopedTone, isSlopedRoof);
  surfaceColor = mix(surfaceColor, trimTone, isTrim);
  surfaceColor = mix(surfaceColor, slateTone, isSlateDome);
  surfaceColor = mix(surfaceColor, goldTone, isGoldDetail);

  const nonWallRough = mix(float(0.89), float(0.42), isSlateDome);
  const finalRough = mix(nonWallRough, float(0.24), isGoldDetail);
  const nonWallMetal = mix(float(0.02), float(0.26), isSlateDome);
  const finalMetal = mix(nonWallMetal, float(0.86), isGoldDetail);

  mat.colorNode = surfaceColor.mul(groundAo).mul(wallShade);
  mat.roughnessNode = mix(finalRough, wallRoughness, isWall);
  mat.metalnessNode = mix(finalMetal, wallMetalness, isWall);
  if (facades) {
    mat.normalNode = bumpMap(wallBumpHeight.mul(isWall), float(0.16));
  }

  return mat;
}

/**
 * Material único para toda la red viaria (1 draw call por chunk):
 * - Combina asfalto PBR micro-granulado y baldosa madrileña peatonal en coordenadas de mundo.
 * - Mantiene líneas discontinuas y pasos de cebra nítidos con desgaste realista sobre el árido.
 */
export function createRoadMaterial(roadTex?: MadridRoadTextures): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({
    roughness: 0.86,
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
  const isVehicleAsphalt = step(float(0.5), roadClass);

  const surfaceWithPed = mix(curbColor, pedColor, isPed);
  const surfaceWithRes = mix(surfaceWithPed, resAsphalt, isRes);
  const surfaceWithSec = mix(surfaceWithRes, secAsphalt, isSec);
  const surfacePlain = mix(surfaceWithSec, priAsphalt, isPri);

  let surfaceBase = surfacePlain;
  let roadBump = float(0.5);
  let roadRough = float(0.86);

  if (roadTex) {
    const asphaltUV = positionWorld.xz.mul(0.14);
    const pavingUV = positionWorld.xz.mul(0.28);

    const aspAlbedo = texture(roadTex.asphaltAlbedo, asphaltUV);
    const aspPbr = texture(roadTex.asphaltPbr, asphaltUV);
    const pavAlbedo = texture(roadTex.pavingAlbedo, pavingUV);
    const pavPbr = texture(roadTex.pavingPbr, pavingUV);

    const surfaceTex = mix(pavAlbedo.rgb, aspAlbedo.rgb, isVehicleAsphalt);
    surfaceBase = mix(surfacePlain, surfacePlain.mul(surfaceTex), float(0.75));
    roadBump = mix(pavPbr.r, aspPbr.r, isVehicleAsphalt);
    roadRough = mix(pavPbr.g, aspPbr.g, isVehicleAsphalt);
  }

  // Patrón discontinuo longitudinal solo en tramos con markMask = 1 y roadClass >= 2
  const dashPattern = step(float(0.56), fractToNode(roadUV.y.mul(0.105)));
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
  const zebraStripes = step(float(0.46), fractToNode(roadUV.x.mul(10.0)));
  const crossMask = step(float(0.5), crosswalkAttr)
    .mul(inCrossWidth)
    .mul(zebraStripes)
    .mul(step(float(1.5), roadClass));

  const finalMarkMask = max(laneMask.mul(0.84), crossMask.mul(0.90));
  const wornMarking = roadTex ? mix(markingColor, surfaceBase, float(0.14)) : markingColor;

  mat.colorNode = mix(surfaceBase, wornMarking, finalMarkMask);
  mat.roughnessNode = mix(roadRough, float(0.72), finalMarkMask.mul(0.6));
  if (roadTex) {
    mat.normalNode = bumpMap(roadBump, float(0.14));
  }
  return mat;
}

function fractToNode(x: ReturnType<typeof float>): ReturnType<typeof float> {
  return x.fract();
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
