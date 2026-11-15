import * as THREE from 'three/webgpu';

export const FACADE_LAYER_COUNT = 8;
export const FACADE_TILE_SIZE = 512;

export interface MadridFacadeArrays {
  albedoArray: THREE.DataArrayTexture;
  pbrArray: THREE.DataArrayTexture; // R=bumpHeight, G=roughness, B=metalness, A=tintMask
}

export interface MadridRoadTextures {
  asphaltAlbedo: THREE.CanvasTexture;
  asphaltPbr: THREE.CanvasTexture; // R=bumpHeight, G=roughness, B=wear
  pavingAlbedo: THREE.CanvasTexture;
  pavingPbr: THREE.CanvasTexture; // R=bumpHeight, G=roughness
}

function hash2(x: number, y: number, seed = 1337): number {
  let n = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  n = (n ^ (n >>> 13)) >>> 0;
  n = Math.imul(n, 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function createCanvasPair(size: number): {
  albedoCanvas: HTMLCanvasElement;
  albedoCtx: CanvasRenderingContext2D;
  pbrCanvas: HTMLCanvasElement;
  pbrCtx: CanvasRenderingContext2D;
} {
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = size;
  albedoCanvas.height = size;
  const albedoCtx = albedoCanvas.getContext('2d')!;

  const pbrCanvas = document.createElement('canvas');
  pbrCanvas.width = size;
  pbrCanvas.height = size;
  const pbrCtx = pbrCanvas.getContext('2d')!;

  return { albedoCanvas, albedoCtx, pbrCanvas, pbrCtx };
}

function pbrRgb(height01: number, rough01: number, metal01: number, tint01 = 1): string {
  const r = Math.round(Math.max(0, Math.min(1, height01)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, rough01)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, metal01)) * 255);
  const a = Math.max(0, Math.min(1, tint01));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

function addFineMineralGrain(
  ctx: CanvasRenderingContext2D,
  pbrCtx: CanvasRenderingContext2D,
  size: number,
  seed: number,
  albedoAmp: number,
  bumpAmp: number
): void {
  const aImg = ctx.getImageData(0, 0, size, size);
  const pImg = pbrCtx.getImageData(0, 0, size, size);
  const ad = aImg.data;
  const pd = pImg.data;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const n = hash2(x, y, seed) - 0.5;
      const n2 = hash2(x >> 2, y >> 2, seed + 17) - 0.5;
      const deltaA = (n * 0.7 + n2 * 0.5) * albedoAmp;
      ad[idx] = Math.max(0, Math.min(255, ad[idx] + deltaA));
      ad[idx + 1] = Math.max(0, Math.min(255, ad[idx + 1] + deltaA));
      ad[idx + 2] = Math.max(0, Math.min(255, ad[idx + 2] + deltaA));

      const deltaB = n * bumpAmp;
      pd[idx] = Math.max(0, Math.min(255, pd[idx] + deltaB));
    }
  }
  ctx.putImageData(aImg, 0, 0);
  pbrCtx.putImageData(pImg, 0, 0);
}

/**
 * Copia un canvas 2D a una capa de Uint8Array invirtiendo verticalmente (fila 0 abajo)
 * para que v=0 corresponda al suelo de la planta y v=1 al techo/cornisa.
 */
function copyCanvasToLayer(
  canvas: HTMLCanvasElement,
  dst: Uint8Array,
  layerIndex: number,
  size: number
): void {
  const ctx = canvas.getContext('2d')!;
  const src = ctx.getImageData(0, 0, size, size).data;
  const layerStride = size * size * 4;
  const rowStride = size * 4;
  const layerOffset = layerIndex * layerStride;

  for (let y = 0; y < size; y++) {
    const srcStart = (size - 1 - y) * rowStride;
    const dstStart = layerOffset + y * rowStride;
    dst.set(src.subarray(srcStart, srcStart + rowStride), dstStart);
  }
}

function drawClassicalEnsancheLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  // Base revoco luminoso cálido madrileño (tintado después por vertexColor)
  aCtx.fillStyle = '#f3ede2';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.54, 0.86, 0.02, 1.0);
  pCtx.fillRect(0, 0, S, S);

  const cols = 4;
  const rows = 4;
  const cellW = S / cols;
  const cellH = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * cellH;
    // Imposta / cornisa blanca entre plantas
    aCtx.fillStyle = '#faf7f0';
    aCtx.fillRect(0, y0, S, 8);
    aCtx.fillStyle = '#cfc7b8';
    aCtx.fillRect(0, y0 + 8, S, 3);
    pCtx.fillStyle = pbrRgb(0.86, 0.82, 0.02, 0.55);
    pCtx.fillRect(0, y0, S, 8);

    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      const wx = x0 + cellW * 0.25;
      const ww = cellW * 0.50;
      const wy = y0 + cellH * 0.16;
      const wh = cellH * 0.70;

      // Recerco moldurado blanco/crema de balconera
      aCtx.fillStyle = '#f8f4ec';
      aCtx.fillRect(wx - 6, wy - 7, ww + 12, wh + 10);
      aCtx.fillStyle = '#d4cbbd';
      aCtx.fillRect(wx - 6, wy - 9, ww + 12, 3);
      pCtx.fillStyle = pbrRgb(0.78, 0.80, 0.02, 0.5);
      pCtx.fillRect(wx - 6, wy - 7, ww + 12, wh + 10);

      // Hueco profundo + cristal azulado oscuro
      const grad = aCtx.createLinearGradient(0, wy, 0, wy + wh);
      grad.addColorStop(0, '#222d38');
      grad.addColorStop(0.55, '#344556');
      grad.addColorStop(1, '#1b242d');
      aCtx.fillStyle = grad;
      aCtx.fillRect(wx, wy, ww, wh);
      pCtx.fillStyle = pbrRgb(0.16, 0.15, 0.35, 0.06);
      pCtx.fillRect(wx, wy, ww, wh);

      // Persiana madrileña discreta en la parte superior
      const blindH = wh * (0.16 + hash2(c, r, 41) * 0.20);
      aCtx.fillStyle = '#d7ceb8';
      aCtx.fillRect(wx + 2, wy + 2, ww - 4, blindH);
      pCtx.fillStyle = pbrRgb(0.45, 0.74, 0.04, 0.18);
      pCtx.fillRect(wx + 2, wy + 2, ww - 4, blindH);

      // Carpintería vertical central y travesaños
      aCtx.fillStyle = '#ebe6dc';
      aCtx.fillRect(wx + ww * 0.5 - 2, wy, 4, wh);
      aCtx.fillRect(wx, wy + wh * 0.44, ww, 3);

      // Balcón de forja negra con losa de piedra volada
      const balcY = wy + wh * 0.56;
      const balcH = wh * 0.45;
      aCtx.fillStyle = '#1e2228';
      aCtx.fillRect(wx - 7, balcY, ww + 14, 3);
      aCtx.fillStyle = '#e8e2d7';
      aCtx.fillRect(wx - 8, balcY + balcH - 5, ww + 16, 6);
      pCtx.fillStyle = pbrRgb(0.92, 0.42, 0.65, 0.05);
      pCtx.fillRect(wx - 7, balcY, ww + 14, 3);
      pCtx.fillRect(wx - 8, balcY + balcH - 5, ww + 16, 6);

      aCtx.fillStyle = '#1e2228';
      for (let b = 0; b <= 6; b++) {
        const bx = wx - 5 + ((ww + 10) * b) / 6;
        aCtx.fillRect(bx, balcY, 2, balcH - 5);
        pCtx.fillRect(bx, balcY, 2, balcH - 5);
      }
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 101, 12, 16);
}

function drawPalaceStoneLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  // Piedra caliza blanca/crema Beaux-Arts (Metrópolis, Gran Vía, Cibeles, Banco de España)
  aCtx.fillStyle = '#f2ece0';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.58, 0.82, 0.02, 0.72);
  pCtx.fillRect(0, 0, S, S);

  // Sillería noble fina
  const ashlarRows = 20;
  const rowH = S / ashlarRows;
  aCtx.strokeStyle = 'rgba(155, 146, 130, 0.28)';
  aCtx.lineWidth = 1.2;
  pCtx.strokeStyle = pbrRgb(0.36, 0.88, 0.02, 0.7);
  pCtx.lineWidth = 1.5;

  for (let r = 0; r < ashlarRows; r++) {
    const y = r * rowH;
    aCtx.beginPath();
    aCtx.moveTo(0, y);
    aCtx.lineTo(S, y);
    aCtx.stroke();
    pCtx.beginPath();
    pCtx.moveTo(0, y);
    pCtx.lineTo(S, y);
    pCtx.stroke();

    const cols = 10;
    const offset = (r % 2) * (S / (cols * 2));
    for (let c = 0; c < cols; c++) {
      const x = (c * (S / cols) + offset) % S;
      aCtx.beginPath();
      aCtx.moveTo(x, y);
      aCtx.lineTo(x, y + rowH);
      aCtx.stroke();
    }
  }

  const cols = 4;
  const rows = 4;
  const cellW = S / cols;
  const cellH = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * cellH;
    // Cornisa monumental con dentículos y sombra marcada
    aCtx.fillStyle = '#faf6ee';
    aCtx.fillRect(0, y0, S, 11);
    aCtx.fillStyle = '#bfb5a4';
    aCtx.fillRect(0, y0 + 11, S, 4);
    pCtx.fillStyle = pbrRgb(0.92, 0.76, 0.02, 0.55);
    pCtx.fillRect(0, y0, S, 11);

    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      // Columna / pilastra corintia estriada entre vanos
      aCtx.fillStyle = '#f8f4eb';
      aCtx.fillRect(x0 + 3, y0 + 14, 15, cellH - 14);
      aCtx.fillStyle = '#dcd4c4';
      aCtx.fillRect(x0 + 6, y0 + 18, 2, cellH - 22);
      aCtx.fillRect(x0 + 12, y0 + 18, 2, cellH - 22);
      // Capitel / basa claro
      aCtx.fillStyle = '#efe9dc';
      aCtx.fillRect(x0 + 1, y0 + 14, 19, 7);
      pCtx.fillStyle = pbrRgb(0.84, 0.78, 0.02, 0.65);
      pCtx.fillRect(x0 + 3, y0 + 14, 15, cellH - 14);

      const wx = x0 + cellW * 0.28;
      const ww = cellW * 0.46;
      const wy = y0 + cellH * 0.21;
      const wh = cellH * 0.63;

      // Frontón / clave esculpida sobre ventana
      aCtx.fillStyle = '#faf6ee';
      aCtx.fillRect(wx - 7, wy - 10, ww + 14, 9);
      aCtx.fillStyle = '#c9bfae';
      aCtx.fillRect(wx - 7, wy - 2, ww + 14, 2);
      pCtx.fillStyle = pbrRgb(0.88, 0.76, 0.02, 0.55);
      pCtx.fillRect(wx - 7, wy - 10, ww + 14, 9);

      // Ventana noble profunda con cuarterones oscuros
      const grad = aCtx.createLinearGradient(0, wy, 0, wy + wh);
      grad.addColorStop(0, '#1f2b36');
      grad.addColorStop(0.55, '#334657');
      grad.addColorStop(1, '#1a232c');
      aCtx.fillStyle = grad;
      aCtx.fillRect(wx, wy, ww, wh);
      pCtx.fillStyle = pbrRgb(0.16, 0.14, 0.40, 0.05);
      pCtx.fillRect(wx, wy, ww, wh);

      aCtx.fillStyle = '#e5dfd3';
      aCtx.fillRect(wx + ww * 0.5 - 1.5, wy, 3, wh);
      aCtx.fillRect(wx, wy + wh * 0.42, ww, 3);

      // Balcón / balaustrada de piedra o forja negra
      aCtx.fillStyle = '#f2ece0';
      aCtx.fillRect(wx - 6, wy + wh - 16, ww + 12, 16);
      aCtx.fillStyle = '#242830';
      for (let b = 0; b <= 5; b++) {
        aCtx.fillRect(wx - 3 + ((ww + 6) * b) / 5, wy + wh - 14, 2.5, 11);
      }
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 202, 9, 18);
}

function drawBrickMadridLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  // Mortero tostado discreto (evita efecto Lego con juntas blancas chillonas)
  aCtx.fillStyle = '#9c7863';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.42, 0.93, 0.01, 0.12);
  pCtx.fillRect(0, 0, S, S);

  // Aparejo fino de ladrillo visto madrileño (escala real ~36×96 en 13 m)
  const brickRows = 96;
  const brickCols = 36;
  const bh = S / brickRows;
  const bw = S / brickCols;

  for (let r = 0; r < brickRows; r++) {
    const y = r * bh;
    const shift = (r % 2) * (bw * 0.5);
    for (let c = -1; c <= brickCols; c++) {
      const x = c * bw + shift;
      const n = hash2(c + 40, r, 303);
      const red = Math.round(154 + (n - 0.5) * 28);
      const grn = Math.round(80 + (n - 0.5) * 18);
      const blu = Math.round(58 + (n - 0.5) * 14);
      aCtx.fillStyle = `rgb(${red},${grn},${blu})`;
      aCtx.fillRect(x + 0.6, y + 0.6, bw - 1.2, bh - 1.2);
      pCtx.fillStyle = pbrRgb(0.56 + (n - 0.5) * 0.08, 0.90, 0.01, 0.18);
      pCtx.fillRect(x + 0.6, y + 0.6, bw - 1.2, bh - 1.2);
    }
  }

  const cols = 4;
  const rows = 4;
  const cellW = S / cols;
  const cellH = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * cellH;
    // Cornisa e imposta de piedra caliza clara (estilo Iglesia de San José / Chamberí)
    aCtx.fillStyle = '#dfd8cc';
    aCtx.fillRect(0, y0, S, 7);
    aCtx.fillStyle = '#b4aba0';
    aCtx.fillRect(0, y0 + 7, S, 2);
    pCtx.fillStyle = pbrRgb(0.76, 0.85, 0.02, 0.35);
    pCtx.fillRect(0, y0, S, 7);

    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      // Pilastra vertical de piedra gris-crema cada 2 módulos (muy madrileño)
      if (c % 2 === 0) {
        aCtx.fillStyle = '#dcd5c9';
        aCtx.fillRect(x0 + 2, y0 + 9, 10, cellH - 9);
        pCtx.fillStyle = pbrRgb(0.74, 0.84, 0.02, 0.4);
        pCtx.fillRect(x0 + 2, y0 + 9, 10, cellH - 9);
      }

      const wx = x0 + cellW * 0.26;
      const ww = cellW * 0.50;
      const wy = y0 + cellH * 0.21;
      const wh = cellH * 0.58;

      // Dintel y vierteaguas de granito/caliza madrileña
      aCtx.fillStyle = '#ded7cb';
      aCtx.fillRect(wx - 5, wy - 7, ww + 10, 7);
      aCtx.fillRect(wx - 5, wy + wh, ww + 10, 6);
      pCtx.fillStyle = pbrRgb(0.78, 0.83, 0.02, 0.3);
      pCtx.fillRect(wx - 5, wy - 7, ww + 10, 7);
      pCtx.fillRect(wx - 5, wy + wh, ww + 10, 6);

      // Carpintería de madera/hierro oscura con hueco profundo
      aCtx.fillStyle = '#40342b';
      aCtx.fillRect(wx, wy, ww, wh);
      aCtx.fillStyle = '#202b36';
      aCtx.fillRect(wx + 4, wy + 4, ww * 0.5 - 6, wh - 8);
      aCtx.fillRect(wx + ww * 0.5 + 2, wy + 4, ww * 0.5 - 6, wh - 8);
      pCtx.fillStyle = pbrRgb(0.20, 0.18, 0.32, 0.06);
      pCtx.fillRect(wx + 4, wy + 4, ww - 8, wh - 8);
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 309, 12, 14);
}

function drawModernResidentialLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  aCtx.fillStyle = '#ebe8e2';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.52, 0.82, 0.03, 0.95);
  pCtx.fillRect(0, 0, S, S);

  const cols = 4;
  const rows = 4;
  const cellW = S / cols;
  const cellH = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * cellH;
    // Losa blanca de terraza corrida
    aCtx.fillStyle = '#f3f1ed';
    aCtx.fillRect(0, y0, S, 12);
    aCtx.fillStyle = '#c8c5be';
    aCtx.fillRect(0, y0 + 12, S, 4);
    pCtx.fillStyle = pbrRgb(0.84, 0.75, 0.05, 0.7);
    pCtx.fillRect(0, y0, S, 12);

    // Bandas horizontales amplias con cristal y carpintería aluminio
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      const wx = x0 + 8;
      const ww = cellW - 16;
      const wy = y0 + cellH * 0.22;
      const wh = cellH * 0.54;

      aCtx.fillStyle = '#2b3c4b';
      aCtx.fillRect(wx, wy, ww, wh);
      pCtx.fillStyle = pbrRgb(0.20, 0.16, 0.45, 0.08);
      pCtx.fillRect(wx, wy, ww, wh);

      // Parteluces aluminio gris oscuro
      aCtx.fillStyle = '#6f7782';
      aCtx.fillRect(wx + ww * 0.33, wy, 3, wh);
      aCtx.fillRect(wx + ww * 0.66, wy, 3, wh);

      // Antepecho de vidrio translúcido en terraza
      aCtx.fillStyle = 'rgba(205, 222, 236, 0.58)';
      aCtx.fillRect(x0 + 4, y0 + cellH * 0.66, cellW - 8, cellH * 0.34);
      pCtx.fillStyle = pbrRgb(0.70, 0.25, 0.35, 0.15);
      pCtx.fillRect(x0 + 4, y0 + cellH * 0.66, cellW - 8, cellH * 0.34);
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 404, 8, 10);
}

function drawGlassCurtainWallLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  // Torres AZCA / Cuatro Torres: muro cortina luminoso azul cielo/plata (nunca negro carbón)
  aCtx.fillStyle = '#5e7f9e';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.32, 0.16, 0.72, 0.14);
  pCtx.fillRect(0, 0, S, S);

  const cols = 8;
  const rows = 4;
  const cw = S / cols;
  const ch = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * ch;
    for (let c = 0; c < cols; c++) {
      const x0 = c * cw;
      const n = hash2(c, r, 505);
      // Reflejo luminoso de cielo madrileño dentro de cada módulo acristalado
      const grad = aCtx.createLinearGradient(x0, y0, x0 + cw, y0 + ch);
      const lift = Math.round((n - 0.5) * 28);
      grad.addColorStop(0, `rgb(${124 + lift},${164 + lift},${196 + lift})`);
      grad.addColorStop(0.55, `rgb(${94 + lift},${132 + lift},${164 + lift})`);
      grad.addColorStop(1, `rgb(${72 + lift},${102 + lift},${132 + lift})`);
      aCtx.fillStyle = grad;
      aCtx.fillRect(x0 + 3, y0 + 18, cw - 6, ch - 22);

      // Spandrel metálico entre plantas
      aCtx.fillStyle = '#526578';
      aCtx.fillRect(x0 + 2, y0, cw - 4, 16);
      pCtx.fillStyle = pbrRgb(0.68, 0.28, 0.65, 0.15);
      pCtx.fillRect(x0 + 2, y0, cw - 4, 16);

      // Montantes verticales aluminio claro
      aCtx.fillStyle = '#b4c0cc';
      aCtx.fillRect(x0, y0, 3, ch);
      aCtx.fillRect(x0 + cw - 2, y0, 2, ch);
      pCtx.fillStyle = pbrRgb(0.88, 0.30, 0.85, 0.1);
      pCtx.fillRect(x0, y0, 3, ch);
    }
  }
}

function drawGroundStorefrontLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  // Zócalo comercial de calle en Madrid: granito Guadarrama + escaparates iluminados + cierres
  aCtx.fillStyle = '#8e8d89';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.64, 0.72, 0.08, 0.45);
  pCtx.fillRect(0, 0, S, S);

  // Franja superior de rótulo/imposta piedra clara
  aCtx.fillStyle = '#cfc9be';
  aCtx.fillRect(0, 0, S, Math.round(S * 0.16));
  pCtx.fillStyle = pbrRgb(0.82, 0.78, 0.05, 0.65);
  pCtx.fillRect(0, 0, S, Math.round(S * 0.16));

  // Rodapié inferior de granito oscuro
  aCtx.fillStyle = '#6f6e6b';
  aCtx.fillRect(0, Math.round(S * 0.84), S, Math.round(S * 0.16));
  pCtx.fillStyle = pbrRgb(0.70, 0.65, 0.08, 0.3);
  pCtx.fillRect(0, Math.round(S * 0.84), S, Math.round(S * 0.16));

  const bays = 4;
  const bw = S / bays;
  for (let b = 0; b < bays; b++) {
    const x0 = b * bw;
    const sx = x0 + 10;
    const sw = bw - 20;
    const sy = Math.round(S * 0.22);
    const sh = Math.round(S * 0.62);

    // Marco aluminio negro
    aCtx.fillStyle = '#23262c';
    aCtx.fillRect(sx - 4, sy - 4, sw + 8, sh + 6);
    pCtx.fillStyle = pbrRgb(0.82, 0.38, 0.55, 0.05);
    pCtx.fillRect(sx - 4, sy - 4, sw + 8, sh + 6);

    if (b === 1) {
      // Cierre metálico microperforado típico de tienda madrileña
      aCtx.fillStyle = '#5c636d';
      aCtx.fillRect(sx, sy, sw, sh);
      for (let y = sy; y < sy + sh; y += 7) {
        aCtx.fillStyle = '#40464e';
        aCtx.fillRect(sx, y, sw, 2);
        pCtx.fillStyle = pbrRgb(0.72, 0.42, 0.65, 0.05);
        pCtx.fillRect(sx, y, sw, 3);
      }
    } else if (b === 3) {
      // Portal clásico madera oscura / latón
      aCtx.fillStyle = '#4f3929';
      aCtx.fillRect(sx + sw * 0.16, sy, sw * 0.68, sh);
      aCtx.fillStyle = '#2f3d4c';
      aCtx.fillRect(sx + sw * 0.24, sy + 16, sw * 0.52, sh * 0.48);
      pCtx.fillStyle = pbrRgb(0.32, 0.34, 0.22, 0.08);
      pCtx.fillRect(sx + sw * 0.16, sy, sw * 0.68, sh);
    } else {
      // Escaparate luminoso con reflejo cálido interior
      const grad = aCtx.createLinearGradient(0, sy, 0, sy + sh);
      grad.addColorStop(0, '#445566');
      grad.addColorStop(0.65, '#686b66');
      grad.addColorStop(1, '#31373d');
      aCtx.fillStyle = grad;
      aCtx.fillRect(sx, sy, sw, sh);
      // Cartel/toldo sutil encima del escaparate
      aCtx.fillStyle = b === 0 ? '#2f4538' : '#733b33';
      aCtx.fillRect(sx - 4, sy - 20, sw + 8, 16);
      pCtx.fillStyle = pbrRgb(0.18, 0.14, 0.48, 0.06);
      pCtx.fillRect(sx, sy, sw, sh);
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 606, 15, 22);
}

/**
 * Capa 6: Gran Vía / Alcalá Beaux-Arts (Metrópolis, Grassy, Telefónica)
 * Caliza marfil tallada, columnas pareadas corintias, ménsulas, balaustradas de piedra y detalles dorados.
 */
function drawGranViaBeauxArtsLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  aCtx.fillStyle = '#eee6d7';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.58, 0.80, 0.02, 0.24);
  pCtx.fillRect(0, 0, S, S);

  // Sillería fina de piedra caliza marfil
  const ashlarRows = 24;
  const rowH = S / ashlarRows;
  aCtx.strokeStyle = 'rgba(150, 138, 118, 0.28)';
  aCtx.lineWidth = 1;
  pCtx.strokeStyle = pbrRgb(0.40, 0.86, 0.02, 0.24);
  pCtx.lineWidth = 1.2;
  for (let r = 0; r < ashlarRows; r++) {
    const y = r * rowH;
    aCtx.beginPath();
    aCtx.moveTo(0, y);
    aCtx.lineTo(S, y);
    aCtx.stroke();
    pCtx.beginPath();
    pCtx.moveTo(0, y);
    pCtx.lineTo(S, y);
    pCtx.stroke();

    const off = (r % 2) * (S / 20);
    for (let c = 0; c < 10; c++) {
      const x = (c * (S / 10) + off) % S;
      aCtx.beginPath();
      aCtx.moveTo(x, y);
      aCtx.lineTo(x, y + rowH);
      aCtx.stroke();
    }
  }

  const cols = 4;
  const rows = 4;
  const cellW = S / cols;
  const cellH = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * cellH;
    // Entablamento Beaux-Arts con cornisa, dentículos y sombra profunda
    aCtx.fillStyle = '#f6f1e6';
    aCtx.fillRect(0, y0, S, 11);
    aCtx.fillStyle = '#dcd1be';
    aCtx.fillRect(0, y0 + 11, S, 7);
    aCtx.fillStyle = '#9c907e';
    aCtx.fillRect(0, y0 + 18, S, 3);
    pCtx.fillStyle = pbrRgb(0.94, 0.72, 0.03, 0.22);
    pCtx.fillRect(0, y0, S, 11);

    // Dentículos / modillones esculpidos
    for (let dx = 4; dx < S; dx += 14) {
      aCtx.fillStyle = '#f5efe3';
      aCtx.fillRect(dx, y0 + 11, 7, 6);
      aCtx.fillStyle = '#8b7f6e';
      aCtx.fillRect(dx + 7, y0 + 11, 7, 5);
    }

    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;

      // Columnas pareadas / pilastras estriadas con capitel dorado sutil
      const colLeft = x0 + 2;
      const colRight = x0 + cellW - 14;
      for (const cx of [colLeft, colRight]) {
        aCtx.fillStyle = '#f5efe2';
        aCtx.fillRect(cx, y0 + 21, 12, cellH - 21);
        aCtx.fillStyle = '#cbbda7';
        aCtx.fillRect(cx + 3, y0 + 28, 2, cellH - 36);
        aCtx.fillRect(cx + 7, y0 + 28, 2, cellH - 36);
        // Capitel con detalle escultórico cálido
        aCtx.fillStyle = '#e7dcc8';
        aCtx.fillRect(cx - 2, y0 + 21, 16, 7);
        aCtx.fillStyle = '#c9a64c';
        aCtx.fillRect(cx + 1, y0 + 22, 10, 2);
        pCtx.fillStyle = pbrRgb(0.86, 0.76, 0.06, 0.2);
        pCtx.fillRect(cx, y0 + 21, 12, cellH - 21);
      }

      // Vano monumental centrado con clave y dintel moldurado
      const wx = x0 + cellW * 0.24;
      const ww = cellW * 0.52;
      const wy = y0 + cellH * 0.24;
      const wh = cellH * 0.56;

      aCtx.fillStyle = '#f6f1e6';
      aCtx.fillRect(wx - 6, wy - 7, ww + 12, 8);
      // Clave central destacada
      aCtx.fillStyle = '#efe5d3';
      aCtx.fillRect(wx + ww * 0.5 - 5, wy - 10, 10, 11);

      // Hueco de vidrio profundo + carpintería bronce oscuro + reflejos cálidos
      aCtx.fillStyle = '#293039';
      aCtx.fillRect(wx, wy, ww, wh);
      aCtx.fillStyle = '#1b222a';
      aCtx.fillRect(wx + 4, wy + 4, ww * 0.5 - 6, wh - 8);
      aCtx.fillRect(wx + ww * 0.5 + 2, wy + 4, ww * 0.5 - 6, wh - 8);
      aCtx.fillStyle = '#3b4a59';
      aCtx.fillRect(wx + 6, wy + 7, ww * 0.22, wh * 0.42);
      aCtx.fillStyle = '#cbb185';
      aCtx.fillRect(wx + ww * 0.5 - 1.5, wy + 2, 3, wh - 4);
      aCtx.fillRect(wx + 2, wy + wh * 0.42, ww - 4, 2.5);
      pCtx.fillStyle = pbrRgb(0.18, 0.14, 0.42, 0.05);
      pCtx.fillRect(wx + 3, wy + 3, ww - 6, wh - 6);

      // Balaustrada de piedra tallada Beaux-Arts (alternando barandilla y piedra)
      const balY = y0 + cellH - 22;
      aCtx.fillStyle = '#f4eee2';
      aCtx.fillRect(wx - 7, balY, ww + 14, 4);
      aCtx.fillRect(wx - 8, balY + 14, ww + 16, 6);
      pCtx.fillStyle = pbrRgb(0.92, 0.72, 0.04, 0.15);
      pCtx.fillRect(wx - 7, balY, ww + 14, 20);

      for (let b = 0; b <= 6; b++) {
        const bx = wx - 5 + ((ww + 10) * b) / 6;
        aCtx.fillStyle = r % 2 === 0 ? '#4a4640' : '#24292f';
        aCtx.fillRect(bx - 3, balY + 4, 8, 10);
        aCtx.fillStyle = r % 2 === 0 ? '#e3d9c6' : '#c9a64c';
        aCtx.fillRect(bx - 1, balY + 4, 4, 10);
      }
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 707, 11, 16);
}

/**
 * Capa 7: Barroco madrileño ladrillo & granito (Parroquia San José, Alcalá, Calatravas)
 * Aparejo de ladrillo terracota fino combinado con grandes pilastras, cadenas y frontones de granito gris.
 */
