import * as THREE from 'three/webgpu';

export interface FixieVisualState {
  speedMs: number;
  steerAngle: number;
  leanAngle: number;
  crankAngle: number;
  slopePitch: number;
  isSprinting: boolean;
  isSkidding: boolean;
  whipAngle: number;
}

/**
 * Trazo persistente de goma sobre el asfalto generado por la rueda trasera al derrapar (skid).
 * Usa un ring buffer de una sola malla para 0 asignaciones en runtime y 1 draw call.
 */
export class SkidTrailSystem {
  public readonly mesh: THREE.Mesh;
  private readonly maxSegments = 220;
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
      color: 0x1e2128,
      transparent: true,
      opacity: 0.62,
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
    if (dist < 0.22) return;
    if (dist > 6.0) {
      // Salto por teletransporte de POI: reiniciar trazo
      this.lastX = x;
      this.lastY = y;
      this.lastZ = z;
      return;
    }

    const halfW = 0.042;
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

/**
 * Modelo 3D inspirado en Cinelli Mash pista/pursuit de aluminio cepillado:
 * - Geometría compacta de pista: triángulo trasero ultra cerrado (75°), tubo horizontal agresivo,
 *   tubo diagonal sobredimensionado, horquilla recta cónica, potencia negativa (-17°) y manillar Pista drops.
 * - Pivote de derrape en la rueda delantera para que la rueda trasera ejecute el bamboleo real al hacer skid.
 */
export class FixieAvatar {
  public readonly root = new THREE.Group();
  private readonly yawGroup = new THREE.Group();
  private readonly whipPivot = new THREE.Group();
  private readonly slopeGroup = new THREE.Group();
  private readonly leanGroup = new THREE.Group();
  private readonly frontForkGroup = new THREE.Group();

  private readonly rearWheel = new THREE.Group();
  private readonly frontWheel = new THREE.Group();
  private readonly crankGroup = new THREE.Group();
  private readonly riderGroup = new THREE.Group();
  private readonly torsoGroup = new THREE.Group();

  private readonly leftThigh = new THREE.Group();
  private readonly leftShin = new THREE.Group();
  private readonly rightThigh = new THREE.Group();
  private readonly rightShin = new THREE.Group();

  private readonly wheelRadius = 0.345;
  private readonly frontContactZ = -0.57;
  private readonly rearContactZ = 0.39;
  private readonly bbPos = { f: 0.0, u: 0.285 }; // +f = hacia adelante (-Z), +u = arriba (+Y)
  private readonly crankRadius = 0.17;
  private wheelSpinAngle = 0;

  private hipShiftF = 0;
  private hipShiftU = 0;

