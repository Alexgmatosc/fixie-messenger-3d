import * as THREE from 'three/webgpu';

export type RiderPresetId = 'ryuji' | 'dante' | 'kuro' | 'niko';

export interface RiderPresetInfo {
  id: RiderPresetId;
  label: string;
  tagline: string;
}

export const RIDER_PRESETS: RiderPresetInfo[] = [
  { id: 'ryuji', label: 'Ryuji', tagline: 'Tokyo Liner · Carhartt' },
  { id: 'dante', label: 'Dante', tagline: 'Locs · Chrome Sling' },
  { id: 'kuro', label: 'Kuro', tagline: 'Stealth · Calcetín Blanco' },
  { id: 'niko', label: 'Niko', tagline: 'Braids · Workwear Azul' },
];

export interface FixieVisualState {
  speedMs: number;
  steerAngle: number;
  leanAngle: number;
  crankAngle: number;
  slopePitch: number;
  isSprinting: boolean;
  isSkidding: boolean;
  whipAngle: number;
  standBlend: number;   // 0 = sentado, 1 = de pie esprintando / track stand
  hopLiftM: number;     // salto trasero al clavar hop-skid
  lookYaw: number;      // giro sutil de cabeza mirando salida de curva
}

interface RiderLookSpec {
  skin: number;
  hair: number;
  hairStyle: 'bleached_spiky' | 'dreads' | 'buzz' | 'cornrows';
  sunglasses: boolean;
  jacket: number;
  innerShirt: number;
  shortSleeves: boolean;
  looseFlap: boolean;
  pants: number;
  beltBuckle: boolean;
  hipKeychain: boolean;
  carharttPatch: boolean;
  socks: number;
  shoeUpper: number;
  shoeSole: number;
  gloveColor: number;
  gloveWhiteBack: boolean;
  chromeSling: boolean;
  slingColor: number;
  wristSilver: boolean;
  forearmTattoo: boolean;
}

const PRESET_SPECS: Record<RiderPresetId, RiderLookSpec> = {
  ryuji: {
    skin: 0xe2b49a,
    hair: 0xebd7a7,
    hairStyle: 'bleached_spiky',
    sunglasses: false,
    jacket: 0x3b4440,      // chaqueta acolchada verde oliva oscuro/carbón
    innerShirt: 0x202c44,
    shortSleeves: false,
    looseFlap: true,
    pants: 0x625d62,       // Carhartt gris lavado
    beltBuckle: true,
    hipKeychain: true,
    carharttPatch: true,
    socks: 0x1d2b4e,       // calcetín azul marino alto
    shoeUpper: 0xa2a6ad,   // NB gris
    shoeSole: 0xedeef2,
    gloveColor: 0x1b1d22,
    gloveWhiteBack: false,
    chromeSling: false,
    slingColor: 0x5c2333,
    wristSilver: false,
    forearmTattoo: true,
  },
  dante: {
    skin: 0x7b4c36,
    hair: 0x1c1715,
    hairStyle: 'dreads',
    sunglasses: false,
    jacket: 0xededf0,      // camiseta blanca oversized boxy
    innerShirt: 0xededf0,
    shortSleeves: true,
    looseFlap: true,
    pants: 0x1e2026,
    beltBuckle: false,
    hipKeychain: false,
    carharttPatch: false,
    socks: 0x181a1f,
    shoeUpper: 0x1e2026,
    shoeSole: 0xeceef2,
    gloveColor: 0x1c1e24,
    gloveWhiteBack: false,
    chromeSling: true,     // bandolera Chrome granate cruzada
    slingColor: 0x5d2233,
    wristSilver: true,
    forearmTattoo: false,
  },
  kuro: {
    skin: 0xdfb498,
    hair: 0x1a1c20,
    hairStyle: 'buzz',
    sunglasses: true,
    jacket: 0x1a1d22,      // bomber/workwear negra
    innerShirt: 0x14161a,
    shortSleeves: false,
    looseFlap: true,
    pants: 0x16181e,
    beltBuckle: true,
    hipKeychain: true,
    carharttPatch: false,
    socks: 0xf2f3f6,       // calcetín blanco alto
    shoeUpper: 0x17191e,
    shoeSole: 0x262930,
    gloveColor: 0x17191e,
    gloveWhiteBack: false,
    chromeSling: false,
    slingColor: 0x17191e,
    wristSilver: false,
    forearmTattoo: false,
  },
  niko: {
    skin: 0xb67b56,
    hair: 0x191718,
    hairStyle: 'cornrows',
    sunglasses: false,
    jacket: 0x183d73,      // sobrecamisa azul cobalto oscuro
    innerShirt: 0x17191f,
    shortSleeves: false,
    looseFlap: true,
    pants: 0x1c1e24,
    beltBuckle: false,
    hipKeychain: false,
    carharttPatch: false,
    socks: 0x1b1d23,
    shoeUpper: 0x17191e,
    shoeSole: 0x2a2d35,
    gloveColor: 0x181a20,
    gloveWhiteBack: true,  // guantes alleycat negros con gráfico blanco
    chromeSling: false,
    slingColor: 0x183d73,
    wristSilver: false,
    forearmTattoo: false,
  },
};

/**
 * Trazo persistente de goma sobre el asfalto generado por la rueda trasera al derrapar (skid).
 * Usa un ring buffer de una sola malla para 0 asignaciones en runtime y 1 draw call.
 */
export class SkidTrailSystem {
  public readonly mesh: THREE.Mesh;
  private readonly maxSegments = 260;
  private readonly posAttr: THREE.BufferAttribute;
  private headSeg = 0;
  private hasLast = false;
  private lastX = 0;
  private lastY = 0;
  private lastZ = 0;