function drawBaroqueBrickStoneLayer(
  aCtx: CanvasRenderingContext2D,
  pCtx: CanvasRenderingContext2D,
  S: number
): void {
  // Mortero calizo claro entre hiladas finas
  aCtx.fillStyle = '#c8bdb0';
  aCtx.fillRect(0, 0, S, S);
  pCtx.fillStyle = pbrRgb(0.40, 0.90, 0.01, 0.14);
  pCtx.fillRect(0, 0, S, S);

  // Aparejo de ladrillo barroco rojo-terracota (36 hiladas × 14)
  const brickRows = 36;
  const brickCols = 14;
  const bh = S / brickRows;
  const bw = S / brickCols;
  for (let r = 0; r < brickRows; r++) {
    const y = r * bh;
    const shift = (r % 2) * (bw * 0.5);
    for (let c = -1; c <= brickCols; c++) {
      const x = c * bw + shift;
      const n = hash2(c + 20, r, 811);
      const red = Math.round(148 + (n - 0.5) * 26);
      const green = Math.round(69 + (n - 0.5) * 16);
      const blue = Math.round(52 + (n - 0.5) * 14);
      aCtx.fillStyle = `rgb(${red},${green},${blue})`;
      aCtx.fillRect(x + 0.6, y + 0.6, bw - 1.2, bh - 1.2);
      pCtx.fillStyle = pbrRgb(0.55 + (n - 0.5) * 0.08, 0.89, 0.01, 0.12);
      pCtx.fillRect(x + 0.6, y + 0.6, bw - 1.2, bh - 1.2);
    }
  }

  const cols = 4;
  const rows = 4;
  const cellW = S / cols;
  const cellH = S / rows;

  for (let r = 0; r < rows; r++) {
    const y0 = r * cellH;
    // Imposta y cornisa de granito gris-crema de Guadarrama
    aCtx.fillStyle = '#d8d2c7';
    aCtx.fillRect(0, y0, S, 10);
    aCtx.fillStyle = '#9e978c';
    aCtx.fillRect(0, y0 + 10, S, 3);
    pCtx.fillStyle = pbrRgb(0.84, 0.84, 0.02, 0.18);
    pCtx.fillRect(0, y0, S, 10);

    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      // Anchas pilastras de sillería granítica cada módulo
      const pilW = c % 2 === 0 ? 16 : 10;
      aCtx.fillStyle = '#d4cec3';
      aCtx.fillRect(x0 + 1, y0 + 13, pilW, cellH - 13);
      aCtx.fillStyle = '#b4ada2';
      aCtx.fillRect(x0 + 1 + pilW - 2, y0 + 13, 2, cellH - 13);
      pCtx.fillStyle = pbrRgb(0.80, 0.83, 0.02, 0.18);
      pCtx.fillRect(x0 + 1, y0 + 13, pilW, cellH - 13);

      const wx = x0 + cellW * 0.25;
      const ww = cellW * 0.50;
      const wy = y0 + cellH * 0.25;
      const wh = cellH * 0.56;

      // Recerco y frontón triangular/partido en granito gris
      aCtx.fillStyle = '#dfd9ce';
      aCtx.fillRect(wx - 7, wy - 8, ww + 14, cellH * 0.56 + 14);
      aCtx.beginPath();
      aCtx.moveTo(wx - 9, wy - 8);
      aCtx.lineTo(wx + ww * 0.5, wy - 19);
      aCtx.lineTo(wx + ww + 9, wy - 8);
      aCtx.closePath();
      aCtx.fill();
      aCtx.fillStyle = '#9b9388';
      aCtx.fillRect(wx - 7, wy + wh + 5, ww + 14, 3);
      pCtx.fillStyle = pbrRgb(0.82, 0.83, 0.02, 0.18);
      pCtx.fillRect(wx - 7, wy - 8, ww + 14, wh + 14);

      // Hueco profundo con carpintería madera oscura + vidrio + reja barroca
      aCtx.fillStyle = '#352b25';
      aCtx.fillRect(wx, wy, ww, wh);
      aCtx.fillStyle = '#1d2630';
      aCtx.fillRect(wx + 4, wy + 4, ww * 0.5 - 6, wh - 8);
      aCtx.fillRect(wx + ww * 0.5 + 2, wy + 4, ww * 0.5 - 6, wh - 8);
      aCtx.fillStyle = '#1e2226';
      aCtx.fillRect(wx - 4, wy + wh * 0.65, ww + 8, 2.5);
      pCtx.fillStyle = pbrRgb(0.18, 0.18, 0.30, 0.05);
      pCtx.fillRect(wx + 4, wy + 4, ww - 8, wh - 8);
    }
  }

  addFineMineralGrain(aCtx, pCtx, S, 808, 12, 16);
}

/**
 * Construye el DataArrayTexture de fachadas de Madrid (8 capas PBR seamless de 512×512).
 */
export function createMadridFacadeArrays(): MadridFacadeArrays {
  const S = FACADE_TILE_SIZE;
  const totalBytes = S * S * 4 * FACADE_LAYER_COUNT;
  const albedoBytes = new Uint8Array(totalBytes);
  const pbrBytes = new Uint8Array(totalBytes);

  const drawers = [
    drawClassicalEnsancheLayer,
    drawPalaceStoneLayer,
    drawBrickMadridLayer,
    drawModernResidentialLayer,
    drawGlassCurtainWallLayer,
    drawGroundStorefrontLayer,
    drawGranViaBeauxArtsLayer,
    drawBaroqueBrickStoneLayer,
  ];

  for (let i = 0; i < drawers.length; i++) {
    const { albedoCanvas, albedoCtx, pbrCanvas, pbrCtx } = createCanvasPair(S);
    drawers[i](albedoCtx, pbrCtx, S);
    copyCanvasToLayer(albedoCanvas, albedoBytes, i, S);
    copyCanvasToLayer(pbrCanvas, pbrBytes, i, S);
  }

  const albedoArray = new THREE.DataArrayTexture(albedoBytes, S, S, FACADE_LAYER_COUNT);
  albedoArray.format = THREE.RGBAFormat;
  albedoArray.type = THREE.UnsignedByteType;
  albedoArray.colorSpace = THREE.SRGBColorSpace;
  albedoArray.wrapS = THREE.RepeatWrapping;
  albedoArray.wrapT = THREE.RepeatWrapping;
  albedoArray.minFilter = THREE.LinearMipmapLinearFilter;
  albedoArray.magFilter = THREE.LinearFilter;
  albedoArray.generateMipmaps = true;
  albedoArray.anisotropy = 4;
  albedoArray.needsUpdate = true;

  const pbrArray = new THREE.DataArrayTexture(pbrBytes, S, S, FACADE_LAYER_COUNT);
  pbrArray.format = THREE.RGBAFormat;
  pbrArray.type = THREE.UnsignedByteType;
  pbrArray.colorSpace = THREE.NoColorSpace;
  pbrArray.wrapS = THREE.RepeatWrapping;
  pbrArray.wrapT = THREE.RepeatWrapping;
  pbrArray.minFilter = THREE.LinearMipmapLinearFilter;
  pbrArray.magFilter = THREE.LinearFilter;
  pbrArray.generateMipmaps = true;
  pbrArray.anisotropy = 4;
  pbrArray.needsUpdate = true;

  return { albedoArray, pbrArray };
}

