import * as THREE from 'three/webgpu';

export interface FixieVisualState {
  speedMs: number;
  steerAngle: number;
  leanAngle: number;
  crankAngle: number;
  slopePitch: number;
  isSprinting: boolean;
  isSkidding: boolean;
  driftSlipAngle: number;
}

/**
 * Avatar 3D estilizado de bicicleta fixie y ciclista mensajero:
 * - Geometría limpia estilo Apple Maps con acento coral/terracota.
 * - Ruedas, bielas, piernas articuladas, inclinación en curva y dirección animadas.
 */
export class FixieAvatar {
  public readonly root = new THREE.Group();
  private readonly yawGroup = new THREE.Group();
  private readonly slopeGroup = new THREE.Group();
  private readonly leanGroup = new THREE.Group();
  private readonly frontForkGroup = new THREE.Group();

  private readonly rearWheel = new THREE.Group();
  private readonly frontWheel = new THREE.Group();
  private readonly crankGroup = new THREE.Group();
  private readonly torsoGroup = new THREE.Group();

  private readonly leftThigh = new THREE.Group();
  private readonly leftShin = new THREE.Group();
  private readonly rightThigh = new THREE.Group();
  private readonly rightShin = new THREE.Group();
  private readonly skidMat: THREE.MeshStandardNodeMaterial;

  private readonly wheelRadius = 0.34;
  private readonly crankRadius = 0.17;
  private readonly hipPos = new THREE.Vector2(-0.14, 1.02); // z-local (hacia adelante = -Z), y-local

