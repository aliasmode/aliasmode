// Small QR code encoder for payment addresses (ISO/IEC 18004: byte mode,
// error correction level M, versions 1-40). It has no dependencies, so the
// desktop bundle stays the same size apart from these lines.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const FORMAT_BITS_M = 0;

function rawModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number): number {
  return Math.floor(rawModules(version) / 8) - ECC_PER_BLOCK[version]! * BLOCKS[version]!;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i]! ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

/** Returns the module grid (true = dark), without the quiet zone. */
export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  for (; version <= 40; version++) {
    if (4 + (version < 10 ? 8 : 16) + bytes.length * 8 <= dataCodewords(version) * 8) break;
  }
  if (version > 40) throw new Error("Text is too long for a QR code");

  // Data bits: byte mode, length, bytes, terminator, padding.
  const bits: number[] = [];
  const push = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(""), 2));

  // Split into blocks, add error correction, interleave.
  const blockCount = BLOCKS[version]!, eccLength = ECC_PER_BLOCK[version]!;
  const rawCodewords = Math.floor(rawModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const block = data.slice(k, k + shortLength - eccLength + (i < shortBlocks ? 0 : 1));
    k += block.length;
    const ecc = rsRemainder(block, divisor);
    if (i < shortBlocks) block.push(0);
    blocks.push(block.concat(ecc));
  }
  const codewords: number[] = [];
  for (let i = 0; i < blocks[0]!.length; i++) {
    blocks.forEach((block, j) => { if (i !== shortLength - eccLength || j >= shortBlocks) codewords.push(block[i]!); });
  }

  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fixed = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => { modules[y]![x] = dark; fixed[y]![x] = true; };

  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, distance = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, distance !== 2 && distance !== 4);
    }
  }
  const align = alignmentPositions(version);
  align.forEach((ay, i) => align.forEach((ax, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) return;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }));
  const drawFormat = (mask: number) => {
    const value = (FORMAT_BITS_M << 3) | mask;
    let remainder = value;
    for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
    const format = ((value << 10) | remainder) ^ 0x5412;
    const bit = (i: number) => ((format >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) set(8, i, bit(i));
    set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (version >= 7) {
    let remainder = version;
    for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
    const value = (version << 12) | remainder;
    for (let i = 0; i < 18; i++) {
      const dark = ((value >>> i) & 1) !== 0, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, dark); set(b, a, dark);
    }
  }

  // Place the codewords in the zigzag order.
  for (let right = size - 1, i = 0; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vertical : vertical;
        if (!fixed[y]![x] && i < codewords.length * 8) {
          modules[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
          i++;
        }
      }
    }
  }

  const masked = (mask: number) => modules.map((row, y) => row.map((dark, x) => {
    if (fixed[y]![x]) return dark;
    const flip = [
      (x + y) % 2 === 0, y % 2 === 0, x % 3 === 0, (x + y) % 3 === 0,
      (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, ((x * y) % 2) + ((x * y) % 3) === 0,
      (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ][mask]!;
    return dark !== flip;
  }));
  // Any mask is valid; a lower penalty only makes the code easier to scan.
  const penalty = (grid: boolean[][]) => {
    let score = 0, dark = 0;
    for (let a = 0; a < size; a++) {
      for (const line of [grid[a]!, grid.map((row) => row[a]!)]) {
        let run = 1;
        for (let b = 1; b <= size; b++) {
          if (b < size && line[b] === line[b - 1]) run++;
          else { if (run >= 5) score += run - 2; run = 1; }
        }
      }
      for (let b = 0; b < size; b++) {
        if (grid[a]![b]) dark++;
        if (a + 1 < size && b + 1 < size && grid[a]![b] === grid[a]![b + 1] && grid[a]![b] === grid[a + 1]![b] && grid[a]![b] === grid[a + 1]![b + 1]) score += 3;
      }
    }
    return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  };
  let best: boolean[][] = [], bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    drawFormat(mask);
    const grid = masked(mask);
    const score = penalty(grid);
    if (score < bestScore) { best = grid; bestScore = score; }
  }
  return best;
}

/** SVG path data for the dark modules, offset by a 4-module quiet zone. */
export function qrSvgPath(matrix: boolean[][]): string {
  const parts: string[] = [];
  matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) parts.push(`M${x + 4} ${y + 4}h1v1h-1z`); }));
  return parts.join("");
}