/**
 * Texturas PBR tileables en coordenadas de mundo para asfalto urbano y baldosa madrileña.
 */
export function createMadridRoadTextures(): MadridRoadTextures {
  const S = 512;

  // 1. Asfalto con árido granulado realista + variación de rodadura
  const {
    albedoCanvas: aspA,
    albedoCtx: aspACtx,
    pbrCanvas: aspP,
    pbrCtx: aspPCtx,
  } = createCanvasPair(S);

  const aImg = aspACtx.createImageData(S, S);
  const pImg = aspPCtx.createImageData(S, S);
  const ad = aImg.data;
  const pd = pImg.data;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = (y * S + x) * 4;
      const micro = hash2(x, y, 711) - 0.5;
      const pebble = hash2(x >> 1, y >> 1, 719) - 0.5;
      const patch = hash2(x >> 5, y >> 5, 733) - 0.5;
      const speckle = hash2(x, y, 751) > 0.91 ? 14 : 0;

      const base = 212 + micro * 28 + pebble * 22 + patch * 16 + speckle;
      const val = Math.max(140, Math.min(255, base));
      ad[idx] = val;
      ad[idx + 1] = val;
      ad[idx + 2] = Math.min(255, val + 3);
      ad[idx + 3] = 255;

      const height = 128 + micro * 75 + pebble * 48 + speckle * 1.4;
      const rough = 210 + micro * 25 - patch * 18;
      pd[idx] = Math.max(0, Math.min(255, height));
      pd[idx + 1] = Math.max(145, Math.min(248, rough));
      pd[idx + 2] = 0;
      pd[idx + 3] = 255;
    }
  }
  aspACtx.putImageData(aImg, 0, 0);
  aspPCtx.putImageData(pImg, 0, 0);

  const makeRepeatTex = (canvas: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    return tex;
  };

  // 2. Baldosa hidráulica / pavimento peatonal de Madrid
  const {
    albedoCanvas: pavA,
    albedoCtx: pavACtx,
    pbrCanvas: pavP,
    pbrCtx: pavPCtx,
  } = createCanvasPair(S);

  pavACtx.fillStyle = '#e5e0d6';
  pavACtx.fillRect(0, 0, S, S);
  pavPCtx.fillStyle = pbrRgb(0.65, 0.84, 0.02, 1.0);
  pavPCtx.fillRect(0, 0, S, S);

  const grid = 8;
  const tilePx = S / grid;
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const n = (hash2(c, r, 811) - 0.5) * 14;
      const lum = Math.round(230 + n);
      pavACtx.fillStyle = `rgb(${lum},${lum - 3},${lum - 8})`;
      pavACtx.fillRect(c * tilePx + 2, r * tilePx + 2, tilePx - 4, tilePx - 4);
      pavPCtx.fillStyle = pbrRgb(0.70 + (n / 14) * 0.06, 0.80, 0.02, 1.0);
      pavPCtx.fillRect(c * tilePx + 2, r * tilePx + 2, tilePx - 4, tilePx - 4);
    }
  }
  // Juntas de baldosa más oscuras y hundidas en height
  pavACtx.strokeStyle = 'rgba(130, 124, 114, 0.35)';
  pavACtx.lineWidth = 2;
  pavPCtx.strokeStyle = pbrRgb(0.24, 0.94, 0.01, 1.0);
  pavPCtx.lineWidth = 3;
  for (let i = 0; i <= grid; i++) {
    const p = i * tilePx;
    pavACtx.beginPath();
    pavACtx.moveTo(p, 0);
    pavACtx.lineTo(p, S);
    pavACtx.moveTo(0, p);
    pavACtx.lineTo(S, p);
    pavACtx.stroke();

    pavPCtx.beginPath();
    pavPCtx.moveTo(p, 0);
    pavPCtx.lineTo(p, S);
    pavPCtx.moveTo(0, p);
    pavPCtx.lineTo(S, p);
    pavPCtx.stroke();
  }
  addFineMineralGrain(pavACtx, pavPCtx, S, 887, 10, 14);

  return {
    asphaltAlbedo: makeRepeatTex(aspA, true),
    asphaltPbr: makeRepeatTex(aspP, false),
    pavingAlbedo: makeRepeatTex(pavA, true),
    pavingPbr: makeRepeatTex(pavP, false),
  };
}