  constructor() {
    this.root.name = 'fixie-avatar';
    this.root.add(this.yawGroup);

    // Pivote del bamboleo en la rueda delantera para que la trasera barra lateralmente en el skid
    this.whipPivot.position.set(0, 0, this.frontContactZ);
    this.yawGroup.add(this.whipPivot);

    this.slopeGroup.position.set(0, 0, -this.frontContactZ);
    this.whipPivot.add(this.slopeGroup);
    this.slopeGroup.add(this.leanGroup);

    // Sombra de contacto sutil bajo las ruedas
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

    // Materiales Cinelli Mash aluminio/titanio cepillado + componentes pista negros
    const frameAlloyMat = new THREE.MeshStandardNodeMaterial({
      color: 0xaeb4bc,
      roughness: 0.30,
      metalness: 0.78,
    });
    const frameGraphicMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1e2128,
      roughness: 0.45,
      metalness: 0.30,
    });
    const accentDecalMat = new THREE.MeshStandardNodeMaterial({
      color: 0xd93829,
      roughness: 0.45,
      metalness: 0.2,
    });
    const blackAnoMat = new THREE.MeshStandardNodeMaterial({
      color: 0x191c22,
      roughness: 0.42,
      metalness: 0.52,
    });
    const deepRimMat = new THREE.MeshStandardNodeMaterial({
      color: 0x242830,
      roughness: 0.36,
      metalness: 0.45,
    });
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x14161b,
      roughness: 0.86,
      metalness: 0.04,
    });
    const spokeSilverMat = new THREE.MeshStandardNodeMaterial({
      color: 0xd0d5dd,
      roughness: 0.32,
      metalness: 0.75,
    });
    const jerseyMat = new THREE.MeshStandardNodeMaterial({
      color: 0x262b35,
      roughness: 0.78,
      metalness: 0.04,
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x181b22,
      roughness: 0.82,
      metalness: 0.04,
    });
    const skinMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe4b69a,
      roughness: 0.74,
      metalness: 0.02,
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf6f6f8,
      roughness: 0.35,
      metalness: 0.08,
    });
    const bagMat = new THREE.MeshStandardNodeMaterial({
      color: 0xef6c47,
      roughness: 0.70,
      metalness: 0.05,
    });

    // Ruedas 700c de perfil medio-alto (~42mm) con radios finos metálicos
    const buildWheel = (wheelGroup: THREE.Group): void => {
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

      wheelGroup.add(tire, rim, hub);
    };

    buildWheel(this.rearWheel);
    this.rearWheel.position.set(0, this.wheelRadius, this.rearContactZ);
    this.leanGroup.add(this.rearWheel);

    // Dirección y horquilla de pista (ángulo pronunciado ~74.5°)
    this.frontForkGroup.position.set(0, 0.72, -0.43);
    this.leanGroup.add(this.frontForkGroup);

    buildWheel(this.frontWheel);
    this.frontWheel.position.set(0, this.wheelRadius - 0.72, this.frontContactZ - -0.43);
    this.frontForkGroup.add(this.frontWheel);

    const addTube = (
      parent: THREE.Object3D,
      p0: [number, number, number],
      p1: [number, number, number],
      rBottom: number,
      mat: THREE.Material,
      rTop = rBottom
    ): THREE.Mesh | null => {
      const a = new THREE.Vector3(...p0);
      const b = new THREE.Vector3(...p1);
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 1e-4) return null;
      const geom = new THREE.CylinderGeometry(rTop, rBottom, len, 8);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // === GEOMETRÍA CINELLI MASH ===
    // Pedalier (BB) en (0, 0.285, 0)
    // Tubo de sillín pronunciado (~75.5°) pasando muy cerca de la rueda trasera
    addTube(this.leanGroup, [0, 0.285, 0.0], [0, 0.855, 0.145], 0.019, frameAlloyMat);
    // Tubo de dirección (Head tube cónico)
    addTube(this.leanGroup, [0, 0.675, -0.435], [0, 0.845, -0.39], 0.025, frameAlloyMat, 0.022);
    // Tubo horizontal (top tube perfil pursuit recto y tenso)
    addTube(this.leanGroup, [0, 0.835, 0.14], [0, 0.822, -0.395], 0.019, frameAlloyMat);
    // Tubo diagonal sobredimensionado con detalles gráficos oscuros tipo Cinelli
    addTube(this.leanGroup, [0, 0.295, -0.01], [0, 0.695, -0.425], 0.026, frameAlloyMat, 0.024);
    addTube(this.leanGroup, [0, 0.39, -0.10], [0, 0.59, -0.32], 0.0265, frameGraphicMat, 0.0255);
    addTube(this.leanGroup, [0, 0.365, -0.075], [0, 0.392, -0.105], 0.0268, accentDecalMat);

    // Vainas traseras (chainstays ovaladas rectas y seatstays finos)
    addTube(this.leanGroup, [-0.032, 0.285, 0.0], [-0.052, this.wheelRadius, this.rearContactZ], 0.015, frameAlloyMat, 0.011);
    addTube(this.leanGroup, [0.032, 0.285, 0.0], [0.052, this.wheelRadius, this.rearContactZ], 0.015, frameAlloyMat, 0.011);
    addTube(this.leanGroup, [-0.018, 0.815, 0.135], [-0.050, this.wheelRadius, this.rearContactZ], 0.009, frameAlloyMat);
    addTube(this.leanGroup, [0.018, 0.815, 0.135], [0.050, this.wheelRadius, this.rearContactZ], 0.009, frameAlloyMat);

    // Tija negra + sillín plano racing (San Marco)
    addTube(this.leanGroup, [0, 0.85, 0.144], [0, 0.985, 0.178], 0.014, blackAnoMat);
    const saddleGroup = new THREE.Group();
    saddleGroup.position.set(0, 0.995, 0.17);
    const saddleRear = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.028, 0.14), blackAnoMat);
    saddleRear.position.set(0, 0, 0.05);
    const saddleNose = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.024, 0.15), blackAnoMat);
    saddleNose.position.set(0, -0.002, -0.06);
    saddleGroup.add(saddleRear, saddleNose);
    this.leanGroup.add(saddleGroup);

    // Horquilla recta cónica + potencia track slammed (-17°) + manillar Pista Drops curvo
    addTube(this.frontForkGroup, [-0.022, -0.035, -0.005], [-0.048, this.wheelRadius - 0.72, -0.14], 0.011, frameAlloyMat, 0.018);
    addTube(this.frontForkGroup, [0.022, -0.035, -0.005], [0.048, this.wheelRadius - 0.72, -0.14], 0.011, frameAlloyMat, 0.018);
    addTube(this.frontForkGroup, [0, 0.125, 0.04], [0, 0.148, 0.045], 0.015, blackAnoMat); // espaciador
    addTube(this.frontForkGroup, [0, 0.148, 0.045], [0, 0.136, -0.070], 0.016, blackAnoMat); // potencia negativa -17°

    // Curva del manillar de pista Cinelli Pista Drop
    const barCurvePts = [
      new THREE.Vector3(-0.20, 0.002, 0.028), // punta baja izquierda
      new THREE.Vector3(-0.20, 0.028, -0.065), // fondo de la curva
      new THREE.Vector3(-0.20, 0.088, -0.095), // nariz delantera
      new THREE.Vector3(-0.18, 0.136, -0.070), // hombro izquierdo
      new THREE.Vector3(0.0, 0.136, -0.070),   // abrazadera de potencia
      new THREE.Vector3(0.18, 0.136, -0.070),  // hombro derecho
      new THREE.Vector3(0.20, 0.088, -0.095),  // nariz derecha
      new THREE.Vector3(0.20, 0.028, -0.065),  // fondo derecho
      new THREE.Vector3(0.20, 0.002, 0.028),   // punta baja derecha
    ];
    const barCurve = new THREE.CatmullRomCurve3(barCurvePts);
    const barGeom = new THREE.TubeGeometry(barCurve, 36, 0.013, 8, false);
    const barMesh = new THREE.Mesh(barGeom, blackAnoMat);
    barMesh.castShadow = true;
    this.frontForkGroup.add(barMesh);

    // Transmisión pista: plato macizo 49T + bielas + piñón trasero + cadena
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

    // Cadena superior e inferior
    addTube(this.leanGroup, [0.048, this.bbPos.u + 0.10, 0], [0.048, this.wheelRadius + 0.034, this.rearContactZ], 0.004, spokeSilverMat);
    addTube(this.leanGroup, [0.048, this.bbPos.u - 0.10, 0], [0.048, this.wheelRadius - 0.034, this.rearContactZ], 0.004, spokeSilverMat);

    // === CICLISTA MENSAJERO EN POSTURA PISTA / SKID ===
    this.leanGroup.add(this.riderGroup);

    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.13, 0.18), shortsMat);
    pelvis.position.set(0, 1.05, 0.14);
    pelvis.castShadow = true;
    this.riderGroup.add(pelvis);

    this.torsoGroup.position.set(0, 1.09, 0.12);
    this.torsoGroup.rotation.x = -0.58; // postura pista sobre manillar drop
    this.riderGroup.add(this.torsoGroup);

    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.43, 0.19), jerseyMat);
    chest.position.set(0, 0.215, 0);
    chest.castShadow = true;
    this.torsoGroup.add(chest);

    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.36, 0.14), bagMat);
    backpack.position.set(0, 0.23, 0.15);
    backpack.castShadow = true;
    this.torsoGroup.add(backpack);

    // Brazos hacia los hombros/drops del manillar Cinelli
    addTube(this.torsoGroup, [-0.17, 0.38, -0.02], [-0.20, 0.06, -0.52], 0.040, jerseyMat);
    addTube(this.torsoGroup, [0.17, 0.38, -0.02], [0.20, 0.06, -0.52], 0.040, jerseyMat);

    const head = new THREE.Mesh(new THREE.SphereGeometry(0.105, 10, 8), skinMat);
    head.position.set(0, 0.54, -0.02);
    head.rotation.x = 0.48;
    const helmet = new THREE.Mesh(
      new THREE.SphereGeometry(0.12, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62),
      helmetMat
    );
    helmet.position.set(0, 0.56, -0.02);
    helmet.rotation.x = 0.40;
    helmet.castShadow = true;
    this.torsoGroup.add(head, helmet);

    const buildLeg = (thighGroup: THREE.Group, shinGroup: THREE.Group, xSide: number): void => {
      thighGroup.position.set(xSide, 1.05, 0.14);
      this.riderGroup.add(thighGroup);

      const thighMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.046, 0.40, 7), shortsMat);
      thighMesh.position.set(0, -0.20, 0);
      thighMesh.castShadow = true;
      thighGroup.add(thighMesh);

      shinGroup.position.set(0, -0.40, 0);
      thighGroup.add(shinGroup);

      const shinMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.035, 0.38, 7), skinMat);
      shinMesh.position.set(0, -0.19, 0);
      shinMesh.castShadow = true;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.055, 0.18), helmetMat);
      shoe.position.set(0, -0.39, -0.04);
      shinGroup.add(shinMesh, shoe);
    };

    buildLeg(this.leftThigh, this.leftShin, -0.095);
    buildLeg(this.rightThigh, this.rightShin, 0.095);
  }

  public getRearTireWorldXZ(travelYaw: number, bikeX: number, bikeZ: number, whipAngle: number): [number, number] {
    // Rueda delantera respecto al centro del root
    const frontX = bikeX + Math.sin(travelYaw) * this.frontContactZ;
    const frontZ = bikeZ + Math.cos(travelYaw) * this.frontContactZ;
    const rearOffsetFromFront = this.rearContactZ - this.frontContactZ; // +0.96 m hacia atrás
    const bodyYaw = travelYaw + whipAngle;
    return [
      frontX + Math.sin(bodyYaw) * rearOffsetFromFront,
      frontZ + Math.cos(bodyYaw) * rearOffsetFromFront,
    ];
  }

  public update(state: FixieVisualState, travelYaw: number, x: number, y: number, z: number, dt = 0.016): void {
    this.root.position.set(x, y, z);
    this.yawGroup.rotation.y = travelYaw;
    this.whipPivot.rotation.y = state.whipAngle;
    this.slopeGroup.rotation.x = state.slopePitch;
    this.leanGroup.rotation.z = state.leanAngle;

    this.frontForkGroup.rotation.y = state.steerAngle;

    // Rueda delantera siempre rueda a la velocidad real; trasera se bloquea al hacer skid
    const wheelDelta = (state.speedMs / this.wheelRadius) * dt;
    this.wheelSpinAngle += wheelDelta;
    this.frontWheel.rotation.x = -this.wheelSpinAngle;
    if (!state.isSkidding) {
      this.rearWheel.rotation.x = -this.wheelSpinAngle;
    }
    this.crankGroup.rotation.x = -state.crankAngle;

    // Desplazamiento de peso hacia adelante ("balls to stem" / skid stance) y postura aero
    const targetHipF = state.isSkidding ? 0.24 : state.isSprinting ? 0.05 : 0.0;
    const targetHipU = state.isSkidding ? 0.07 : state.isSprinting ? 0.03 : 0.0;
    const smooth = Math.min(1, dt * 14);
    this.hipShiftF += (targetHipF - this.hipShiftF) * smooth;
    this.hipShiftU += (targetHipU - this.hipShiftU) * smooth;

    this.riderGroup.position.set(0, this.hipShiftU, -this.hipShiftF);
    const targetTorsoPitch = state.isSkidding ? -0.45 : state.isSprinting ? -0.74 : -0.58;
    this.torsoGroup.rotation.x += (targetTorsoPitch - this.torsoGroup.rotation.x) * smooth;

    this.solveLegIK(this.leftThigh, this.leftShin, state.crankAngle + Math.PI);
    this.solveLegIK(this.rightThigh, this.rightShin, state.crankAngle);
  }

  private solveLegIK(thighGroup: THREE.Group, shinGroup: THREE.Group, crankAng: number): void {
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
  }
}
