/**
 * 字体文件元数据读取（只读 TTF/OTF 的二进制表头，不依赖第三方库）。
 *
 * 用途：验证自带字体到底是**静态字重**还是**可变字体**，以及它的默认字重。
 * 这不是洁癖——resvg 不支持可变字体的 wght 轴，一个默认实例为 Thin 的
 * 可变字体会让整张图变成极细体（看起来像「模糊」），而不会报任何错。
 * 因此构建后有必要校验字体文件的字重，见 tests/render-weight.test.ts。
 */

/** 读取 sfnt 表目录，返回 tag → { offset, length }。 */
function readTables(buffer: Buffer): Map<string, { offset: number; length: number }> {
  if (buffer.length < 12) throw new Error('字体文件过小，不是合法 sfnt');
  const signature = buffer.readUInt32BE(0);
  // 0x00010000 = TrueType, 'OTTO' = CFF, 'ttcf' = 字体集合, 'true' = Apple TrueType
  if (signature !== 0x00010000 && signature !== 0x4f54544f && signature !== 0x74727565) {
    throw new Error(`不认识的字体签名 0x${signature.toString(16)}`);
  }

  const numTables = buffer.readUInt16BE(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > buffer.length) break;
    const tag = buffer.toString('ascii', record, record + 4);
    tables.set(tag, {
      offset: buffer.readUInt32BE(record + 8),
      length: buffer.readUInt32BE(record + 12),
    });
  }
  return tables;
}

export interface FontMeta {
  /** OS/2.usWeightClass：静态字体的实际字重（100 Thin … 400 Regular … 700 Bold） */
  weightClass: number;
  /** 是否为可变字体（带 fvar 表）。resvg 会忽略其 wght 轴。 */
  isVariable: boolean;
  /** 可变字体的 wght 轴默认值；非可变字体时为 null */
  variableDefaultWeight: number | null;
  /** name 表里的 family（nameID 1），取 Windows 平台记录 */
  family: string | null;
}

/** 解析字体元数据；文件损坏或不支持时抛异常。 */
export function readFontMeta(buffer: Buffer): FontMeta {
  const tables = readTables(buffer);

  const os2 = tables.get('OS/2');
  if (!os2) throw new Error('缺少 OS/2 表，无法确定字重');
  const weightClass = buffer.readUInt16BE(os2.offset + 4);

  let isVariable = false;
  let variableDefaultWeight: number | null = null;
  const fvar = tables.get('fvar');
  if (fvar) {
    isVariable = true;
    const axesArrayOffset = buffer.readUInt16BE(fvar.offset + 4);
    const axisCount = buffer.readUInt16BE(fvar.offset + 8);
    const axisSize = buffer.readUInt16BE(fvar.offset + 10);
    for (let i = 0; i < axisCount; i += 1) {
      const axis = fvar.offset + axesArrayOffset + i * axisSize;
      if (buffer.toString('ascii', axis, axis + 4) !== 'wght') continue;
      // Fixed 16.16
      variableDefaultWeight = buffer.readInt32BE(axis + 8) / 65536;
      break;
    }
  }

  let family: string | null = null;
  const name = tables.get('name');
  if (name) {
    const count = buffer.readUInt16BE(name.offset + 2);
    const stringOffset = buffer.readUInt16BE(name.offset + 4);
    for (let i = 0; i < count; i += 1) {
      const record = name.offset + 6 + i * 12;
      const platform = buffer.readUInt16BE(record);
      const nameId = buffer.readUInt16BE(record + 6);
      if (nameId !== 1 || platform !== 3) continue;
      const length = buffer.readUInt16BE(record + 8);
      const offset = buffer.readUInt16BE(record + 10);
      const raw = buffer.subarray(name.offset + stringOffset + offset, name.offset + stringOffset + offset + length);
      family = raw.swap16().toString('utf16le');
      break;
    }
  }

  return { weightClass, isVariable, variableDefaultWeight, family };
}