  constructor() {
    const vertCount = this.maxSegments * 6;
    const positions = new Float32Array(vertCount * 3);
    const geom = new THREE.BufferGeometry();
    this.posAttr = new THREE.Float32BufferAttribute(positions, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', this.posAttr);

    const mat = new THREE.MeshBasicMaterial({
      color: 0x1c1f26,
      transparent: true,
      opacity: 0.68,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    });

    this.mesh = new THREE.Mesh(geom, mat);
    this.mesh.name = 'fixie-skid-marks';
    this.mesh.frustumCulled = false;
  }

  public addPoint(x: number, y: number, z: number): void {
    if (!this.hasLast) {
      this.hasLast = true;
      this.lastX = x;
      this.lastY = y;
      this.lastZ = z;
      return;
    }

    const dx = x - this.lastX;
    const dz = z - this.lastZ;
    const dist = Math.hypot(dx, dz);
    if (dist < 0.18) return;
    if (dist > 6.0) {
      this.lastX = x;
      this.lastY = y;
      this.lastZ = z;
      return;
    }

    const halfW = 0.044;
    const nx = (-dz / dist) * halfW;
    const nz = (dx / dist) * halfW;

    const ax = this.lastX - nx;
    const az = this.lastZ - nz;
    const bx = this.lastX + nx;
    const bz = this.lastZ + nz;
    const cx = x - nx;
    const cz = z - nz;
    const ex = x + nx;
    const ez = z + nz;

    const base = this.headSeg * 18;
    const arr = this.posAttr.array as Float32Array;
    arr[base + 0] = ax; arr[base + 1] = this.lastY; arr[base + 2] = az;
    arr[base + 3] = bx; arr[base + 4] = this.lastY; arr[base + 5] = bz;
    arr[base + 6] = cx; arr[base + 7] = y; arr[base + 8] = cz;
    arr[base + 9] = bx; arr[base + 10] = this.lastY; arr[base + 11] = bz;
    arr[base + 12] = ex; arr[base + 13] = y; arr[base + 14] = ez;
    arr[base + 15] = cx; arr[base + 16] = y; arr[base + 17] = cz;

    this.posAttr.needsUpdate = true;
    this.headSeg = (this.headSeg + 1) % this.maxSegments;

    this.lastX = x;
    this.lastY = y;
    this.lastZ = z;
  }

  public breakTrail(): void {
    this.hasLast = false;
  }

  public clear(): void {
    (this.posAttr.array as Float32Array).fill(0);
    this.posAttr.needsUpdate = true;
    this.headSeg = 0;
    this.hasLast = false;
  }
}

interface LimbSegment {
  mesh: THREE.Object3D;
}

const UP_AXIS = new THREE.Vector3(0, 1, 0);

/**
 * Fixie de pista Cinelli Mash + 4 arquetipos detallados estilo alleycat/streetwear:
 * - Geometría compacta de pista + spoke card trasera + hop-skid y balanceo en sprint de pie.
 * - Brazos e IK de piernas acoplados al manillar giratorio y al piñón fijo en todo momento.
 * - Ropa suelta articulada (chaqueta/camiseta ondeando atrás, pantalón ancho Carhartt, bandolera Chrome).
 */
export class FixieAvatar {
  public readonly root = new THREE.Group();
  private readonly yawGroup = new THREE.Group();
  private readonly whipPivot = new THREE.Group();
  private readonly slopeGroup = new THREE.Group();
  private readonly hopGroup = new THREE.Group();
  private readonly leanGroup = new THREE.Group();
  private readonly frontForkGroup = new THREE.Group();

  private readonly rearWheel = new THREE.Group();
  private readonly frontWheel = new THREE.Group();
  private readonly crankGroup = new THREE.Group();

  private readonly riderGroup = new THREE.Group();
  private readonly torsoGroup = new THREE.Group();
  private readonly headGroup = new THREE.Group();
  private readonly jacketFlapGroup = new THREE.Group();
  private readonly hairFlowGroup = new THREE.Group();
  private readonly keychainGroup = new THREE.Group();
  private readonly riderCostumeRoot = new THREE.Group();

  private readonly leftThigh = new THREE.Group();
  private readonly leftShin = new THREE.Group();
  private readonly leftFootGroup = new THREE.Group();
  private readonly rightThigh = new THREE.Group();
  private readonly rightShin = new THREE.Group();
  private readonly rightFootGroup = new THREE.Group();

  private readonly leftUpperArm: LimbSegment;
  private readonly leftForearm: LimbSegment;
  private readonly leftHandMesh: THREE.Group;
  private readonly rightUpperArm: LimbSegment;
  private readonly rightForearm: LimbSegment;
  private readonly rightHandMesh: THREE.Group;

  private readonly wheelRadius = 0.345;
  private readonly frontContactZ = -0.57;
  private readonly rearContactZ = 0.39;
  private readonly bbPos = { f: 0.0, u: 0.285 };
  private readonly crankRadius = 0.17;
  private wheelSpinAngle = 0;
  private simTime = 0;

  private hipShiftF = 0;
  private hipShiftU = 0;
  private currentPreset: RiderPresetId = 'ryuji';

  private readonly armA = new THREE.Vector3();
  private readonly armB = new THREE.Vector3();
  private readonly armDir = new THREE.Vector3();
  private readonly armBend = new THREE.Vector3();
  private readonly armElbow = new THREE.Vector3();

  // Materiales reutilizables por personaje (actualizables al cambiar preset sin reconstruir toda la bici)
  private readonly matSkin = new THREE.MeshStandardNodeMaterial({ color: 0xe2b49a, roughness: 0.72, metalness: 0.02 });
  private readonly matHair = new THREE.MeshStandardNodeMaterial({ color: 0xebd7a7, roughness: 0.85, metalness: 0.02 });
  private readonly matJacket = new THREE.MeshStandardNodeMaterial({ color: 0x3b4440, roughness: 0.82, metalness: 0.04 });
  private readonly matInner = new THREE.MeshStandardNodeMaterial({ color: 0x202c44, roughness: 0.85, metalness: 0.02 });
  private readonly matPants = new THREE.MeshStandardNodeMaterial({ color: 0x625d62, roughness: 0.88, metalness: 0.03 });
  private readonly matSocks = new THREE.MeshStandardNodeMaterial({ color: 0x1d2b4e, roughness: 0.84, metalness: 0.02 });
  private readonly matShoeUpper = new THREE.MeshStandardNodeMaterial({ color: 0xa2a6ad, roughness: 0.72, metalness: 0.05 });
  private readonly matShoeSole = new THREE.MeshStandardNodeMaterial({ color: 0xedeef2, roughness: 0.78, metalness: 0.02 });
  private readonly matGlove = new THREE.MeshStandardNodeMaterial({ color: 0x1b1d22, roughness: 0.75, metalness: 0.06 });
  private readonly matGloveTrim = new THREE.MeshStandardNodeMaterial({ color: 0xf0f1f4, roughness: 0.6, metalness: 0.04 });
  private readonly matSling = new THREE.MeshStandardNodeMaterial({ color: 0x5d2233, roughness: 0.76, metalness: 0.06 });
  private readonly matMetalSilver = new THREE.MeshStandardNodeMaterial({ color: 0xd0d5dd, roughness: 0.28, metalness: 0.82 });
  private readonly matDarkTrim = new THREE.MeshStandardNodeMaterial({ color: 0x181a20, roughness: 0.55, metalness: 0.25 });
  private readonly matLeatherPatch = new THREE.MeshStandardNodeMaterial({ color: 0x9b6434, roughness: 0.75, metalness: 0.04 });

