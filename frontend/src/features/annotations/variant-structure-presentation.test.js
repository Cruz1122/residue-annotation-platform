import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCompareStructureSources,
  distinctStructureOptions,
  parseVariantStructureArchive,
} from './variant-structure-presentation.js';

const encoder = new TextEncoder();

test('does not offer the structure selected by the other comparison panel', () => {
  const options = [
    { value: 'reference', label: 'Original' },
    { value: 'structure:E21K', label: 'E21K' },
    { value: 'structure:R43C', label: 'R43C' },
  ];
  assert.deepEqual(
    distinctStructureOptions(options, 'reference', 'reference').map((option) => option.value),
    ['reference', 'structure:E21K', 'structure:R43C'],
  );
  assert.deepEqual(
    distinctStructureOptions(options, 'structure:E21K', 'structure:E21K').map((option) => option.value),
    ['reference', 'structure:E21K', 'structure:R43C'],
  );
  assert.equal(canCompareStructureSources({ key: 'reference' }, { key: 'reference' }), false);
  assert.equal(canCompareStructureSources({ key: 'reference' }, { key: 'structure:E21K' }), true);
});

function writeField(target, offset, length, value) {
  const bytes = encoder.encode(String(value));
  target.set(bytes.subarray(0, length), offset);
}

function tarHeader(name, size, type = '0') {
  const header = new Uint8Array(512);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, '0000600');
  writeField(header, 108, 8, '0000000');
  writeField(header, 116, 8, '0000000');
  writeField(header, 124, 12, `${size.toString(8).padStart(11, '0')} `);
  writeField(header, 136, 12, '00000000000 ');
  writeField(header, 148, 8, '        ');
  writeField(header, 156, 1, type);
  writeField(header, 257, 6, 'ustar');
  writeField(header, 263, 2, '00');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function paxRecord(key, value) {
  const payload = `${key}=${value}\n`;
  const payloadLength = encoder.encode(payload).length;
  let length = payloadLength + 3;
  while (String(length).length + 1 + payloadLength !== length) {
    length = String(length).length + 1 + payloadLength;
  }
  return encoder.encode(`${length} ${payload}`);
}

function paddedBlock(bytes) {
  const blockCount = Math.max(1, Math.ceil(bytes.length / 512));
  const block = new Uint8Array(blockCount * 512);
  block.set(bytes);
  return block;
}

function concatBlocks(blocks) {
  const total = blocks.reduce((sum, block) => sum + block.length, 0) + 1024;
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    archive.set(block, offset);
    offset += block.length;
  }
  return archive.buffer;
}

function writeUint16(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

function concatBytes(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

async function zipArchive(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const content = encoder.encode(entry.content);
    const compressed = new Uint8Array(await new Response(
      new Blob([content]).stream().pipeThrough(new CompressionStream('deflate-raw')),
    ).arrayBuffer());
    const local = new Uint8Array(30 + name.length + compressed.length);
    writeUint32(local, 0, 0x04034b50);
    writeUint16(local, 4, 20);
    writeUint16(local, 6, 0x800);
    writeUint16(local, 8, 8);
    writeUint32(local, 18, compressed.length);
    writeUint32(local, 22, content.length);
    writeUint16(local, 26, name.length);
    local.set(name, 30);
    local.set(compressed, 30 + name.length);
    localParts.push(local);

    const central = new Uint8Array(46 + name.length);
    writeUint32(central, 0, 0x02014b50);
    writeUint16(central, 4, 20);
    writeUint16(central, 6, 20);
    writeUint16(central, 8, 0x800);
    writeUint16(central, 10, 8);
    writeUint32(central, 20, compressed.length);
    writeUint32(central, 24, content.length);
    writeUint16(central, 28, name.length);
    writeUint32(central, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length;
  }
  const localBytes = concatBytes(localParts);
  const centralBytes = concatBytes(centralParts);
  const end = new Uint8Array(22);
  writeUint32(end, 0, 0x06054b50);
  writeUint16(end, 8, entries.length);
  writeUint16(end, 10, entries.length);
  writeUint32(end, 12, centralBytes.length);
  writeUint32(end, 16, localBytes.length);
  return concatBytes([localBytes, centralBytes, end]).buffer;
}

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = encoder.encode(entry.content);
    if (entry.paxPath) {
      const pax = paxRecord('path', entry.paxPath);
      blocks.push(tarHeader('PaxHeader', pax.length, 'x'), paddedBlock(pax));
    }
    blocks.push(tarHeader(entry.name, data.length), paddedBlock(data));
  }
  return concatBlocks(blocks);
}

test('extracts one published structure per requested variant from a PAX TAR legacy archive', async () => {
  const archive = tarArchive([
    { name: 'rosetta/replicate-2.pdb', paxPath: 'rosetta/E21K/replicate-2.pdb', content: 'ATOM E21K 2' },
    { name: 'rosetta/replicate-1.pdb', paxPath: 'rosetta/E21K/replicate-1.pdb', content: 'ATOM E21K 1' },
    { name: 'rosetta/R43C/model.cif', content: 'data_R43C' },
    { name: 'rosetta/F402L/model.pdb', content: 'ATOM not-requested' },
    { name: '../E21K/unsafe.pdb', content: 'ATOM unsafe' },
  ]);

  const members = parseVariantStructureArchive(archive, [{ variant_id: 'E21K' }, { variant_id: 'R43C' }]);

  assert.deepEqual(members.map((member) => ({ variantKey: member.variantKey, path: member.path, format: member.format })), [
    { variantKey: 'E21K', path: 'rosetta/E21K/replicate-1.pdb', format: 'pdb' },
    { variantKey: 'R43C', path: 'rosetta/R43C/model.cif', format: 'mmcif' },
  ]);
  assert.equal(await members[0].blob.text(), 'ATOM E21K 1');
  assert.equal(await members[1].blob.text(), 'data_R43C');
});

test('does not treat missing, unsafe, or unrelated archive members as variants', () => {
  const archive = tarArchive([
    { name: 'rosetta/README.txt', content: 'not a structure' },
    { name: 'rosetta/../E21K/model.pdb', content: 'unsafe path' },
    { name: 'rosetta/unknown/model.pdb', content: 'unknown variant' },
  ]);

  assert.deepEqual(parseVariantStructureArchive(archive, [{ variant_id: 'E21K' }]), []);
});

test('extracts structures from the bounded deflated ZIP published by the backend', async () => {
  const archive = await zipArchive([
    { name: 'rosetta/', content: '' },
    { name: 'rosetta/E21K/model.pdb', content: 'ATOM E21K' },
    { name: 'rosetta/R43C/model.cif', content: 'data_R43C' },
    { name: 'rosetta/F402L/model.pdb', content: 'ATOM not-requested' },
    { name: '../E21K/unsafe.pdb', content: 'ATOM unsafe' },
  ]);

  const members = await parseVariantStructureArchive(
    archive,
    [{ variant_id: 'E21K' }, { variant_id: 'R43C' }],
  );

  assert.deepEqual(members.map((member) => ({ variantKey: member.variantKey, path: member.path, format: member.format })), [
    { variantKey: 'E21K', path: 'rosetta/E21K/model.pdb', format: 'pdb' },
    { variantKey: 'R43C', path: 'rosetta/R43C/model.cif', format: 'mmcif' },
  ]);
  assert.equal(await members[0].blob.text(), 'ATOM E21K');
  assert.equal(await members[1].blob.text(), 'data_R43C');
});