  constructor() {
    this.root.name = 'fixie-avatar';
    this.root.add(this.yawGroup);
    this.yawGroup.add(this.slopeGroup);
    this.slopeGroup.add(this.leanGroup);

    // Sombra de contacto sutil bajo las ruedas para anclar la bici al asfalto
    const contactShadowMat = new THREE.MeshBasicMaterial({
      color: 0x161920,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
    });
    const contactShadowGeom = new THREE.CircleGeometry(0.65, 16);
    contactShadowGeom.rotateX(-Math.PI / 2);
    contactShadowGeom.scale(0.55, 1, 1.45);
    const contactShadow = new THREE.Mesh(contactShadowGeom, contactShadowMat);
    contactShadow.position.set(0, 0.02, 0.02);
    this.slopeGroup.add(contactShadow);

    const frameMat = new THREE.MeshStandardNodeMaterial({
      color: 0x2b6cb0,
      roughness: 0.42,
      metalness: 0.35,
    });
    const darkMetalMat = new THREE.MeshStandardNodeMaterial({
      color: 0x242830,
      roughness: 0.55,
      metalness: 0.4,
    });
    const rimMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf06543,
      roughness: 0.45,
      metalness: 0.25,
    });
    const tireMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1e2128,
      roughness: 0.85,
      metalness: 0.05,
    });
    const parcelMat = new THREE.MeshStandardNodeMaterial({
      color: 0xd9b382,
      roughness: 0.85,
      metalness: 0.02,
    });
    const jerseyMat = new THREE.MeshStandardNodeMaterial({
      color: 0x2e3440,
      roughness: 0.78,
      metalness: 0.04,
    });
    const shortsMat = new THREE.MeshStandardNodeMaterial({
      color: 0x1e232c,
      roughness: 0.82,
      metalness: 0.04,
    });
    const skinMat = new THREE.MeshStandardNodeMaterial({
      color: 0xe6b89c,
      roughness: 0.75,
      metalness: 0.02,
    });
    const helmetMat = new THREE.MeshStandardNodeMaterial({
      color: 0xf7f7f9,
      roughness: 0.35,
      metalness: 0.08,
    });
    const bagMat = new THREE.MeshStandardNodeMaterial({
      color: 0xef6c47,
      roughness: 0.72,
      metalness: 0.04,
    });
    this.skidMat = new THREE.MeshStandardNodeMaterial({
      color: 0xff5a36,
      emissive: 0x771808,
      roughness: 0.4,
      metalness: 0.1,
    });

    // Ruedas 700c de perfil profundo (eje X, adelante = -Z)
    const buildWheel = (wheelGroup: THREE.Group): void => {
      const tireGeom = new THREE.TorusGeometry(this.wheelRadius - 0.025, 0.028, 8, 24);
      tireGeom.rotateY(Math.PI / 2);
      const tire = new THREE.Mesh(tireGeom, tireMat);
      tire.castShadow = true;

      const rimGeom = new THREE.TorusGeometry(this.wheelRadius - 0.058, 0.022, 6, 20);
      rimGeom.rotateY(Math.PI / 2);
      const rim = new THREE.Mesh(rimGeom, rimMat);

      const hubGeom = new THREE.CylinderGeometry(0.032, 0.032, 0.11, 8);
      hubGeom.rotateZ(Math.PI / 2);
      const hub = new THREE.Mesh(hubGeom, darkMetalMat);

      const spokeGeom = new THREE.CylinderGeometry(0.008, 0.008, (this.wheelRadius - 0.06) * 2, 4);
      for (let i = 0; i < 4; i++) {
        const sp = new THREE.Mesh(spokeGeom, darkMetalMat);
        sp.rotation.x = (i / 4) * Math.PI;
        wheelGroup.add(sp);
      }

      wheelGroup.add(tire, rim, hub);
    };

    buildWheel(this.rearWheel);
    this.rearWheel.position.set(0, this.wheelRadius, 0.50);
    this.leanGroup.add(this.rearWheel);

    // Conjunto delantero pivotante (horquilla + rueda delantera + manillar + portabultos)
    this.frontForkGroup.position.set(0, 0.72, -0.37);
    this.leanGroup.add(this.frontForkGroup);

    buildWheel(this.frontWheel);
    this.frontWheel.position.set(0, this.wheelRadius - 0.72, -0.14);
    this.frontForkGroup.add(this.frontWheel);

    // Tubos del cuadro fixie clásico (horizontal top tube)
    const addTube = (
      parent: THREE.Object3D,
      p0: [number, number, number],
      p1: [number, number, number],
      radius: number,
      mat: THREE.Material
    ): void => {
      const a = new THREE.Vector3(...p0);
      const b = new THREE.Vector3(...p1);
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      if (len < 1e-4) return;
      const geom = new THREE.CylinderGeometry(radius, radius, len, 6);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.copy(a).addScaledVector(dir, 0.5);
      mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      mesh.castShadow = true;
      parent.add(mesh);
    };

    // Triángulo principal
    addTube(this.leanGroup, [0, 0.36, 0.02], [0, 0.80, 0.16], 0.02, frameMat); // seat tube
    addTube(this.leanGroup, [0, 0.80, 0.16], [0, 0.78, -0.36], 0.019, frameMat); // top tube
    addTube(this.leanGroup, [0, 0.36, 0.02], [0, 0.72, -0.37], 0.022, frameMat); // down tube
    addTube(this.leanGroup, [0, 0.82, -0.36], [0, 0.68, -0.38], 0.023, frameMat); // head tube
    // Vainas traseras (chainstays & seatstays)
    addTube(this.leanGroup, [-0.04, 0.36, 0.02], [-0.055, this.wheelRadius, 0.50], 0.014, frameMat);
    addTube(this.leanGroup, [0.04, 0.36, 0.02], [0.055, this.wheelRadius, 0.50], 0.014, frameMat);
    addTube(this.leanGroup, [0, 0.78, 0.16], [-0.055, this.wheelRadius, 0.50], 0.012, frameMat);
    addTube(this.leanGroup, [0, 0.78, 0.16], [0.055, this.wheelRadius, 0.50], 0.012, frameMat);

    // Tija + sillín + piloto trasero (se ilumina al derrapar)
    addTube(this.leanGroup, [0, 0.80, 0.16], [0, 0.94, 0.20], 0.015, darkMetalMat);
    const saddle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.045, 0.25), darkMetalMat);
    saddle.position.set(0, 0.955, 0.21);
    saddle.castShadow = true;
    this.leanGroup.add(saddle);

    const tailLight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.03, 0.03), this.skidMat);
    tailLight.position.set(0, 0.91, 0.32);
    this.leanGroup.add(tailLight);

    // Horquilla delantera + potencia + manillar bullhorn + caja mensajero delantera
    addTube(this.frontForkGroup, [-0.05, 0.0, -0.01], [-0.055, this.wheelRadius - 0.72, -0.14], 0.015, rimMat);
    addTube(this.frontForkGroup, [0.05, 0.0, -0.01], [0.055, this.wheelRadius - 0.72, -0.14], 0.015, rimMat);
    addTube(this.frontForkGroup, [0, 0.08, 0.01], [0, 0.20, -0.01], 0.016, darkMetalMat); // stem post
    addTube(this.frontForkGroup, [0, 0.20, -0.01], [0, 0.21, -0.09], 0.016, darkMetalMat); // stem
    addTube(this.frontForkGroup, [-0.24, 0.21, -0.09], [0.24, 0.21, -0.09], 0.015, darkMetalMat); // handlebar
    addTube(this.frontForkGroup, [-0.24, 0.21, -0.09], [-0.24, 0.23, -0.19], 0.015, darkMetalMat); // horn L
    addTube(this.frontForkGroup, [0.24, 0.21, -0.09], [0.24, 0.23, -0.19], 0.015, darkMetalMat); // horn R

    // Portabultos delantero + paquete kraft de mensajería
    const rack = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.025, 0.22), darkMetalMat);
    rack.position.set(0, 0.06, -0.22);
    const parcel = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.14, 0.18), parcelMat);
    parcel.position.set(0, 0.14, -0.22);
    parcel.castShadow = true;
    this.frontForkGroup.add(rack, parcel);

    // Plato y bielas sincronizadas (piñón fijo)
    this.crankGroup.position.set(0, 0.36, 0.02);
    this.leanGroup.add(this.crankGroup);

    const chainring = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.018, 12), darkMetalMat);
    chainring.rotation.z = Math.PI / 2;
    chainring.position.set(0.055, 0, 0);
    this.crankGroup.add(chainring);

    addTube(this.crankGroup, [-0.075, 0, 0], [-0.075, -this.crankRadius, 0], 0.012, darkMetalMat);
    addTube(this.crankGroup, [0.075, 0, 0], [0.075, this.crankRadius, 0], 0.012, darkMetalMat);

    // Ciclista (pelvis + piernas articuladas + torso + mochila mensajero + cabeza/casco)
    const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.20), shortsMat);
    pelvis.position.set(0, 1.02, 0.16);
    pelvis.castShadow = true;
    this.leanGroup.add(pelvis);

    this.torsoGroup.position.set(0, 1.06, 0.14);
    this.torsoGroup.rotation.x = -0.48; // postura aerodinámica urbana (-Z es adelante -> inclinar hacia -Z)
    this.leanGroup.add(this.torsoGroup);

    const chest = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.44, 0.20), jerseyMat);
    chest.position.set(0, 0.22, 0);
    chest.castShadow = true;
    this.torsoGroup.add(chest);

    // Mochila roll-top clásica de mensajero en la espalda (+Z respecto al torso inclinado)
    const backpack = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.38, 0.15), bagMat);
    backpack.position.set(0, 0.24, 0.16);
    backpack.castShadow = true;
    this.torsoGroup.add(backpack);

    // Brazos estirados hacia el manillar
    addTube(this.torsoGroup, [-0.18, 0.39, -0.02], [-0.22, 0.04, -0.44], 0.042, jerseyMat);
    addTube(this.torsoGroup, [0.18, 0.39, -0.02], [0.22, 0.04, -0.44], 0.042, jerseyMat);

    // Cabeza + casco + visera
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), skinMat);
    head.position.set(0, 0.55, -0.02);
    head.rotation.x = 0.42;
    const helmet = new THREE.Mesh(new THREE.SphereGeometry(0.125, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), helmetMat);
    helmet.position.set(0, 0.57, -0.02);
    helmet.rotation.x = 0.35;
    helmet.castShadow = true;
    this.torsoGroup.add(head, helmet);

    // Piernas articuladas (muslo + pantorrilla + zapatilla)
    const buildLeg = (thighGroup: THREE.Group, shinGroup: THREE.Group, xSide: number): void => {
      thighGroup.position.set(xSide, this.hipPos.y, -this.hipPos.x);
      this.leanGroup.add(thighGroup);

      const thighMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.048, 0.38, 7), shortsMat);
      thighMesh.position.set(0, -0.19, 0);
      thighMesh.castShadow = true;
      thighGroup.add(thighMesh);

      shinGroup.position.set(0, -0.38, 0);
      thighGroup.add(shinGroup);

      const shinMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.036, 0.36, 7), skinMat);
      shinMesh.position.set(0, -0.18, 0);
      shinMesh.castShadow = true;
      const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.06, 0.19), helmetMat);
      shoe.position.set(0, -0.37, -0.04);
      shinGroup.add(shinMesh, shoe);
    };

    buildLeg(this.leftThigh, this.leftShin, -0.10);
    buildLeg(this.rightThigh, this.rightShin, 0.10);
  }

  public update(state: FixieVisualState, yaw: number, x: number, y: number, z: number): void {
    this.root.position.set(x, y, z);
    this.yawGroup.rotation.y = yaw + state.driftSlipAngle;
    this.slopeGroup.rotation.x = state.slopePitch;
    this.leanGroup.rotation.z = state.leanAngle;

    this.frontForkGroup.rotation.y = state.steerAngle;

    // Giran ambas ruedas y las bielas (en derrape la rueda trasera se bloquea)
    const wheelSpin = state.crankAngle * 2.1; // relación de desarrollo fixie 48x17 (~2.8x, suavizado visual)
    this.frontWheel.rotation.x = -wheelSpin;
    this.rearWheel.rotation.x = state.isSkidding ? this.rearWheel.rotation.x : -wheelSpin;
    this.crankGroup.rotation.x = -state.crankAngle;

    // Postura aero al sprintar
    const targetTorsoPitch = state.isSprinting ? -0.66 : state.isSkidding ? -0.35 : -0.48;
    this.torsoGroup.rotation.x += (targetTorsoPitch - this.torsoGroup.rotation.x) * 0.2;

    // Luz trasera más viva al frenar / derrapar
    this.skidMat.color.setHex(state.isSkidding ? 0xff2a1a : 0xaa2a1a);

    // Cinemática inversa sencilla en 2D (plano Z-Y) para posicionar rodilla y pie sobre cada pedal
    this.solveLegIK(this.leftThigh, this.leftShin, state.crankAngle + Math.PI);
    this.solveLegIK(this.rightThigh, this.rightShin, state.crankAngle);
  }

  private solveLegIK(thighGroup: THREE.Group, shinGroup: THREE.Group, crankAng: number): void {
    // Coordenadas en plano 2D (forward = +F hacia -Z, up = +U hacia +Y)
    const hipF = -0.14;
    const hipU = 1.02;

    const bbF = -0.02;
    const bbU = 0.36;
    const pedalF = bbF + Math.sin(crankAng) * this.crankRadius;
    const pedalU = bbU + Math.cos(crankAng) * this.crankRadius;

    const df = pedalF - hipF;
    const du = pedalU - hipU;
    const L1 = 0.38;
    const L2 = 0.36;
    const maxReach = L1 + L2 - 0.02;
    const dist = Math.min(maxReach, Math.max(0.18, Math.hypot(df, du)));

    // Ángulo desde vector (0, -1) hacia adelante (+F / -Z)
    const baseAng = Math.atan2(df, -du);
    const cosA = Math.max(-1, Math.min(1, (L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist)));
    const kneeBendOffset = Math.acos(cosA);

    // La rodilla dobla hacia adelante (+F -> rotación negativa alrededor de X en sistema Three.js donde -Z es adelante)
    const thighWorldAngle = baseAng + kneeBendOffset;
    const cosKnee = Math.max(-1, Math.min(1, (L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2)));
    const interiorKnee = Math.acos(cosKnee);

    thighGroup.rotation.x = thighWorldAngle;
    shinGroup.rotation.x = -(Math.PI - interiorKnee);
  }
}