  // Elementos específicos cuya visibilidad varía por preset
  private readonly hairStyleGroups: Record<RiderLookSpec['hairStyle'], THREE.Group> = {
    bleached_spiky: new THREE.Group(),
    dreads: new THREE.Group(),
    buzz: new THREE.Group(),
    cornrows: new THREE.Group(),
  };
  private readonly sunglassesGroup = new THREE.Group();
  private readonly chromeSlingGroup = new THREE.Group();
  private readonly carharttPatchMesh: THREE.Mesh;
  private readonly beltGroup = new THREE.Group();
  private readonly leftSleeveShortMesh: THREE.Mesh;
  private readonly rightSleeveShortMesh: THREE.Mesh;
  private readonly leftLongSleeveMesh: THREE.Mesh;
  private readonly rightLongSleeveMesh: THREE.Mesh;
  private readonly leftBareForearmMesh: THREE.Mesh;
  private readonly rightBareForearmMesh: THREE.Mesh;
  private readonly leftGloveGraphicMesh: THREE.Mesh;
  private readonly rightGloveGraphicMesh: THREE.Mesh;
  private readonly wristWatchMesh: THREE.Mesh;
  private readonly tattooPatchMesh: THREE.Mesh;

  constructor(initialPreset: RiderPresetId = 'ryuji') {
    this.root.name = 'fixie-avatar';
    this.root.add(this.yawGroup);

    this.whipPivot.position.set(0, 0, this.frontContactZ);
    this.yawGroup.add(this.whipPivot);

    this.slopeGroup.position.set(0, 0, -this.frontContactZ);
    this.whipPivot.add(this.slopeGroup);
    this.slopeGroup.add(this.hopGroup);
    this.hopGroup.add(this.leanGroup);

    // Sombra de contacto en suelo (no se eleva en hop-skid)
    const contactShadowMat = new THREE.MeshBasicMaterial({
      color: 0x161920,
      transparent: true,
      opacity: 0.30,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
    });
    const contactShadowGeom = new THREE.CircleGeometry(0.62, 16);
    contactShadowGeom.rotateX(-Math.PI / 2);
    contactShadowGeom.scale(0.52, 1, 1.38);
    const contactShadow = new THREE.Mesh(contactShadowGeom, contactShadowMat);
    contactShadow.position.set(0, 0.02, -0.09);
    this.slopeGroup.add(contactShadow);

    this.buildCinelliMashBike();

    // === RIDER DETALLADO ESTILO ALLEYCAT / STREETWEAR ===
    this.leanGroup.add(this.riderGroup);
    this.riderGroup.add(this.riderCostumeRoot);

    // Cadera ancha (pantalón loose Carhartt / workwear)
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.255, 0.16, 0.21), this.matPants);
    pelvis.position.set(0, 1.055, 0.145);
    pelvis.castShadow = true;
    this.riderCostumeRoot.add(pelvis);

    // Cinturón negro + hebilla metálica
    const beltBand = new THREE.Mesh(new THREE.BoxGeometry(0.262, 0.026, 0.216), this.matDarkTrim);
    beltBand.position.set(0, 1.125, 0.145);
    this.beltGroup.add(beltBand);
    this.riderCostumeRoot.add(this.beltGroup);

    // Parche Carhartt marrón en bolsillo trasero derecho
    this.carharttPatchMesh = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.034, 0.006), this.matLeatherPatch);
    this.carharttPatchMesh.position.set(0.072, 1.045, 0.253);
    this.riderCostumeRoot.add(this.carharttPatchMesh);

    // Llavero / mosquetón lateral colgando del cinturón derecho
    this.keychainGroup.position.set(0.132, 1.11, 0.13);
    const carabiner = new THREE.Mesh(new THREE.TorusGeometry(0.016, 0.004, 6, 12), this.matMetalSilver);
    const keyTag = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.055, 0.022), this.matMetalSilver);
    keyTag.position.set(0.004, -0.035, 0.006);
    this.keychainGroup.add(carabiner, keyTag);
    this.riderCostumeRoot.add(this.keychainGroup);

    // Torso articulado
    this.torsoGroup.position.set(0, 1.07, 0.13);
    this.torsoGroup.rotation.x = -0.88;
    this.riderGroup.add(this.torsoGroup);

    // Prenda exterior superior + camiseta interior asomando en cuello/bajo
    const chestMain = new THREE.Mesh(new THREE.BoxGeometry(0.325, 0.41, 0.215), this.matJacket);
    chestMain.position.set(0, 0.215, 0);
    chestMain.castShadow = true;
    const shoulders = new THREE.Mesh(new THREE.BoxGeometry(0.37, 0.125, 0.195), this.matJacket);
    shoulders.position.set(0, 0.365, -0.005);
    shoulders.castShadow = true;
    const innerCollar = new THREE.Mesh(new THREE.CylinderGeometry(0.068, 0.078, 0.06, 10), this.matInner);
    innerCollar.position.set(0, 0.435, -0.015);
    const innerWaist = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.055, 0.19), this.matInner);
    innerWaist.position.set(0, 0.01, 0.005);
    this.torsoGroup.add(chestMain, shoulders, innerCollar, innerWaist);

    // Faldón trasero de chaqueta/camiseta que ondea al viento (como foto 1 y foto 3)
    this.jacketFlapGroup.position.set(0, 0.06, 0.095);
    const flapLeft = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.18, 0.038), this.matJacket);
    flapLeft.position.set(-0.088, -0.075, 0.008);
    flapLeft.rotation.z = 0.06;
    flapLeft.castShadow = true;
    const flapRight = new THREE.Mesh(new THREE.BoxGeometry(0.165, 0.18, 0.038), this.matJacket);
    flapRight.position.set(0.088, -0.075, 0.008);
    flapRight.rotation.z = -0.06;
    flapRight.castShadow = true;
    this.jacketFlapGroup.add(flapLeft, flapRight);
    this.torsoGroup.add(this.jacketFlapGroup);

    // Bandolera Chrome Kadet cruzada sobre la espalda (Dante - Foto 3)
    const slingPack = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.165, 0.115), this.matSling);
    slingPack.position.set(0.01, 0.18, 0.145);
    slingPack.rotation.z = 0.56;
    slingPack.castShadow = true;
    const slingLogo = new THREE.Mesh(new THREE.BoxGeometry(0.034, 0.034, 0.01), this.matGloveTrim);
    slingLogo.position.set(0.02, 0.175, 0.205);
    slingLogo.rotation.z = 0.56;
    const slingStrap = new THREE.Mesh(new THREE.BoxGeometry(0.058, 0.44, 0.03), this.matDarkTrim);
    slingStrap.position.set(-0.075, 0.28, 0.095);
    slingStrap.rotation.z = 0.56;
    const slingFrontStrap = new THREE.Mesh(new THREE.BoxGeometry(0.054, 0.42, 0.03), this.matDarkTrim);
    slingFrontStrap.position.set(-0.07, 0.26, -0.105);
    slingFrontStrap.rotation.z = 0.56;
    this.chromeSlingGroup.add(slingPack, slingLogo, slingStrap, slingFrontStrap);
    this.torsoGroup.add(this.chromeSlingGroup);

    // Cabeza anatómica + peinados detallados + gafas
    this.buildDetailedHead();

    // Piernas anchas Carhartt + calcetines altos + zapatillas detalladas
    this.buildLeg(this.leftThigh, this.leftShin, this.leftFootGroup, -0.10);
    this.buildLeg(this.rightThigh, this.rightShin, this.rightFootGroup, 0.10);

    // Brazos articulados con IK conectados directamente a la curva baja de los drops
    const buildArmParts = (side: -1 | 1) => {
      const upperGroup = new THREE.Group();
      // Manga superior ancha + variante manga corta oversized
      const longUpperSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.048, 0.29, 8), this.matJacket);
      longUpperSleeve.castShadow = true;
      const shortUpperSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.062, 0.068, 0.21, 8), this.matJacket);
      shortUpperSleeve.position.y = 0.035;
      shortUpperSleeve.castShadow = true;
      upperGroup.add(longUpperSleeve, shortUpperSleeve);
      this.leanGroup.add(upperGroup);

      const forearmGroup = new THREE.Group();
      const longForeSleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.038, 0.27, 8), this.matJacket);
      longForeSleeve.castShadow = true;
      const bareForearm = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.030, 0.27, 8), this.matSkin);
      bareForearm.castShadow = true;
      forearmGroup.add(longForeSleeve, bareForearm);
      this.leanGroup.add(forearmGroup);

      const handGroup = new THREE.Group();
      const gloveBase = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.056, 0.060), this.matGlove);
      const gloveBack = new THREE.Mesh(new THREE.BoxGeometry(0.040, 0.036, 0.012), this.matGloveTrim);
      gloveBack.position.set(side * 0.005, 0.006, 0.029);
      handGroup.add(gloveBase, gloveBack);
      this.leanGroup.add(handGroup);

      return {
        upperGroup,
        longUpperSleeve,
        shortUpperSleeve,
        forearmGroup,
        longForeSleeve,
        bareForearm,
        handGroup,
        gloveBack,
      };
    };

    const leftArm = buildArmParts(-1);
    const rightArm = buildArmParts(1);
    this.leftUpperArm = { mesh: leftArm.upperGroup };
    this.leftForearm = { mesh: leftArm.forearmGroup };
    this.leftHandMesh = leftArm.handGroup;
    this.rightUpperArm = { mesh: rightArm.upperGroup };
    this.rightForearm = { mesh: rightArm.forearmGroup };
    this.rightHandMesh = rightArm.handGroup;

    this.leftSleeveShortMesh = leftArm.shortUpperSleeve;
    this.rightSleeveShortMesh = rightArm.shortUpperSleeve;
    this.leftLongSleeveMesh = leftArm.longForeSleeve;
    this.rightLongSleeveMesh = rightArm.longForeSleeve;
    this.leftBareForearmMesh = leftArm.bareForearm;
    this.rightBareForearmMesh = rightArm.bareForearm;
    this.leftGloveGraphicMesh = leftArm.gloveBack;
    this.rightGloveGraphicMesh = rightArm.gloveBack;

    // Pulsera metálica / tatuaje antebrazo
    this.wristWatchMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.037, 0.037, 0.022, 8), this.matMetalSilver);
    this.wristWatchMesh.position.y = -0.10;
    leftArm.forearmGroup.add(this.wristWatchMesh);

    this.tattooPatchMesh = new THREE.Mesh(new THREE.BoxGeometry(0.044, 0.055, 0.044), this.matDarkTrim);
    this.tattooPatchMesh.position.y = -0.06;
    rightArm.forearmGroup.add(this.tattooPatchMesh);

    this.setPreset(initialPreset);
  }

  public getPreset(): RiderPresetId {
    return this.currentPreset;
  }

  public setPreset(preset: RiderPresetId): void {
    this.currentPreset = preset;
    const spec = PRESET_SPECS[preset];

    this.matSkin.color.setHex(spec.skin);
    this.matHair.color.setHex(spec.hair);
    this.matJacket.color.setHex(spec.jacket);
    this.matInner.color.setHex(spec.innerShirt);
    this.matPants.color.setHex(spec.pants);
    this.matSocks.color.setHex(spec.socks);
    this.matShoeUpper.color.setHex(spec.shoeUpper);
    this.matShoeSole.color.setHex(spec.shoeSole);
    this.matGlove.color.setHex(spec.gloveColor);
    this.matSling.color.setHex(spec.slingColor);

    for (const styleKey of Object.keys(this.hairStyleGroups) as RiderLookSpec['hairStyle'][]) {
      this.hairStyleGroups[styleKey].visible = spec.hairStyle === styleKey;
    }
    this.sunglassesGroup.visible = spec.sunglasses;
    this.chromeSlingGroup.visible = spec.chromeSling;
    this.carharttPatchMesh.visible = spec.carharttPatch;
    this.beltGroup.visible = spec.beltBuckle;
    this.keychainGroup.visible = spec.hipKeychain;
    this.jacketFlapGroup.visible = spec.looseFlap;

    this.leftSleeveShortMesh.visible = spec.shortSleeves;
    this.rightSleeveShortMesh.visible = spec.shortSleeves;
    this.leftLongSleeveMesh.visible = !spec.shortSleeves;
    this.rightLongSleeveMesh.visible = !spec.shortSleeves;
    this.leftBareForearmMesh.visible = spec.shortSleeves;
    this.rightBareForearmMesh.visible = spec.shortSleeves;

    this.leftGloveGraphicMesh.visible = spec.gloveWhiteBack;
    this.rightGloveGraphicMesh.visible = spec.gloveWhiteBack;
    this.wristWatchMesh.visible = spec.wristSilver;
    this.tattooPatchMesh.visible = spec.forearmTattoo;
  }

  private buildDetailedHead(): void {
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.054, 0.09, 8), this.matSkin);
    neck.position.set(0, 0.455, -0.02);
    neck.rotation.x = 0.25;
    this.torsoGroup.add(neck);

    this.headGroup.position.set(0, 0.545, -0.03);
    this.headGroup.rotation.x = 0.44;
    this.torsoGroup.add(this.headGroup);

    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.102, 12, 10), this.matSkin);
    skull.scale.set(0.92, 1.05, 1.0);
    skull.castShadow = true;
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.085, 0.11), this.matSkin);
    jaw.position.set(0, -0.055, -0.025);
    const earL = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.048, 0.032), this.matSkin);
    earL.position.set(-0.095, -0.005, 0.01);
    const earR = earL.clone();
    earR.position.x = 0.095;
    this.headGroup.add(skull, jaw, earL, earR);

    // Gafas de sol negras (Kuro)
    const glassesBridge = new THREE.Mesh(new THREE.BoxGeometry(0.155, 0.034, 0.025), this.matDarkTrim);
    glassesBridge.position.set(0, 0.012, -0.102);
    this.sunglassesGroup.add(glassesBridge);
    this.headGroup.add(this.sunglassesGroup);

    // --- Peinado 1: Rubio decolorado despeinado (Ryuji - Foto 1) ---
    const gSpiky = this.hairStyleGroups.bleached_spiky;
    const spikyCap = new THREE.Mesh(new THREE.SphereGeometry(0.108, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.56), this.matHair);
    spikyCap.position.set(0, 0.018, 0.008);
    gSpiky.add(spikyCap);
    const spikeOffsets: Array<[number, number, number, number, number]> = [
      [0, 0.115, -0.035, -0.45, 0.0],
      [-0.045, 0.105, -0.025, -0.35, 0.42],
      [0.045, 0.105, -0.025, -0.35, -0.42],
      [-0.03, 0.108, 0.03, 0.35, 0.32],
      [0.03, 0.108, 0.03, 0.35, -0.32],
      [0, 0.095, 0.07, 0.65, 0.0],
      [-0.065, 0.075, 0.035, 0.3, 0.68],
      [0.065, 0.075, 0.035, 0.3, -0.68],
    ];
    for (const [sx, sy, sz, rx, rz] of spikeOffsets) {
      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.085, 5), this.matHair);
      tuft.position.set(sx, sy, sz);
      tuft.rotation.set(rx, 0, rz);
      tuft.castShadow = true;
      gSpiky.add(tuft);
    }
    this.headGroup.add(gSpiky);

    // --- Peinado 2: Rastas / Locs recogidas con caída trasera (Dante - Foto 3) ---
    const gDreads = this.hairStyleGroups.dreads;
    const dreadCrown = new THREE.Mesh(new THREE.SphereGeometry(0.108, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.56), this.matHair);
    dreadCrown.position.set(0, 0.018, 0.015);
    gDreads.add(dreadCrown);
    this.hairFlowGroup.position.set(0, 0.06, 0.085);
    for (let i = 0; i < 9; i++) {
      const angle = (i - 4) * 0.24;
      const len = 0.15 + (i % 3) * 0.035;
      const loc = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.011, len, 6), this.matHair);
      loc.position.set(Math.sin(angle) * 0.055, -len * 0.36 + (i % 2) * 0.018, 0.035 + Math.abs(Math.cos(angle)) * 0.025);
      loc.rotation.set(0.38, 0, angle * 0.45);
      loc.castShadow = true;
      this.hairFlowGroup.add(loc);
    }
    gDreads.add(this.hairFlowGroup);
    this.headGroup.add(gDreads);

    // --- Peinado 3: Fade / buzz oscuro corto (Kuro - Foto 2 izq) ---
    const gBuzz = this.hairStyleGroups.buzz;
    const buzzCap = new THREE.Mesh(new THREE.SphereGeometry(0.106, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.54), this.matHair);
    buzzCap.position.set(0, 0.015, 0.01);
    gBuzz.add(buzzCap);
    this.headGroup.add(gBuzz);

    // --- Peinado 4: Trenzas pegadas / Cornrows (Niko - Foto 2 centro) ---
    const gCorn = this.hairStyleGroups.cornrows;
    const cornBase = new THREE.Mesh(new THREE.SphereGeometry(0.104, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.54), this.matSkin);
    cornBase.position.set(0, 0.01, 0.01);
    gCorn.add(cornBase);
    for (let i = -2; i <= 2; i++) {
      const braid = new THREE.Mesh(new THREE.CylinderGeometry(0.013, 0.012, 0.20, 6), this.matHair);
      braid.position.set(i * 0.028, 0.088 - Math.abs(i) * 0.012, 0.008);
      braid.rotation.x = Math.PI / 2 + 0.15;
      gCorn.add(braid);
    }
    this.headGroup.add(gCorn);
  }

  private buildLeg(thighGroup: THREE.Group, shinGroup: THREE.Group, footGroup: THREE.Group, xSide: number): void {
    thighGroup.position.set(xSide, 1.05, 0.14);
    this.riderGroup.add(thighGroup);

    // Muslo ancho workwear / Carhartt
    const thighMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.086, 0.082, 0.40, 8), this.matPants);
    thighMesh.position.set(0, -0.20, 0);
    thighMesh.castShadow = true;
    thighGroup.add(thighMesh);

    shinGroup.position.set(0, -0.40, 0);
    thighGroup.add(shinGroup);

    // Pantalón holgado hasta mitad de pantorrilla + pliegue / cuff sobre calcetín alto
    const upperPant = new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.088, 0.21, 8), this.matPants);
    upperPant.position.set(0, -0.105, 0);
    upperPant.castShadow = true;

    const cuffLip = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.088, 0.036, 8), this.matPants);
    cuffLip.position.set(0, -0.205, 0);

    const sockMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.038, 0.18, 8), this.matSocks);
    sockMesh.position.set(0, -0.295, 0);
    sockMesh.castShadow = true;

    footGroup.position.set(0, -0.38, 0);
    const shoeUpper = new THREE.Mesh(new THREE.BoxGeometry(0.092, 0.048, 0.195), this.matShoeUpper);
    shoeUpper.position.set(0, 0.004, -0.04);
    shoeUpper.castShadow = true;
    const shoeSole = new THREE.Mesh(new THREE.BoxGeometry(0.098, 0.022, 0.205), this.matShoeSole);
    shoeSole.position.set(0, -0.025, -0.04);
    const strapBand = new THREE.Mesh(new THREE.BoxGeometry(0.102, 0.026, 0.045), this.matDarkTrim);
    strapBand.position.set(0, 0.005, -0.055);
    footGroup.add(shoeUpper, shoeSole, strapBand);

    shinGroup.add(upperPant, cuffLip, sockMesh, footGroup);
  }

  private buildCinelliMashBike(): void {
    const frameAlloyMat = new THREE.MeshStandardNodeMaterial({ color: 0xaeb4bc, roughness: 0.30, metalness: 0.78 });
    const frameGraphicMat = new THREE.MeshStandardNodeMaterial({ color: 0x1e2128, roughness: 0.45, metalness: 0.30 });
    const accentDecalMat = new THREE.MeshStandardNodeMaterial({ color: 0xd93829, roughness: 0.45, metalness: 0.2 });
    const blackAnoMat = new THREE.MeshStandardNodeMaterial({ color: 0x191c22, roughness: 0.42, metalness: 0.52 });
    const deepRimMat = new THREE.MeshStandardNodeMaterial({ color: 0x242830, roughness: 0.36, metalness: 0.45 });
    const tireMat = new THREE.MeshStandardNodeMaterial({ color: 0x14161b, roughness: 0.86, metalness: 0.04 });
    const spokeSilverMat = new THREE.MeshStandardNodeMaterial({ color: 0xd0d5dd, roughness: 0.32, metalness: 0.75 });
    const spokeCardMat = new THREE.MeshStandardNodeMaterial({ color: 0xf4c430, roughness: 0.5, metalness: 0.05 });

    const buildWheel = (wheelGroup: THREE.Group, withSpokeCard: boolean): void => {
      const tireGeom = new THREE.TorusGeometry(this.wheelRadius - 0.015, 0.015, 8, 28);
      tireGeom.rotateY(Math.PI / 2);
      const tire = new THREE.Mesh(tireGeom, tireMat);
      tire.castShadow = true;

      const rimGeom = new THREE.TorusGeometry(this.wheelRadius - 0.042, 0.019, 6, 28);
      rimGeom.rotateY(Math.PI / 2);
      const rim = new THREE.Mesh(rimGeom, deepRimMat);

      const hubGeom = new THREE.CylinderGeometry(0.026, 0.026, 0.105, 10);
      hubGeom.rotateZ(Math.PI / 2);
      const hub = new THREE.Mesh(hubGeom, spokeSilverMat);

      const spokeGeom = new THREE.CylinderGeometry(0.0035, 0.0035, (this.wheelRadius - 0.055) * 2, 4);
      for (let i = 0; i < 6; i++) {
        const sp = new THREE.Mesh(spokeGeom, spokeSilverMat);
        sp.rotation.x = (i / 6) * Math.PI;
        wheelGroup.add(sp);
      }

      if (withSpokeCard) {
        // Spoke card tricolor clásica de mensajero en la rueda trasera (Foto 1)
        const card = new THREE.Mesh(new THREE.BoxGeometry(0.005, 0.095, 0.068), spokeCardMat);
        card.position.set(0.008, -0.175, 0.05);
        card.rotation.x = 0.25;
        wheelGroup.add(card);
      }

      wheelGroup.add(tire, rim, hub);
    };

    buildWheel(this.rearWheel, true);
    this.rearWheel.position.set(0, this.wheelRadius, this.rearContactZ);
    this.leanGroup.add(this.rearWheel);

    this.frontForkGroup.position.set(0, 0.72, -0.43);
    this.leanGroup.add(this.frontForkGroup);

    buildWheel(this.frontWheel, false);
    this.frontWheel.position.set(0, this.wheelRadius - 0.72, this.frontContactZ - -0.43);
    this.frontForkGroup.add(this.frontWheel);

    const addTube = (
      parent: THREE.Object3D,
      p0: [number, number, number],
      p1: [number, number, number],
      rBottom: number,
      mat: THREE.Material,
      rTop = rBottom
    ): void => {
      const a = new THREE.Vector3(...p0);
      const b = new THREE.Vector3(...p1);
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 1e-4) return;
      const geom = new THREE.CylinderGeometry(rTop, rBottom, len, 8);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(UP_AXIS, dir.normalize());
      mesh.castShadow = true;
      parent.add(mesh);
    };

    // === GEOMETRÍA CINELLI MASH PISTA ===
    addTube(this.leanGroup, [0, 0.285, 0.0], [0, 0.855, 0.145], 0.019, frameAlloyMat);
    addTube(this.leanGroup, [0, 0.675, -0.435], [0, 0.845, -0.39], 0.025, frameAlloyMat, 0.022);
    addTube(this.leanGroup, [0, 0.835, 0.14], [0, 0.822, -0.395], 0.019, frameAlloyMat);
    addTube(this.leanGroup, [0, 0.295, -0.01], [0, 0.695, -0.425], 0.026, frameAlloyMat, 0.024);
    addTube(this.leanGroup, [0, 0.39, -0.10], [0, 0.59, -0.32], 0.0265, frameGraphicMat, 0.0255);
    addTube(this.leanGroup, [0, 0.365, -0.075], [0, 0.392, -0.105], 0.0268, accentDecalMat);

    addTube(this.leanGroup, [-0.032, 0.285, 0.0], [-0.052, this.wheelRadius, this.rearContactZ], 0.015, frameAlloyMat, 0.011);
    addTube(this.leanGroup, [0.032, 0.285, 0.0], [0.052, this.wheelRadius, this.rearContactZ], 0.015, frameAlloyMat, 0.011);
    addTube(this.leanGroup, [-0.018, 0.815, 0.135], [-0.050, this.wheelRadius, this.rearContactZ], 0.009, frameAlloyMat);
    addTube(this.leanGroup, [0.018, 0.815, 0.135], [0.050, this.wheelRadius, this.rearContactZ], 0.009, frameAlloyMat);

    // Tija plateada + sillín racing negro
    addTube(this.leanGroup, [0, 0.85, 0.144], [0, 0.985, 0.178], 0.014, spokeSilverMat);
    const saddleGroup = new THREE.Group();
    saddleGroup.position.set(0, 0.995, 0.17);
    const saddleRear = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.028, 0.14), blackAnoMat);
    saddleRear.position.set(0, 0, 0.05);
    const saddleNose = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.024, 0.15), blackAnoMat);
    saddleNose.position.set(0, -0.002, -0.06);
    saddleGroup.add(saddleRear, saddleNose);
    this.leanGroup.add(saddleGroup);

    // Horquilla + potencia track plateada + manillar Pista Drops
    addTube(this.frontForkGroup, [-0.022, -0.035, -0.005], [-0.048, this.wheelRadius - 0.72, -0.14], 0.011, frameAlloyMat, 0.018);
    addTube(this.frontForkGroup, [0.022, -0.035, -0.005], [0.048, this.wheelRadius - 0.72, -0.14], 0.011, frameAlloyMat, 0.018);
    addTube(this.frontForkGroup, [0, 0.125, 0.04], [0, 0.148, 0.045], 0.015, spokeSilverMat);
    addTube(this.frontForkGroup, [0, 0.148, 0.045], [0, 0.136, -0.070], 0.016, spokeSilverMat);

    const barCurvePts = [
      new THREE.Vector3(-0.20, 0.002, 0.028),
      new THREE.Vector3(-0.20, 0.028, -0.065),
      new THREE.Vector3(-0.20, 0.088, -0.095),
      new THREE.Vector3(-0.18, 0.136, -0.070),
      new THREE.Vector3(0.0, 0.136, -0.070),
      new THREE.Vector3(0.18, 0.136, -0.070),
      new THREE.Vector3(0.20, 0.088, -0.095),
      new THREE.Vector3(0.20, 0.028, -0.065),
      new THREE.Vector3(0.20, 0.002, 0.028),
    ];
    const barCurve = new THREE.CatmullRomCurve3(barCurvePts);
    const barGeom = new THREE.TubeGeometry(barCurve, 36, 0.013, 8, false);
    const barMesh = new THREE.Mesh(barGeom, blackAnoMat);
    barMesh.castShadow = true;
    this.frontForkGroup.add(barMesh);

    // Transmisión piñón fijo: plato 49T + bielas + piñón + cadena
    this.crankGroup.position.set(0, this.bbPos.u, this.bbPos.f);
    this.leanGroup.add(this.crankGroup);

    const chainring = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.008, 22), blackAnoMat);
    chainring.rotation.z = Math.PI / 2;
    chainring.position.set(0.048, 0, 0);
    const rearCog = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.008, 12), blackAnoMat);
    rearCog.rotation.z = Math.PI / 2;
    rearCog.position.set(0.048, 0, 0);
    this.rearWheel.add(rearCog);
    this.crankGroup.add(chainring);

    addTube(this.crankGroup, [-0.068, 0, 0], [-0.068, -this.crankRadius, 0], 0.011, blackAnoMat);
    addTube(this.crankGroup, [0.068, 0, 0], [0.068, this.crankRadius, 0], 0.011, blackAnoMat);

    addTube(this.leanGroup, [0.048, this.bbPos.u + 0.10, 0], [0.048, this.wheelRadius + 0.034, this.rearContactZ], 0.004, spokeSilverMat);
    addTube(this.leanGroup, [0.048, this.bbPos.u - 0.10, 0], [0.048, this.wheelRadius - 0.034, this.rearContactZ], 0.004, spokeSilverMat);
  }

  public getRearTireWorldXZ(travelYaw: number, bikeX: number, bikeZ: number, whipAngle: number): [number, number] {
    const frontX = bikeX + Math.sin(travelYaw) * this.frontContactZ;
    const frontZ = bikeZ + Math.cos(travelYaw) * this.frontContactZ;
    const rearOffsetFromFront = this.rearContactZ - this.frontContactZ;
    const bodyYaw = travelYaw + whipAngle;
    return [
      frontX + Math.sin(bodyYaw) * rearOffsetFromFront,
      frontZ + Math.cos(bodyYaw) * rearOffsetFromFront,
    ];
  }

  public update(state: FixieVisualState, travelYaw: number, x: number, y: number, z: number, dt = 0.016): void {
    this.simTime += dt;
    this.root.position.set(x, y, z);
    this.yawGroup.rotation.y = travelYaw;
    this.whipPivot.rotation.y = state.whipAngle;
    this.slopeGroup.rotation.x = state.slopePitch;

    // Elevación trasera sutil en el arranque del hop-skid manteniendo la rueda delantera apoyada
    this.hopGroup.position.y = state.hopLiftM * 0.55;
    this.hopGroup.rotation.x = -state.hopLiftM * 0.65;

    // Balanceo lateral rítmico del cuadro al pedalear de pie (sprint "dancer")
    const rockAmp = state.standBlend * Math.min(1, Math.abs(state.speedMs) / 5.0 + 0.25) * (state.isSkidding ? 0.02 : 0.11);
    const frameRock = Math.sin(state.crankAngle) * rockAmp;
    this.leanGroup.rotation.z = state.leanAngle + frameRock;

    this.frontForkGroup.rotation.y = state.steerAngle;

    // Rueda delantera siempre rueda; la trasera y las bielas van solidarizadas en piñón fijo
    const wheelDelta = (state.speedMs / this.wheelRadius) * dt;
    this.wheelSpinAngle += wheelDelta;
    this.frontWheel.rotation.x = -this.wheelSpinAngle;
    if (!state.isSkidding) {
      this.rearWheel.rotation.x = -this.wheelSpinAngle;
    }
    this.crankGroup.rotation.x = -state.crankAngle;

    // Postura real fixie: sprint de pie / track stand / aero tuck / skid "balls to stem"
    const speedKmh = Math.abs(state.speedMs) * 3.6;
    const aeroTuck = !state.isSkidding ? Math.min(1, Math.max(0, (speedKmh - 30) / 26)) : 0;

    const targetHipF = state.isSkidding
      ? 0.22
      : state.standBlend * 0.11 + aeroTuck * 0.02;
    const targetHipU = state.isSkidding
      ? 0.06
      : state.standBlend * 0.095;

    const smooth = Math.min(1, dt * 14);
    this.hipShiftF += (targetHipF - this.hipShiftF) * smooth;
    this.hipShiftU += (targetHipU - this.hipShiftU) * smooth;

    const riderRockX = -frameRock * 0.35;
    this.riderGroup.position.set(riderRockX, this.hipShiftU, -this.hipShiftF);

    const targetTorsoPitch = state.isSkidding
      ? -0.88
      : -0.96 - aeroTuck * 0.18 - state.standBlend * 0.08;
    this.torsoGroup.rotation.x += (targetTorsoPitch - this.torsoGroup.rotation.x) * smooth;

    // La cabeza compensa la inclinación del torso y mira hacia el giro (look-ahead)
    const targetHeadPitch = 0.78 + (-0.96 - this.torsoGroup.rotation.x) * 0.85;
    this.headGroup.rotation.x += (targetHeadPitch - this.headGroup.rotation.x) * smooth;
    this.headGroup.rotation.y += (state.lookYaw - this.headGroup.rotation.y) * Math.min(1, dt * 10);

    // Ondulación real del faldón de la chaqueta / camiseta y rastas con el aire
    const absSpeed = Math.abs(state.speedMs);
    const windBillow = Math.min(0.85, absSpeed * 0.052);
    const flutter = Math.sin(this.simTime * (10 + absSpeed * 0.9)) * (0.04 + Math.min(0.14, absSpeed * 0.01));
    this.jacketFlapGroup.rotation.x = 0.14 + windBillow + flutter;
    this.hairFlowGroup.rotation.x = 0.12 + windBillow * 0.55 + flutter * 0.6;
    this.keychainGroup.rotation.z = -state.leanAngle * 0.7 + Math.sin(this.simTime * 7) * (0.04 + Math.min(0.22, absSpeed * 0.015));

    // IK piernas + inclinación del tobillo en la pedalada
    this.solveLegIK(this.leftThigh, this.leftShin, this.leftFootGroup, state.crankAngle + Math.PI, state.isSkidding);
    this.solveLegIK(this.rightThigh, this.rightShin, this.rightFootGroup, state.crankAngle, state.isSkidding);

    // IK brazos agarrando los drops giratorios del manillar
    this.solveArmToDropBar(-1, state.steerAngle, riderRockX);
    this.solveArmToDropBar(1, state.steerAngle, riderRockX);
  }

  private solveLegIK(
    thighGroup: THREE.Group,
    shinGroup: THREE.Group,
    footGroup: THREE.Group,
    crankAng: number,
    isSkidding: boolean
  ): void {
    const hipF = -0.14 + this.hipShiftF;
    const hipU = 1.05 + this.hipShiftU;

    const pedalF = this.bbPos.f + Math.sin(crankAng) * this.crankRadius;
    const pedalU = this.bbPos.u + Math.cos(crankAng) * this.crankRadius;

    const df = pedalF - hipF;
    const du = pedalU - hipU;
    const L1 = 0.40;
    const L2 = 0.38;
    const maxReach = L1 + L2 - 0.02;
    const dist = Math.min(maxReach, Math.max(0.18, Math.hypot(df, du)));

    const baseAng = Math.atan2(df, -du);
    const cosA = Math.max(-1, Math.min(1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist)));
    const kneeBendOffset = Math.acos(cosA);

    const thighWorldAngle = baseAng + kneeBendOffset;
    const cosKnee = Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2)));
    const interiorKnee = Math.acos(cosKnee);

    thighGroup.rotation.x = thighWorldAngle;
    shinGroup.rotation.x = -(Math.PI - interiorKnee);

    // El pie compensa la suma de ángulos para mantenerse casi plano al pedal (+ ankling sutil)
    const shinWorldAngle = thighWorldAngle + shinGroup.rotation.x;
    const ankling = isSkidding ? -0.06 : Math.sin(crankAng) * 0.16;
    footGroup.rotation.x = -shinWorldAngle + ankling;
  }

  private solveArmToDropBar(side: -1 | 1, steerAngle: number, riderRockX: number): void {
    // 1. Posición del agarre en la curva delantera de los drops rotado por frontForkGroup.rotation.y
    const gx = side * 0.20;
    const gy = 0.072;
    const gz = -0.088;
    const cosS = Math.cos(steerAngle);
    const sinS = Math.sin(steerAngle);
    const handX = gx * cosS + gz * sinS;
    const handY = 0.72 + gy;
    const handZ = -0.43 - gx * sinS + gz * cosS;

    // 2. Posición del hombro en el espacio de leanGroup tras pitch del torso
    const shoulderLocalX = side * 0.175;
    const shoulderLocalY = 0.365;
    const shoulderLocalZ = -0.015;
    const pitch = this.torsoGroup.rotation.x;
    const cosP = Math.cos(pitch);
    const sinP = Math.sin(pitch);

    const rotY = shoulderLocalY * cosP - shoulderLocalZ * sinP;
    const rotZ = shoulderLocalY * sinP + shoulderLocalZ * cosP;

    const shoulderX = riderRockX + shoulderLocalX;
    const shoulderY = this.hipShiftU + 1.07 + rotY;
    const shoulderZ = -this.hipShiftF + 0.13 + rotZ;

    this.armA.set(shoulderX, shoulderY, shoulderZ);
    this.armB.set(handX, handY, handZ);
    this.armDir.subVectors(this.armB, this.armA);

    const L1 = 0.31;
    const L2 = 0.30;
    const rawDist = this.armDir.length();
    const dist = Math.min(L1 + L2 - 0.012, Math.max(0.14, rawDist));
    this.armDir.normalize();

    const proj = (L1 * L1 + dist * dist - L2 * L2) / (2 * dist);
    const perp = Math.sqrt(Math.max(0.0001, L1 * L1 - proj * proj));

    // Codo flexionado hacia abajo y ligeramente hacia fuera
    this.armBend.set(side * 0.42, -0.88, 0.24).normalize();
    const dot = this.armBend.dot(this.armDir);
    this.armBend.addScaledVector(this.armDir, -dot).normalize();

    this.armElbow
      .copy(this.armA)
      .addScaledVector(this.armDir, proj)
      .addScaledVector(this.armBend, perp);

    const upperSeg = side < 0 ? this.leftUpperArm : this.rightUpperArm;
    const foreSeg = side < 0 ? this.leftForearm : this.rightForearm;
    const handMesh = side < 0 ? this.leftHandMesh : this.rightHandMesh;

    this.placeLimbSegment(upperSeg.mesh, this.armA, this.armElbow, L1);
    this.placeLimbSegment(foreSeg.mesh, this.armElbow, this.armB, L2);

    handMesh.position.copy(this.armB);
    this.armDir.subVectors(this.armB, this.armElbow).normalize();
    handMesh.quaternion.setFromUnitVectors(UP_AXIS, this.armDir);
  }

  private placeLimbSegment(obj: THREE.Object3D, start: THREE.Vector3, end: THREE.Vector3, baseLength: number): void {
    this.armDir.subVectors(end, start);
    const len = this.armDir.length();
    obj.position.copy(start).addScaledVector(this.armDir, 0.5);
    obj.scale.set(1, Math.max(0.35, len / baseLength), 1);
    if (len > 1e-4) {
      obj.quaternion.setFromUnitVectors(UP_AXIS, this.armDir.normalize());
    }
  }
}
